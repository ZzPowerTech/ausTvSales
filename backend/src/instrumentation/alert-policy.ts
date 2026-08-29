import type { HealthCheckRecord, LastAlert } from './health-check.types';

/** Why an observation that could have notified was not announced. */
export type SuppressionReason =
  /** Already announced recently and still in the same state. */
  | 'grouped'
  /** Nothing to say: healthy, and the channel is not holding an open problem. */
  | 'not_notifiable'
  /**
   * Healthy again, but not for long enough to be believed.
   *
   * Distinct from `not_notifiable`, and the distinction is the point: this
   * observation **would** have been announced as a recovery under the old rule.
   * Folding it into the generic bucket would hide how often the layer is
   * holding an all-clear back, which is the number to watch if
   * `confirmRecoveryAfter` is ever tuned.
   */
  | 'recovery_unconfirmed';

export interface SuppressedObservation {
  record: HealthCheckRecord;
  reason: SuppressionReason;
}

export interface AlertDecision {
  /** Failing observations that must reach Discord now. */
  announce: HealthCheckRecord[];
  /** Checks that returned to `ok` after an announced problem, and stayed. */
  recovered: HealthCheckRecord[];
  /**
   * Checks that stopped producing data after an announced failure.
   *
   * Split out of {@link recovered} deliberately. `no_data` is not a recovery: it
   * means the check went from "measured and broken" to "cannot be measured at
   * all", which is strictly worse. Folding the two together made the alerter
   * paint a green "normalizado" banner over a loss of signal — the precise
   * failure ADR-006 exists to prevent, and a direct violation of the project
   * rule that a collection gap is never rendered as a healthy value.
   */
  lostSignal: HealthCheckRecord[];
  /** Observations deliberately held back, with the reason. */
  suppressed: SuppressedObservation[];
}

export interface AlertPolicyInput {
  /** Verdicts produced by the run that just finished. */
  observations: readonly HealthCheckRecord[];
  /**
   * What the channel was last told about each check — absent or null means it
   * has never been told anything.
   *
   * This, and **not** the previous row of `health_checks`, is the state the
   * policy compares against. See the function doc for why the difference is the
   * whole fix.
   */
  lastAlert: ReadonlyMap<string, LastAlert | null>;
  now: Date;
  /**
   * How long a check must stay in the same announced state before it is
   * repeated. Guards against a three-month outage producing one message per
   * cycle.
   */
  reAlertAfterMs: number;
  /**
   * Consecutive healthy verdicts, per check, ending at the newest one.
   *
   * From `HealthCheckStore.healthyStreak()`. Absent means the check has no
   * healthy streak to speak of.
   */
  healthyStreak: ReadonlyMap<string, number>;
  /**
   * How many consecutive healthy verdicts a recovery needs before it is
   * announced.
   *
   * ## The reading that made this necessary
   *
   * Production, 2026-08-26. `platform.offline_account_share` produced three
   * Discord messages in under two hours:
   *
   * | hora | valor | conta | veredito |
   * |---|---|---|---|
   * | 19:39 | 51,5% | 17/33 | breached — anunciado |
   * | 19:54 | 50,0% | 16/32 | ok — **"normalizado" anunciado** |
   * | 21:24 | 51,6% | 16/31 | breached — anunciado |
   *
   * Nothing changed on the server. With ~32 arrivals in the window a **single
   * player** moves the ratio by three points, and the threshold sat exactly on
   * the data. The check was reporting sampling noise as a state change, and the
   * channel was being taught that its messages mean nothing — which is
   * ADR-006's silence arriving as noise instead.
   *
   * A failure is still announced on the **first** observation: a real outage
   * must not wait. Only the *recovery* is confirmed, because an all-clear that
   * turns out to be wrong is worse than one that arrives a cycle late.
   *
   * At the default cadence of 15 minutes, 2 means a recovery is announced ~15
   * minutes after it holds.
   */
  confirmRecoveryAfter: number;
}

