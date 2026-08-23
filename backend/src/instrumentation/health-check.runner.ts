import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { decideAlerts } from './alert-policy';
import { DiscordAlerter } from './discord-alerter';
import { HEALTH_CHECKS, type HealthCheck } from './health-check.contract';
import {
  HealthCheckStore,
  type HealthCheckObservation,
} from './health-check.store';
import type { HealthCheckStatus } from './health-check.types';

/** Matches the default documented in `.env.example`. */
const DEFAULT_REALERT_HOURS = 24;
const MS_PER_HOUR = 3_600_000;

/** What one cycle did. Returned for logging, and for the S7.1 `health` module. */
export interface HealthCheckRunSummary {
  startedAt: Date;
  finishedAt: Date;
  /** False when a previous cycle was still running and this one stood down. */
  ran: boolean;
  observations: number;
  byStatus: Record<HealthCheckStatus, number>;
  announced: number;
  recovered: number;
  lostSignal: number;
  suppressed: number;
  /** Rows whose notification actually reached Discord and were stamped. */
  alerted: number;
}

/**
 * Runs every registered check, persists the verdicts and announces what matters
 * (story S6.3, spec §6.1, ADR-006).
 *
 * This is the piece that turns a pile of parts into the thing the epic promised:
 * the checks measure, the store remembers, the policy decides and the alerter
 * speaks — but nothing happens until something drives them in the right order.
 *
 * ## Order is the whole design
 *
 * The previous status of every check must be read **before** the new verdicts are
 * inserted. `HealthCheckStore.latestAll()` returns the newest row per check, so
 * reading it after the insert would return the rows this cycle just wrote and
 * every check would look unchanged — no transition would ever be detected, and
 * the system would go permanently quiet while appearing to work. That is the
 * ADR-006 failure with extra steps, so the ordering is load-bearing rather than
 * incidental.
 *
 * `markAlerted` runs **last**, and only over the ids the alerter says it
 * delivered. A row stamped before the webhook succeeded would suppress its own
 * retry and lose the alert for good.
 */
@Injectable()
export class HealthCheckRunner {
  private readonly logger = new Logger(HealthCheckRunner.name);
  private readonly reAlertAfterMs: number;

  /**
   * Guards against overlapping cycles.
   *
   * The scheduler fires on a fixed interval, but a cycle's duration depends on a
   * remote Plan that may be slow. Two cycles in flight would double-insert
   * verdicts and could double-announce, so a late cycle stands down instead of
   * queueing — the next tick covers it, and a skipped tick is visible in the log.
   */
  private running = false;

  constructor(
    private readonly store: HealthCheckStore,
    private readonly alerter: DiscordAlerter,
    config: ConfigService,
    @Inject(HEALTH_CHECKS) private readonly checks: readonly HealthCheck[],
  ) {
    const hours =
      config.get<number>('HEALTH_ALERT_REALERT_HOURS') ?? DEFAULT_REALERT_HOURS;
    this.reAlertAfterMs = hours * MS_PER_HOUR;
  }

  async runAll(): Promise<HealthCheckRunSummary> {
    const startedAt = new Date();

    if (this.running) {
      this.logger.warn(
        'Ciclo anterior ainda em andamento — este tick foi pulado. ' +
          'Se repetir, o Plan esta lento ou o intervalo esta curto demais.',
      );
      return emptySummary(startedAt, false);
    }

    this.running = true;
    try {
      return await this.cycle(startedAt);
    } finally {
      // `finally`, not the end of the happy path: an exception that escaped
      // would otherwise leave the flag stuck and silence every future cycle.
      this.running = false;
    }
  }

