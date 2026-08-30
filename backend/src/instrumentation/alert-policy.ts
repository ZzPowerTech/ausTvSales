import type {
  HealthCheckRecord,
  HealthCheckStatus,
  LastAlert,
} from './health-check.types';

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
  | 'recovery_unconfirmed'
  /**
   * The check already spent its message budget for this window.
   *
   * The last thing said before this reason starts appearing is the `flapping`
   * notice, so the channel knows the check went quiet on purpose. See
   * {@link AlertPolicyInput.maxAlertsPerWindow}.
   */
  | 'flapping';

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
  /**
   * Checks that just hit their message budget — one notice, then quiet.
   *
   * A cap without a notice is a silent mute, which is the failure this whole
   * layer exists to prevent. This bucket is that notice: it is emitted exactly
   * once, on the observation that crosses the budget, and it says the check is
   * changing state too often to be reported per event.
   */
  flapping: HealthCheckRecord[];
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
  /**
   * How many messages each check has already had delivered inside the current
   * `reAlertAfterMs`. From `HealthCheckStore.alertsInWindow()`.
   */
  alertsInWindow: ReadonlyMap<string, number>;
  /**
   * Hard ceiling on messages per check per `reAlertAfterMs`.
   *
   * The transition rules below bound the *common* oscillations, but they bound
   * them by reasoning about shapes, and a shape nobody thought of is exactly how
   * this layer got a three-message flap in production. This is the backstop that
   * does not depend on being clever: whatever the check does, it cannot exceed
   * this many messages in a window.
   *
   * It is deliberately loose. A real incident wants room for "broke", "got
   * worse", "lost signal" and "normalizado" inside one day; a flapping check
   * burns the budget in an hour and then says so once and stops.
   */
  maxAlertsPerWindow: number;
  /**
   * How long a check must stay in the same announced state before it is
   * repeated. Guards against a three-month outage producing one message per
   * cycle.
   *
   * Elapsed time is measured between `alerted_at` and the observation's own
   * `checked_at`, both stamped by Postgres. Comparing a database timestamp
   * against the application clock would reintroduce exactly the skew the store
   * avoids by not stamping `checked_at` itself.
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
 * breach observed at 21:24 with **no all-clear delivered in between** are, to
 * everyone reading the channel, the same open incident — and repeating it is
 * governed by `reAlertAfterMs` like any other ongoing failure.
 *
 * The bound on that is worth stating precisely, because it is narrower than it
 * sounds: if the healthy stretch in the middle lasts long enough for the
 * recovery to be *confirmed and delivered*, the next breach is a new incident
 * and does announce. What this removes is the sub-window flap, where the
 * all-clear never held.
 *
 * "Long enough" is `confirmRecoveryAfter` cycles — **thirty minutes** at the
 * shipped default, not hours. That is short enough for `breached → ok → ok`
 * repeating to re-open the door every third cycle, which is why the message cap
 * below is not optional decoration.
 *
 * It also removes a hazard rather than adding one: the runner no longer has to
 * read the previous state *before* inserting the new rows, an ordering whose
 * inversion would have silenced the whole layer while looking healthy.
 *
 * ## Two independent bounds on how much a check can say
 *
 * Alerting on every cycle of a long outage trains the team to mute the channel,
 * which reproduces ADR-006's silence with extra noise. Alerting only on the
 * transition means a message missed on a busy day is a message lost forever.
 *
 * The first bound is the re-alert window: while the channel is holding a problem
 * about a check, the same problem is repeated at most once per `reAlertAfterMs`.
 * The one thing that skips the window is a problem getting **worse** —
 * `breached` → `no_data` → `error`, in that order of severity. "The tutorial
 * rate is low", "we can no longer measure it at all" and "the source is gone"
 * are three different problems, and the later ones must not wait a day behind
 * the earlier one. Getting *better* without reaching `ok` (`error` → `breached`)
 * does wait: the channel already knows there is a problem.
 *
 * The second bound is {@link AlertPolicyInput.maxAlertsPerWindow}, and it exists
 * because the first one reasons about shapes. Enumerating oscillations and
 * proving each is bounded is how this policy has already been wrong twice: the
 * original version let every state change announce (a check flipping between two
 * failing states then spoke every cycle, forever), and the version that fixed
 * that still let `breached` → `ok` → `breached` through, because a confirmed and
 * delivered recovery legitimately re-opens the door. The cap does not care what
 * shape the flap has. When it is reached the check gets one `flapping` notice
 * and then goes quiet until the window rolls — quiet **announced**, not quiet
 * silently, because an unannounced mute is the ADR-006 failure wearing the
 * uniform of a fix.
 */