/**
 * Decides which verdicts become a Discord message (story S6.3, spec §6.1).
 *
 * Pure and deterministic on purpose: this is the rule that decides whether the
 * team hears about an outage, and it must be testable without a webhook, a clock
 * or a database.
 *
 * ## The state that matters is the channel's, not the table's
 *
 * The obvious implementation compares each verdict against the previous row of
 * `health_checks` and announces on every change. That is what shipped, and the
 * production reading of 2026-08-26 showed what it costs: with the recovery held
 * back by {@link AlertPolicyInput.confirmRecoveryAfter}, the *next* breach still
 * looked like a fresh transition (`ok` row → `breached` row) and was announced
 * again. Half the flap survives a hysteresis applied to recoveries alone.
 *
 * So the comparison is against {@link AlertPolicyInput.lastAlert}: the last
 * verdict that actually reached the channel. A breach announced at 19:39 and a
 * breach observed at 21:24 with no all-clear in between are, to everyone reading
 * the channel, **the same open incident** — and repeating it is governed by
 * `reAlertAfterMs` like any other ongoing failure. That single change collapses
 * the three-message flap into one message.
 *
 * It also removes a hazard rather than adding one: the runner no longer has to
 * read the previous state *before* inserting the new rows, an ordering whose
 * inversion would have silenced the whole layer while looking healthy.
 *
 * ## The rest of the rules
 *
 * Alerting on every cycle of a long outage trains the team to mute the channel,
 * which reproduces ADR-006's silence with extra noise. Alerting only on the
 * transition means a message missed on a busy day is a message lost forever. So:
 * announce on entry into a failing state, then repeat at most once per
 * `reAlertAfterMs`.
 *
 * A check moving from one failing state to another (`breached` → `error`) is
 * announced as a new event: "the tutorial rate is low" and "we cannot reach the
 * Plan at all" are different problems and the second must not hide behind the
 * first. A check that oscillates *between* those two therefore still speaks
 * every cycle — deliberately, because a source flipping between broken and
 * unreachable is itself news.
 */
export function decideAlerts(input: AlertPolicyInput): AlertDecision {
  const announce: HealthCheckRecord[] = [];
  const recovered: HealthCheckRecord[] = [];
  const lostSignal: HealthCheckRecord[] = [];
  const suppressed: SuppressedObservation[] = [];

  for (const record of input.observations) {
    const last = input.lastAlert.get(record.checkName) ?? null;
    /** The channel is holding an unresolved problem about this check. */
    const open: LastAlert | null =
      last !== null && last.status !== 'ok' ? last : null;

    /**
     * Repeat of an identical announced state: say it again only once the
     * re-alert window has elapsed.
     */
    const repeat = (since: LastAlert, bucket: HealthCheckRecord[]): void => {
      if (input.now.getTime() - since.at.getTime() >= input.reAlertAfterMs) {
        bucket.push(record);
      } else {
        suppressed.push({ record, reason: 'grouped' });
      }
    };

    if (record.status === 'ok') {
      if (open === null) {
        // Healthy, and nothing outstanding. The overwhelmingly common case.
        suppressed.push({ record, reason: 'not_notifiable' });
      } else if (
        (input.healthyStreak.get(record.checkName) ?? 0) >=
        input.confirmRecoveryAfter
      ) {
        // Closing the loop matters: without it, the only way to learn that an
        // outage ended is to go look, which is the habit this epic removes.
        recovered.push(record);
      } else {
        // Healthy, but not for long enough to be believed yet. Held rather than
        // announced — see `confirmRecoveryAfter` for the reading behind it.
        suppressed.push({ record, reason: 'recovery_unconfirmed' });
      }
      continue;
    }

    if (record.status === 'no_data') {
      if (open === null) {
        // "Sem dados" is not a failure on its own: a ratio without a base is
        // not a low number, it is an unmeasured one. Alerting here is noise.
        suppressed.push({ record, reason: 'not_notifiable' });
      } else if (open.status === 'no_data') {
        repeat(open, lostSignal);
      } else {
        // The check did not get better — we stopped being able to see it.
        // Announcing "normalizado" here would be a false all-clear.
        lostSignal.push(record);
      }
      continue;
    }

    // `breached` or `error`.
    if (open === null || open.status !== record.status) {
      // Never announced, newly failing, a different failure, or failing again
      // after an all-clear the channel actually received.
      announce.push(record);
    } else {
      repeat(open, announce);
    }
  }

  return { announce, recovered, lostSignal, suppressed };
}