  private async cycle(startedAt: Date): Promise<HealthCheckRunSummary> {
    // 1. Snapshot the "before" picture. Must precede the insert — see the class
    //    doc; reading it afterwards makes every check look unchanged forever.
    const previous = await this.store.latestAll();
    const previousStatus = new Map(
      previous.map((record) => [record.checkName, record.status]),
    );

    // 2. Run the checks. One failing check must never silence the other six.
    const observations = await this.runChecks();

    if (observations.length === 0) {
      this.logger.warn('Nenhum check produziu observacao neste ciclo');
      return emptySummary(startedAt, true);
    }

    // 3. Persist before deciding, so the alert always references a stored row.
    const records = await this.store.record(observations);

    // 4. `lastAlertAt` is per check and cannot come from `latestAll`: that gives
    //    the newest row's `alerted_at`, not the newest row that *has* one.
    const names = [...new Set(records.map((record) => record.checkName))];
    const lastAlertAt = new Map(
      await Promise.all(
        names.map(
          async (name) =>
            [name, await this.store.lastAlertAt(name)] as [string, Date | null],
        ),
      ),
    );

    const decision = decideAlerts({
      observations: records,
      previousStatus,
      lastAlertAt,
      now: new Date(),
      reAlertAfterMs: this.reAlertAfterMs,
    });

    // 5. Publish, then stamp only what was actually delivered.
    const delivered = await this.alerter.publish(decision);
    const alerted = await this.store.markAlerted(delivered);

    const summary: HealthCheckRunSummary = {
      startedAt,
      finishedAt: new Date(),
      ran: true,
      observations: records.length,
      byStatus: tally(records.map((record) => record.status)),
      announced: decision.announce.length,
      recovered: decision.recovered.length,
      lostSignal: decision.lostSignal.length,
      suppressed: decision.suppressed.length,
      alerted,
    };

    this.log(summary);
    return summary;
  }

  /**
   * Execute every check, converting a thrown error into an `error` observation.
   *
   * Sequential rather than parallel, deliberately: the checks share one remote
   * Plan on the game VPS, and hammering it with seven concurrent requests is the
   * "query pesada afeta o jogo" risk from spec §8. Seven short requests in series
   * cost a couple of seconds on a schedule measured in minutes.
   */
  private async runChecks(): Promise<HealthCheckObservation[]> {
    const observations: HealthCheckObservation[] = [];

    for (const check of this.checks) {
      try {
        observations.push(...(await check.run()));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.error(`Check ${check.name} lancou excecao: ${reason}`);
        // Becomes a notifiable `error` verdict rather than a gap in the record.
        // A check that vanishes from the history is indistinguishable from one
        // that never existed, which is precisely the blindness of ADR-006.
        observations.push({
          checkName: check.name,
          status: 'error',
          detail: {
            summary: `Check lancou excecao: ${reason}`,
            context: { check: check.name },
          },
        });
      }
    }

    return observations;
  }

  private log(summary: HealthCheckRunSummary): void {
    const elapsed = summary.finishedAt.getTime() - summary.startedAt.getTime();
    const parts = [
      `${summary.observations} observacao(oes) em ${elapsed}ms`,
      `ok=${summary.byStatus.ok}`,
      `breached=${summary.byStatus.breached}`,
      `no_data=${summary.byStatus.no_data}`,
      `error=${summary.byStatus.error}`,
      `anunciados=${summary.announced}`,
      `entregues=${summary.alerted}`,
    ];

    const failing = summary.byStatus.breached + summary.byStatus.error;
    const line = `Ciclo de saude: ${parts.join(' · ')}`;

    if (failing > 0) {
      this.logger.warn(line);
    } else {
      this.logger.log(line);
    }
  }
}

function tally(
  statuses: readonly HealthCheckStatus[],
): Record<HealthCheckStatus, number> {
  const counts: Record<HealthCheckStatus, number> = {
    ok: 0,
    breached: 0,
    no_data: 0,
    error: 0,
  };
  for (const status of statuses) {
    counts[status] += 1;
  }
  return counts;
}

function emptySummary(startedAt: Date, ran: boolean): HealthCheckRunSummary {
  return {
    startedAt,
    finishedAt: new Date(),
    ran,
    observations: 0,
    byStatus: { ok: 0, breached: 0, no_data: 0, error: 0 },
    announced: 0,
    recovered: 0,
    lostSignal: 0,
    suppressed: 0,
    alerted: 0,
  };
}
