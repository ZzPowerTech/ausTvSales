import { Injectable, Logger } from '@nestjs/common';
import { PlanApiClient } from '../instrumentation/plan-api.client';
import { platformOf } from '../instrumentation/platform';
import { parseRetention } from '../retention/plan-retention';
import {
  PlayerDimensionStore,
  type DimensionRow,
} from './player-dimension.store';

/** The single endpoint this ETL reads. */
const RETENTION_PATH = '/v1/retention';

/**
 * How far the payload may shrink before the run refuses to write.
 *
 * 0.5 means "half the rows the last successful run saw". The rule exists
 * because the failure this ETL has to survive is not an exception — it is a
 * **successful** response carrying a fraction of the population, which upserts
 * cleanly and leaves cohort denominators quietly wrong for a month.
 *
 * Unlike the tutorial ETL, this one never deletes, so a shrunken payload cannot
 * erase anything. What it can do is overwrite `last_seen_at` and `platform` for
 * the rows it does carry while leaving the rest frozen — a half-refreshed
 * dimension, which is worse to reason about than a stale one.
 */
const MIN_SHARE_OF_PREVIOUS = 0.5;

/**
 * Fills the `player` dimension of ADR-008 from `/v1/retention` (story S9.1).
 *
 * ## Why an ETL and not a live read
 *
 * ADR-008 is explicit: *"o PostgreSQL do `ausTvSales` é o único lugar onde dados
 * de fontes diferentes se cruzam. Nada de correlação em memória entre resultados
 * de dois bancos ao vivo."* Sales are here, registration dates are behind an
 * HTTP API on the game VPS, and the economy questions are joins between them. So
 * the dates have to land here first.
 *
 * ## Why `/v1/retention` and not the MySQL of the Plan
 *
 * Because the endpoint answers, and exception 1 of ADR-002 does not need to be
 * opened for it — the same reading that unblocked story S8.2 on 2026-08-29. This
 * ETL adds **no new credential** to the deployment.
 *
 * ## Idempotent, and re-running is the normal operation
 *
 * Upsert keyed by uuid. The payload is current state, not an event log, so every
 * run rewrites what it covers and nothing accumulates. Criterion 2 of the story
 * asks for exactly this.
 *
 * ## The timing is recorded, because the DoD asks for it
 *
 * The S9 Definition of Done wants timings attached to a PR proving the ETL costs
 * the game nothing. This run measures itself and stores the number, so the first
 * real execution produces that evidence instead of someone having to reproduce
 * it by hand. Note what it covers: **one HTTP request to the Plan webserver**,
 * which runs inside the Minecraft process — that is the whole contact surface
 * with the game machine, and it is one request per night.
 */
@Injectable()
export class PlayerDimensionSyncService {
  private readonly logger = new Logger(PlayerDimensionSyncService.name);

  constructor(
    private readonly plan: PlanApiClient,
    private readonly store: PlayerDimensionStore,
  ) {}

  /** False when `PLAN_BASE_URL` is unset — the run records `error`, not zero. */
  get configured(): boolean {
    return this.plan.configured;
  }

  /**
   * One run.
   *
   * Never throws: every failure becomes an `error` row plus a log line, so the
   * scheduler survives and the reason is on record. The previous dimension stays
   * exactly as it was.
   */
  async sync(): Promise<{ status: 'ok' | 'error'; detail?: string }> {
    const startedAt = Date.now();

    if (!this.configured) {
      return this.fail(
        startedAt,
        'PLAN_BASE_URL nao configurada — a dimensao de jogador nao pode ser ' +
          'preenchida, e toda leitura por coorte vai reportar `never_synced`.',
      );
    }

    let body: unknown;
    try {
      body = await this.plan.getJson(RETENTION_PATH);
    } catch (error) {
      return this.fail(
        startedAt,
        'Nao foi possivel ler o /v1/retention do Plan. Detalhe tecnico no log.',
        error,
      );
    }

    const parsed = parseRetention(body);
    if (!parsed.ok) {
      return this.fail(
        startedAt,
        `O contrato de ${RETENTION_PATH} mudou: ${parsed.reason}.`,
      );
    }

    const { players, rows, dropped } = parsed.value;

    const floor = await this.floorRefusal(rows);
    if (floor !== null) {
      return this.fail(startedAt, floor);
    }

    const dimension: DimensionRow[] = players.map((player) => ({
      uuid: player.uuid,
      platform: platformOf(player.uuid),
      registeredAt: new Date(player.registeredAt),
      lastSeenAt: new Date(player.lastSeenAt),
    }));

    let written: number;
    try {
      written = await this.store.upsert(dimension);
    } catch (error) {
      return this.fail(
        startedAt,
        'Falha ao gravar a dimensao de jogador no PostgreSQL. Detalhe no log.',
        error,
      );
    }

    const durationMs = Date.now() - startedAt;
    await this.store.recordSuccess({
      rowsRead: rows,
      rowsWritten: written,
      rowsDropped: dropped,
      durationMs,
    });

    this.logger.log(
      `Dimensao de jogador atualizada: ${written} linha(s) de ${rows} lidas ` +
        `(${dropped} descartada(s)) em ${durationMs}ms`,
    );

    return { status: 'ok' };
  }

  /**
   * Refuse the write when the payload is degenerate.
   *
   * Two rules, and the second is the one that matters. An empty payload is
   * obviously wrong. A payload at 30% of last night's is **not obviously
   * wrong** — it upserts without error, and the damage shows up a month later as
   * cohort denominators that nobody can reconcile.
   */
  private async floorRefusal(rows: number): Promise<string | null> {
    if (rows === 0) {
      return (
        'O /v1/retention devolveu zero linhas. A dimensao anterior foi mantida ' +
        'intacta: uma populacao vazia e indistinguivel de uma resposta ' +
        'degradada, e gravar isso como fato apagaria toda leitura por coorte.'
      );
    }

    const previous = await this.store.lastSuccessfulSync();
    const before = previous?.rowsRead ?? 0;
    if (before > 0 && rows < before * MIN_SHARE_OF_PREVIOUS) {
      return (
        `O /v1/retention devolveu ${rows} linhas contra ${before} da ultima ` +
        `execucao bem-sucedida — menos de ${MIN_SHARE_OF_PREVIOUS * 100}% da ` +
        'populacao anterior. A dimensao anterior foi mantida: um payload ' +
        'parcial faz upsert sem erro nenhum e deixa metade das linhas ' +
        'congeladas ao lado de metade atualizadas, que e pior de raciocinar do ' +
        'que um dado velho inteiro.'
      );
    }

    return null;
  }

  private async fail(
    startedAt: number,
    detail: string,
    cause?: unknown,
  ): Promise<{ status: 'error'; detail: string }> {
    // The upstream message can name a host, a port or an account. It goes to the
    // log; the persisted detail is a sentence without topology (CWE-209).
    this.logger.error(
      cause === undefined ? detail : `${detail} — ${describe(cause)}`,
    );

    await this.store.recordFailure({
      detail,
      durationMs: Date.now() - startedAt,
    });

    return { status: 'error', detail };
  }
}

/**
 * A one-line description of an unknown throw, safe to log.
 *
 * `String(cause)` on a plain object renders `[object Object]`, which costs the
 * one line that was supposed to explain the failure. Anything that is not an
 * `Error` gets its JSON, or its type name when even that fails.
 */
function describe(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }
  try {
    return JSON.stringify(cause) ?? typeof cause;
  } catch {
    return typeof cause;
  }
}
