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
   * While this reason is being produced, a `flapping` notice goes out
   * whenever the channel would otherwise pass a whole `reAlertAfterMs`
   * hearing nothing about the check — **except** on an `ok`, which can
   * never carry the notice, since it would be stamped `ok` and read as an
   * all-clear nobody gave. A run of held `ok` observations therefore extends
   * the quiet until the next non-`ok` one. Counted as `budgetHeld` in the run
   * summary. See {@link AlertPolicyInput.maxAlertsPerWindow}.
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
   * Checks that are over budget and have gone a whole window without a message.
   *
   * A cap without a notice is a silent mute, which is the failure this whole
   * layer exists to prevent. This bucket is that notice: it says the check is
   * changing state too often to be reported per event, and it is emitted
   * whenever the silence would otherwise reach `reAlertAfterMs` — never on an
   * `ok`, because a notice stamped `ok` would read as an all-clear nobody gave.
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
   * What each check has already told the channel inside the current
   * `reAlertAfterMs`, counted by status. From
   * `HealthCheckStore.alertsInWindow()`.
   */
  alertsInWindow: ReadonlyMap<string, ReadonlyMap<HealthCheckStatus, number>>;
  /**
   * Ceiling on how often a check may **repeat itself** inside one
   * `reAlertAfterMs`.
   *
   * The transition rules bound the oscillations somebody thought of, and a shape
   * nobody thought of is exactly how this layer got a three-message flap in
   * production — twice. So there is a backstop that does not depend on being
   * clever.
   *
   * ## What it must never gate, and why
   *
   * A budget is a way of going quiet, and going quiet is the failure this whole
   * layer exists to prevent. A first version of this counted every message and
   * gated every message; replayed against a check that flapped and then *died*,
   * it withheld the `error` for **45 hours** and, in a variant where the check
   * flapped and then stayed healthy, withheld the all-clear forever — leaving a
   * grey "this check is oscillating, calibrate its threshold" as the last word
   * about a source that was gone. The budget had rebuilt ADR-006's silence
   * inside the fix for ADR-006's noise.
   *
   * So a **status the channel has not heard this window** is never gated. A
   * check that has been saying `breached` all day and now says `error` is not
   * repeating itself, it is reporting something new, and new is exactly what a
   * budget must let through. This is why {@link alertsInWindow} is counted per
   * status rather than totalled.
   *
   * What is left to gate is repetition of something already said, which is what
   * a flap is made of.
   *
   * ## The recovery is gated too, one slot earlier than the rest
   *
   * The same first version left the all-clear ungated, on the reasoning that
   * withholding one is how a channel ends up believing a fixed thing is broken.
   * Measured, it did the opposite: on a flapping check the recoveries arrive as
   * fast as the failures, so the ungated one won the race to be the **last**
   * message, and the channel was left holding a green banner over something
   * breaching every third cycle — then 22 hours of silence, because the failures
   * after it were over budget. A false all-clear is the one thing this layer may
   * never produce, so an all-clear is budgeted like everything else, and its
   * limit is one slot lower so that a problem, never a green, is what the
   * channel is left holding.
   *
   * What keeps a genuine recovery from starving is not a bypass but the free
   * pass above: once the flap's own `ok` messages age out of the window, a
   * confirmed recovery is news again and goes out on its own. The wait is
   * bounded by `reAlertAfterMs` and shows up as `budgetHeld` in the run
   * summary — and it is a real cost, measured at up to ~23h of the channel
   * holding a `breached` over a check that is already healthy, with nothing
   * said during the wait, because the notice cannot ride an `ok`.
   *
   * The reservation reduces false greens rather than removing them, for the
   * reason given on `deliver`.
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
 * delivered recovery legitimately re-opens the door.
 *
 * The budget does not care what shape the flap has. It counts **repetition** —
 * saying again, this window, something the channel already heard this window —
 * and nothing else: a status not yet heard and a confirmed recovery always go
 * out. That distinction is load-bearing and is documented on
 * `maxAlertsPerWindow`, along with the 45-hour silence a version without it
 * produced.
 *
 * When the budget runs out the check goes quiet about that repetition, and the
 * quiet is announced rather than silent — an unannounced mute is the
 * ADR-006 failure wearing the uniform of a fix. The guarantee is stated in
 * terms of what the channel experiences, because that is the thing that can
 * be checked: once a check has been quiet for `reAlertAfterMs` while over
 * budget, **the next non-`ok` observation is published** as a `flapping`
 * notice saying the check is oscillating and has been muted. A run of `ok`
 * observations on the boundary stretches the quiet by those cycles — the
 * notice may not be stamped `ok`, or it would read as an all-clear nobody
 * gave — so the bound is one window plus that run, not one window flat.
 * Measured at a few cycles over in the worst shapes found, never unbounded.
 *
 * One consequence worth naming, because it is a real cost and not an oversight:
 * inside a window in which the channel has already heard from the check, a
 * *refinement* of a problem it already knows about can wait. `no_data` → `error`
 * fifteen minutes later — "cannot measure it" becoming "cannot reach it" — is
 * held if the budget is spent. The channel is not blind in that case: it was
 * told fifteen minutes earlier that the check had stopped being measurable,
 * which is the signal that matters. What may never wait is the *first* time the
 * channel hears a status, and that is exactly what the free pass protects.
 *
 * ## `no_data` never announces on its own, and that is a contract on the checks
 *
 * A `no_data` observation with nothing open on the check is suppressed as
 * `not_notifiable`, with no timer and no escalation. That is intentional —
 * "sem base" is not a low number, and announcing every absent denominator is
 * the noise that turns the channel mute — but it means a check that returns
 * `no_data` forever, starting from a clean state, **never produces a single
 * message**.
 *
 * So the burden sits on the check, not here: a source that comes back empty
 * when it *cannot* be empty is `error`, not `no_data`. `plan_servers` with no
 * servers and `plan_users` with no rows are not empty windows, they are failed
 * reads, and all three checks that touch them say so. `no_data` is reserved for
 * a window that genuinely had nothing in it — too small a sample, a version
 * Plan never recorded, a comparison with one side missing.
 *
 * Before moving a check to `no_data`, ask whether that verdict repeating for a
 * month should be heard. If yes, it is `error`.
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

    const heard = input.alertsInWindow.get(record.checkName);
    /** Messages of this exact status the channel already heard this window. */
    const heardThis = heard?.get(record.status) ?? 0;
    /** Messages of any status the channel already heard this window. */
    let heardAny = 0;
    for (const count of heard?.values() ?? []) {
      heardAny += count;
    }

    /**
     * Say once per window that this check went quiet, instead of muting it
     * silently.
     *
     * Keyed on the last delivered message rather than on a counter crossing an
     * exact value. Two earlier versions fired the notice at
     * `heardAny === maxAlertsPerWindow` exactly and were both wrong: any record
     * taking a free pass steps the counter over that point without ever testing
     * it, and the check is then muted with nothing said. A rule that asks "has
     * the channel heard anything at all from this check in a window?" cannot be
     * stepped over.
     *
     * Never on an `ok`. The notice is stamped with the record's status, and one
     * stamped `ok` would clear `open` — the channel would hold an all-clear it
     * was never given, and the recovery waiting for budget could no longer be
     * recognised as one.
     */
    const mute = (): void => {
      const silentFor =
        last === null
          ? Number.POSITIVE_INFINITY
          : record.checkedAt.getTime() - last.at.getTime();

      if (silentFor >= input.reAlertAfterMs && record.status !== 'ok') {
        flapping.push(record);
      } else {
        suppressed.push({ record, reason: 'flapping' });
      }
    };

    /**
     * Route a record the transition rules want delivered.
     *
     * Only repetition is gated — see `maxAlertsPerWindow` for why a status the
     * channel has not heard this window must always get through.
     *
     * A recovery is held one slot earlier than everything else, and that slot
     * is the point: whatever is delivered last defines what the channel
     * believes while the check is muted. Let an all-clear take the final slot
     * of a flapping check and the standing state becomes a green banner over
     * something breaching every third cycle.
     *
     * It **reduces** that; it does not eliminate it, and the reason is one
     * line up. The free pass short-circuits before the limit is consulted, so
     * a first-of-its-status recovery still takes the last slot — measured,
     * the reservation cuts false-green cycles by a few percent, not to zero.
     * The trade is deliberate: the free pass is what keeps a genuine all-clear
     * from starving, and starving one is worse than a green that a later
     * failure corrects within the window. It is also inert for
     * `maxAlertsPerWindow <= 2`, where the free pass already covers every slot
     * there is.
     */
    const deliver = (bucket: HealthCheckRecord[]): void => {
      const limit =
        record.status === 'ok'
          ? input.maxAlertsPerWindow - 1
          : input.maxAlertsPerWindow;

      if (heardThis === 0 || heardAny < limit) {
        bucket.push(record);
      } else {
        mute();
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
        //
        // Budgeted like everything else, and the reason is the flap: a check
        // that oscillates produces all-clears as fast as it produces failures,
        // and an ungated one wins the race to be the **last** message. The
        // channel is then left holding a green banner over a check that is
        // breaching every third cycle — a false all-clear, which is the one
        // outcome this layer may never produce. What protects the real recovery
        // is not a bypass but the free pass on `heardThis === 0`: once the
        // flap's own `ok` messages age out of the window, the next confirmed
        // recovery is news again and goes out.
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
