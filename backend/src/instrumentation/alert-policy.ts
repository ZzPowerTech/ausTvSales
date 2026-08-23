import {
  NOTIFIABLE_STATUSES,
  type HealthCheckRecord,
  type HealthCheckStatus,
} from './health-check.types';

/** Why an observation that looked notifiable was not announced. */
export type SuppressionReason =
  /** Already announced recently and still in the same failing state. */
  | 'grouped'
  /** The status is not one that notifies. */
  | 'not_notifiable';

export interface SuppressedObservation {
  record: HealthCheckRecord;
  reason: SuppressionReason;
}

export interface AlertDecision {
  /** Failing observations that must reach Discord now. */
  announce: HealthCheckRecord[];
  /** Checks that just returned to `ok` after having been announced as failing. */
  recovered: HealthCheckRecord[];
  /** Notifiable observations deliberately held back, with the reason. */
  suppressed: SuppressedObservation[];
}

export interface AlertPolicyInput {
  /** Verdicts produced by the run that just finished. */
  observations: readonly HealthCheckRecord[];
  /** Status of each check *before* this run — absent means it never ran. */
  previousStatus: ReadonlyMap<string, HealthCheckStatus>;
  /** When each check was last announced — absent or null means never. */
  lastAlertAt: ReadonlyMap<string, Date | null>;
  now: Date;
  /**
   * How long a check must stay in the same failing state before it is announced
   * again. Guards against a three-month outage producing one message per cycle.
   */
  reAlertAfterMs: number;
}

/**
 * Decides which verdicts become a Discord message (story S6.3, spec §6.1).
 *
 * Pure and deterministic on purpose: this is the rule that decides whether the
 * team hears about an outage, and it must be testable without a webhook, a clock
 * or a database.
 *
 * The policy balances two failure modes that are equally bad. Alerting on every
 * cycle of a long outage trains the team to mute the channel, which reproduces
 * ADR-006's silence with extra noise. Alerting only on the transition means a
 * message missed on a busy day is a message lost forever. So: announce on entry
 * into a failing state, then repeat at most once per `reAlertAfterMs`.
 *
 * A check moving from one failing state to another (`breached` → `error`) is
 * treated as a new event: "the tutorial rate is low" and "we cannot reach the
 * Plan at all" are different problems and the second must not hide behind the
 * first.
 */
export function decideAlerts(input: AlertPolicyInput): AlertDecision {
  const announce: HealthCheckRecord[] = [];
  const recovered: HealthCheckRecord[] = [];
  const suppressed: SuppressedObservation[] = [];

  for (const record of input.observations) {
    const previous = input.previousStatus.get(record.checkName);

    if (!isNotifiable(record.status)) {
      if (wasAnnouncedFailure(previous, input.lastAlertAt, record.checkName)) {
        // Closing the loop matters: without it, the only way to learn that an
        // outage ended is to go look, which is the habit this epic removes.
        recovered.push(record);
      } else {
        suppressed.push({ record, reason: 'not_notifiable' });
      }
      continue;
    }

    if (previous !== record.status) {
      // Entered a failing state, or moved to a different one.
      announce.push(record);
      continue;
    }

    const last = input.lastAlertAt.get(record.checkName) ?? null;
    if (last === null) {
      // Still failing, but the previous failure was never actually delivered —
      // a webhook outage, most likely. Retry rather than stay quiet.
      announce.push(record);
      continue;
    }

    const elapsed = input.now.getTime() - last.getTime();
    if (elapsed >= input.reAlertAfterMs) {
      announce.push(record);
    } else {
      suppressed.push({ record, reason: 'grouped' });
    }
  }

  return { announce, recovered, suppressed };
}

function isNotifiable(status: HealthCheckStatus): boolean {
  return NOTIFIABLE_STATUSES.includes(status);
}

/**
 * True when the check was in a failing state that had actually been announced.
 *
 * Both halves are required. Without the previous status we would announce a
 * "recovery" for a check that has always been healthy; without the delivered
 * alert we would announce the recovery of a failure nobody ever heard about.
 */
function wasAnnouncedFailure(
  previous: HealthCheckStatus | undefined,
  lastAlertAt: ReadonlyMap<string, Date | null>,
  checkName: string,
): boolean {
  return (
    previous !== undefined &&
    isNotifiable(previous) &&
    (lastAlertAt.get(checkName) ?? null) !== null
  );
}