export function decideAlerts(input: AlertPolicyInput): AlertDecision {
  const announce: HealthCheckRecord[] = [];
  const recovered: HealthCheckRecord[] = [];
  const lostSignal: HealthCheckRecord[] = [];
  const flapping: HealthCheckRecord[] = [];
  const suppressed: SuppressedObservation[] = [];

  for (const record of input.observations) {
    const last = input.lastAlert.get(record.checkName) ?? null;
    /** The channel is holding an unresolved problem about this check. */
    const open: LastAlert | null =
      last !== null && last.status !== 'ok' ? last : null;

    /**
     * Route a record that the transition rules want delivered, unless the check
     * has already spent its budget for this window.
     */
    const deliver = (bucket: HealthCheckRecord[]): void => {
      const spent = input.alertsInWindow.get(record.checkName) ?? 0;
      if (spent < input.maxAlertsPerWindow) {
        bucket.push(record);
      } else if (spent === input.maxAlertsPerWindow) {
        // Exactly at the budget: say once that the check is going quiet. This
        // notice is itself delivered and stamped, so `spent` passes the budget
        // and every later observation takes the branch below.
        flapping.push(record);
      } else {
        suppressed.push({ record, reason: 'flapping' });
      }
    };

    /** Deliver only once `reAlertAfterMs` has passed since the last message. */
    const repeat = (since: LastAlert, bucket: HealthCheckRecord[]): void => {
      const elapsed = record.checkedAt.getTime() - since.at.getTime();
      if (elapsed >= input.reAlertAfterMs) {
        deliver(bucket);
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
        deliver(recovered);
      } else {
        // Healthy, but not for long enough to be believed yet. Held rather than
        // announced — see `confirmRecoveryAfter` for the reading behind it.
        suppressed.push({ record, reason: 'recovery_unconfirmed' });
      }
      continue;
    }

    if (open === null) {
      // The channel is holding nothing about this check.
      if (record.status === 'no_data') {
        // "Sem dados" is not a failure on its own: a ratio without a base is
        // not a low number, it is an unmeasured one. Alerting here is noise.
        suppressed.push({ record, reason: 'not_notifiable' });
      } else {
        // Never announced, or failing again after a delivered all-clear.
        deliver(announce);
      }
      continue;
    }

    const bucket = record.status === 'no_data' ? lostSignal : announce;

    if (SEVERITY[record.status] > SEVERITY[open.status]) {
      // The problem got worse. Never waits — see the class doc.
      deliver(bucket);
      continue;
    }

    // Same problem, or a lesser one. The channel hears again when the window
    // rolls, in the bucket that matches what is true *now*, so a lost signal is
    // never painted as a recovery.
    repeat(open, bucket);
  }

  return { announce, recovered, lostSignal, flapping, suppressed };
}

/**
 * How bad each verdict is, for deciding what may skip the re-alert window.
 *
 * `ok` is present only so the table is total; a record with `ok` never reaches
 * the comparison. The order among the rest is the one the alerter's colours
 * already imply: measured-and-bad, then not-measurable, then source-gone.
 */
const SEVERITY: Record<HealthCheckStatus, number> = {
  ok: 0,
  breached: 1,
  no_data: 2,
  error: 3,
};
