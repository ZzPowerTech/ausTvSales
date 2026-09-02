import { Injectable, Logger } from '@nestjs/common';
import { toSaoPauloDay } from '../tutorial/tutorial-day';
import { WeeklyReportBuilder, daysBefore } from './weekly-report.builder';
import { WeeklyReportPublisher } from './weekly-report.publisher';
import { WeeklyReportStore } from './weekly-report.store';
import { renderFailure, renderWeeklyReport } from './weekly-report.renderer';
import { WINDOW_DAYS } from './weekly-report.builder';
import type { WeeklyReportRecord } from './weekly-report.types';

/**
 * One weekly run: build, persist, deliver (story S9.2).
 *
 * ## The order is persist-then-deliver, and it is load-bearing
 *
 * A Discord outage must cost the message, not the content. Writing the row first
 * means a failed delivery leaves a stored report with `delivered: false`, which
 * is both recoverable and auditable; the reverse order would lose the reading
 * entirely for a webhook hiccup.
 *
 * ## A failed run is still a run
 *
 * If the build throws, this writes an `error` row **and posts a notice**. That
 * is criterion 3, and the reason it exists: *"um relatório semanal que
 * simplesmente para de chegar é indistinguível de uma semana sem novidade"*. A
 * job that fails silently is a new source of the exact blindness this epic was
 * built to remove.
 *
 * The one failure this class cannot announce is the scheduler never firing —
 * nothing inside a process that is not running can say so. That is why the
 * report body prints `schedule.enabled` every week, and why
 * `plan.collection_alive` and the rest keep watching from the other side.
 */
@Injectable()
export class WeeklyReportService {
  private readonly logger = new Logger(WeeklyReportService.name);

  constructor(
    private readonly builder: WeeklyReportBuilder,
    private readonly store: WeeklyReportStore,
    private readonly publisher: WeeklyReportPublisher,
  ) {}

  /**
   * Generate, persist and deliver one report.
   *
   * @param to last day of the window, inclusive. Defaults to **yesterday** —
   *   see {@link lastCompleteDay}.
   */
  async run(to: string = lastCompleteDay()): Promise<WeeklyReportRecord> {
    const from = daysBefore(to, WINDOW_DAYS - 1);

    let record: WeeklyReportRecord | null = null;
    let title: string;
    let body: string;
    let failed = false;

    try {
      const report = await this.builder.build(to);
      body = renderWeeklyReport(report);
      title = `Relatorio semanal — ${from} a ${to}`;
      record = await this.persist(() =>
        this.store.recordSuccess({
          periodFrom: from,
          periodTo: to,
          payload: report,
          rendered: body,
        }),
      );
    } catch (error) {
      failed = true;
      // The message can name a host or an account; it goes to the log. What
      // reaches the channel and the row is a short, non-topological sentence.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Relatorio semanal ${from}..${to} falhou ao ser montado: ${message}`,
      );

      const detail =
        'Falha ao montar o conteudo do relatorio. Detalhe tecnico no log da API.';
      body = renderFailure(from, to, detail);
      title = `Relatorio semanal NAO gerado — ${from} a ${to}`;
      record = await this.persist(() =>
        this.store.recordFailure({
          periodFrom: from,
          periodTo: to,
          detail,
          rendered: body,
        }),
      );
    }

    const delivered = failed
      ? await this.publisher.publishFailure(title, body)
      : await this.publisher.publish(title, body);

    if (record === null) {
      // Nothing was stored, and the channel has been told. Returning a synthetic
      // record rather than throwing keeps the scheduler's log line meaningful
      // and matches what actually happened: a run that produced a notice and no
      // row. A caller reading `id: null` cannot mistake it for a stored report.
      return {
        id: -1,
        generatedAt: new Date(),
        periodFrom: from,
        periodTo: to,
        status: 'error',
        payload: null,
        rendered: body,
        delivered,
        detail:
          'O relatorio nao pôde ser persistido. O aviso foi publicado no canal ' +
          'assim mesmo; nao existe linha em weekly_reports para esta execucao.',
      };
    }

    if (delivered) {
      await this.store
        .markDelivered(record.id)
        .catch((error: unknown) =>
          this.logStoreFailure('marcar entrega', error),
        );
      return { ...record, delivered: true };
    }

    return record;
  }

  /**
   * Write the row, or carry on without it.
   *
   * ## Why the persist has its own catch
   *
   * Trace what can actually make `builder.build()` throw: the funnel catches
   * every source failure and the retention module turns every failure into a
   * closed label. The one dependency that can reject is the health read model —
   * **our own Postgres**. So the only input that reaches the outer `catch` is a
   * Postgres failure, and with the persist unguarded that same failure made
   * `recordFailure` throw, so `publishFailure` was never called.
   *
   * The result was the story's headline failure mode reproduced by the module
   * built to prevent it: no row, no red embed, one log line — and a missing row
   * is *defined* in this module as "the scheduler never fired", which would have
   * been false.
   *
   * Criterion 3 says the channel gets told when the job fails. The channel is
   * the part that must not depend on the database being up.
   */
  private async persist(
    write: () => Promise<WeeklyReportRecord>,
  ): Promise<WeeklyReportRecord | null> {
    try {
      return await write();
    } catch (error) {
      this.logStoreFailure('persistir o relatorio', error);
      return null;
    }
  }

  private logStoreFailure(what: string, error: unknown): void {
    this.logger.error(
      `Falha ao ${what}: ${
        error instanceof Error ? error.message : String(error)
      }. O aviso ainda vai ao canal — e o canal e a parte que nao pode depender ` +
        'do banco estar de pe.',
    );
  }

  latest(): Promise<WeeklyReportRecord | null> {
    return this.store.latest();
  }

  byId(id: number): Promise<WeeklyReportRecord | null> {
    return this.store.byId(id);
  }

  recent(limit: number): Promise<WeeklyReportRecord[]> {
    return this.store.recent(limit);
  }
}

/**
 * Yesterday in America/Sao_Paulo.
 *
 * The window ends on the last **complete** day. Including today would make the
 * newest day structurally smaller than the other six, so every week-over-week
 * comparison would read as a decline — a number that is wrong in the same
 * direction every single time, which is the hardest kind to notice.
 */
export function lastCompleteDay(now: number = Date.now()): string {
  return daysBefore(toSaoPauloDay(now) ?? '1970-01-01', 1);
}
