import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { decideAlerts } from './alert-policy';
import { DiscordAlerter } from './discord-alerter';
import { HEALTH_CHECKS, type HealthCheck } from './health-check.contract';
import {
  HealthCheckStore,
  type HealthCheckObservation,
} from './health-check.store';
import type { HealthCheckStatus, LastAlert } from './health-check.types';

/** Matches the default documented in `.env.example`. */
const DEFAULT_REALERT_HOURS = 24;
/**
 * Consecutive healthy verdicts a recovery needs before it is announced.
 *
 * Two, at the default 15-minute cadence, means an all-clear arrives ~15 minutes
 * after it holds. That is the trade the production reading of 2026-08-26 paid
 * for: three messages in two hours about a ratio that never left its band. See
 * `AlertPolicyInput.confirmRecoveryAfter`.
 */
const DEFAULT_CONFIRM_RECOVERY = 2;
/**
 * Hard ceiling on messages per check per re-alert window.
 *
 * Loose on purpose: one real incident can want "quebrou", "piorou", "perdeu
 * sinal" and "normalizado" inside a day. A check that flaps burns this in an
 * hour, gets one `flapping` notice, and goes quiet until the window rolls.
 */
const DEFAULT_MAX_ALERTS_PER_WINDOW = 4;
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
  /**
   * Recoveries held back awaiting confirmation.
   *
   * Surfaced rather than buried in `suppressed` because it is the number to
   * watch if `HEALTH_ALERT_CONFIRM_RECOVERY` is ever tuned: a value that keeps
   * this permanently above zero is a value that never lets an all-clear out.
   */
  recoveryHeld: number;
  /** Checks that hit the message budget and were told so, once. */
  flapping: number;
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
 * `markAlerted` runs **last**, and only over the ids the alerter says it
 * delivered. A row stamped before the webhook succeeded would suppress its own
 * retry and lose the alert for good.
 *
 * Everything the policy compares against — `lastAlert` and `healthyStreak` — is
 * read **after** the insert, on purpose: both questions are about the state
 * including the verdict this cycle just produced. An earlier version compared
 * against the previous *row* and therefore had to read it before inserting, an
 * ordering whose inversion would have silenced the whole layer while it looked
 * healthy. Comparing against what the channel was last told removed that trap
 * rather than documenting it.
 */
@Injectable()
export class HealthCheckRunner {
  private readonly logger = new Logger(HealthCheckRunner.name);
  private readonly reAlertAfterMs: number;
  private readonly confirmRecoveryAfter: number;
  private readonly maxAlertsPerWindow: number;

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
    this.confirmRecoveryAfter =
      config.get<number>('HEALTH_ALERT_CONFIRM_RECOVERY') ??
      DEFAULT_CONFIRM_RECOVERY;
    this.maxAlertsPerWindow =
      config.get<number>('HEALTH_ALERT_MAX_PER_WINDOW') ??
      DEFAULT_MAX_ALERTS_PER_WINDOW;
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
    // 1. Run the checks. One failing check must never silence the others.
    const observations = await this.runChecks();

    if (observations.length === 0) {
      this.logger.warn('Nenhum check produziu observacao neste ciclo');
      return emptySummary(startedAt, true);
    }

    // 2. Persist before deciding, so the alert always references a stored row.
    const records = await this.store.record(observations);

    // 3. What the channel was last told, per check. It cannot come from
    //    `latestAll`: that gives the newest row's `alerted_at`, not the newest
    //    row that *has* one.
    const names = [...new Set(records.map((record) => record.checkName))];
    const lastAlert = new Map(
      await Promise.all(
        names.map(
          async (name) =>
            [name, await this.store.lastAlert(name)] as [
              string,
              LastAlert | null,
            ],
        ),
      ),
    );

    // 3b. How much each check has already said in this window, for the message
    //     budget. Counted from stamped rows, so it measures what the channel
    //     actually heard rather than what was decided.
    const alertsInWindow = new Map(
      await Promise.all(
        names.map(
          async (name) =>
            [
              name,
              await this.store.alertsInWindow(name, this.reAlertAfterMs),
            ] as [string, Map<HealthCheckStatus, number>],
        ),
      ),
    );

    // 4. The healthy streak includes the verdict just written, because "has it
    //    been ok for two cycles *including this one*" is the question asked.
    //    The window is the threshold itself: a streak that saturated below it
    //    could never satisfy it, and the all-clear would starve forever.
    const healthyStreak = new Map(
      await Promise.all(
        names.map(
          async (name) =>
            [
              name,
              await this.store.healthyStreak(name, this.confirmRecoveryAfter),
            ] as [string, number],
        ),
      ),
    );

    const decision = decideAlerts({
      observations: records,
      lastAlert,
      alertsInWindow,
      maxAlertsPerWindow: this.maxAlertsPerWindow,
      healthyStreak,
      confirmRecoveryAfter: this.confirmRecoveryAfter,
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
      flapping: decision.flapping.length,
      suppressed: decision.suppressed.length,
      recoveryHeld: decision.suppressed.filter(
        (item) => item.reason === 'recovery_unconfirmed',
      ).length,
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
    const seen = new Set<string>();

    /**
     * Append one observation, refusing a name already produced this cycle.
     *
     * Two rows sharing a `check_name` and a cycle are always a configuration
     * bug — a duplicated entry in `PLAN_SERVERS` is the way it happens — and
     * they corrupt three things at once: `latestAll` picks between them by
     * tiebreak, `healthyStreak` counts one cycle twice, and the alert budget
     * jumps by two, which can step straight over the point where the `flapping`
     * notice fires and mute a check with nothing ever said. Logged at error
     * level because the fix is in the environment, not here.
     */
    const add = (observation: HealthCheckObservation): void => {
      if (seen.has(observation.checkName)) {
        this.logger.error(
          `Check ${observation.checkName} produziu duas observacoes no mesmo ` +
            'ciclo — a segunda foi descartada. Provavel nome repetido em ' +
            'PLAN_SERVERS; corrija, porque isso corrompe o historico.',
        );
        return;
      }
      seen.add(observation.checkName);
      observations.push(observation);
    };

    for (const check of this.checks) {
      try {
        for (const observation of await check.run()) {
          add(observation);
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.error(`Check ${check.name} lancou excecao: ${reason}`);
        // Becomes a notifiable `error` verdict rather than a gap in the record.
        // A check that vanishes from the history is indistinguishable from one
        // that never existed, which is precisely the blindness of ADR-006.
        add({
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
      `recuperacoes_seguradas=${summary.recoveryHeld}`,
      `oscilando=${summary.flapping}`,
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
    flapping: 0,
    suppressed: 0,
    recoveryHeld: 0,
    alerted: 0,
  };
}
