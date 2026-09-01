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

    let record: WeeklyReportRecord;
    let title: string;
    let body: string;
    let failed = false;

    try {
      const report = await this.builder.build(to);
      body = renderWeeklyReport(report);
      title = `Relatorio semanal — ${from} a ${to}`;
      record = await this.store.recordSuccess({
        periodFrom: from,
        periodTo: to,
        payload: report,
        rendered: body,
      });
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
      record = await this.store.recordFailure({
        periodFrom: from,
        periodTo: to,
        detail,
        rendered: body,
      });
    }

    const delivered = failed
      ? await this.publisher.publishFailure(title, body)
      : await this.publisher.publish(title, body);

    if (delivered) {
      await this.store.markDelivered(record.id);
      return { ...record, delivered: true };
    }

    return record;
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
