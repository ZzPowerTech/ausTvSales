/**
 * Shared vocabulary of the instrumentation-health layer (spec §6.1, ADR-006).
 *
 * Story S6.3. This layer exists because every serious problem found at AusTV was
 * invisible for months: the production Plan ran on SQLite while the MySQL being
 * queried was half-empty, the proxy stopped collecting for three months, and the
 * tutorial stopped capturing newcomers for eight. A dashboard that cannot detect
 * its own collection failure is worse than no dashboard, because it manufactures
 * confidence.
 */

/**
 * Verdict of a single check execution.
 *
 * The four states are deliberate. Collapsing `no_data` or `error` into `ok`
 * recreates the silence ADR-006 exists to remove; collapsing them into a zero
 * reading invents a measurement that was never taken. Both are forbidden.
 */
export const HEALTH_CHECK_STATUSES = [
  /** Ran, and the alert condition is not met. */
  'ok',
  /** Ran, and the alert condition **is** met — this is what notifies. */
  'breached',
  /** Ran, but the source had nothing for the window. Not zero, not a failure. */
  'no_data',
  /** Could not run: source unreachable or an unexpected fault. */
  'error',
] as const;

export type HealthCheckStatus = (typeof HEALTH_CHECK_STATUSES)[number];

/**
 * The seven checks of spec §6.1, each paired with the disaster it would have
 * caught. The string values are persisted, so they are part of the data contract
 * and must not be renamed casually.
 */
export const HealthCheckName = {
  /** No new session in N hours on a server that should be online. */
  CollectionAlive: 'plan.collection_alive',
  /** No new `plan_users.registered` in N hours on the proxy. */
  ProxyRegistrationAlive: 'plan.proxy_registration_alive',
  /** A server present in `plan_servers` with no recent data at all. */
  OrphanInstance: 'plan.orphan_instance',
  /** Instances running different Plan builds — corrupts a shared schema. */
  VersionDivergence: 'plan.version_divergence',
  /** `newcomers_in_tutorial / newcomers_in_survival` under the floor. */
  TutorialEntryRate: 'funnel.tutorial_entry_rate',
  /**
   * ⚠️ Publishes **no ratio**. An accepted blind spot since 2026-08-31.
   *
   * It was written to watch the network → survival conversion drift from its
   * 30-day mean. It never could: both sides were the same population. See
   * {@link ACCEPTED_BLIND_SPOTS} and the check's own docblock.
   */
  NetworkToSurvival: 'funnel.network_to_survival',
  /** `java_offline` share climbing outside its band — possible bot traffic. */
  OfflineAccountShare: 'platform.offline_account_share',
} as const;

export type HealthCheckName =
  (typeof HealthCheckName)[keyof typeof HealthCheckName];

/**
 * Separator between a check's name and the subject it was evaluated against.
 *
 * Some checks are inherently per-target — "no new session in 6h **on a server
 * that should be online**" is a verdict per server, not a single global verdict.
 * Those emit one row per target, named `plan.collection_alive:survival`.
 */
/**
 * Checks that are **permanently** unable to measure, by a decision on record.
 *
 * ## The state the four verdicts cannot express
 *
 * `ok`, `breached`, `no_data` and `error` all describe one execution, and three
 * of them are transient by construction: something failed, or a window came back
 * empty, and next cycle it might not. Every consumer is built on that assumption.
 * `decideAlerts` re-announces an open problem until it clears; `resolveStatus`
 * reports `degraded` while any check is not measuring. Both are correct for a
 * check that will recover.
 *
 * A check that will **never** recover breaks both. `funnel.network_to_survival`
 * is one: its denominator source does not exist, so it returns `no_data` on every
 * cycle forever. Left alone, that produced two defects, and neither is
 * hypothetical — both were caught in review of the change that created them:
 *
 * 1. **A daily alert, forever.** `no_data` is suppressed as `not_notifiable`
 *    only while the channel is holding nothing about the check. With any open
 *    non-`ok` alert — a past `error` from a MySQL blip that never got a confirmed
 *    recovery — the policy falls through to `repeat`, which delivers once
 *    `reAlertAfterMs` has passed and then again every window. The exit is an `ok`
 *    record, and there is no longer any.
 * 2. **`degraded` forever.** `resolveStatus` returns `degraded` whenever
 *    `counts.no_data > 0`, so the aggregate could never read `ok` again, and a
 *    second check going bad would no longer move it. That is the founding
 *    disaster of this epic wearing a permanent yellow light: not a false `ok`,
 *    but a status that has stopped carrying information.
 *
 * ## What membership means
 *
 * **Silence for the verdict it was accepted for, and nothing else.** For
 * `funnel.network_to_survival` that is `no_data`: those never notify — not the
 * first time, not after a window rolls, and regardless of what the channel is
 * holding. **Any other status is announced normally.**
 *
 * That second half is not a hedge, it is the safety property. Suppressing by
 * name alone — the first version of this — is safe only while every member can
 * emit nothing but its accepted verdict, which is enforced by nothing. A future
 * member that hit a real outage and began returning `error` would have had every
 * one of those verdicts dropped, for as long as it lasted: a mechanism built to
 * stop one check paging daily, hiding an unbounded real failure instead. Letting
 * the unexpected status through is also how the contradiction surfaces — a
 * member of this set that alerts is a member that no longer belongs in it.
 *
 * And **excluded from the aggregate verdict**, while still published by name in
 * `blindSpots` and flagged per row as `blindSpot` in the check listing, because
 * a blind spot that vanished from the payload would be the "absence reads as
 * fine" mistake this whole layer exists to prevent. It stays registered and
 * keeps writing a fresh row per cycle, so it never ages into `staleChecks` and
 * its reason is always one request away. Suppressed verdicts are counted apart
 * in the cycle summary (`blindSpotHeld`), so how much of the layer has been
 * switched off is a number somebody can read.
 *
 * ## The cost, which is real and is not hidden
 *
 * A check that enters this set while the channel is holding a `breached` or
 * `error` about it leaves that message standing as the last word, with no
 * closing note, for as long as it keeps returning its accepted verdict. That is
 * deliberate: the
 * alternative is a "deliver exactly once, then stop" rule, and the transition
 * rules in `decideAlerts` have already been wrong twice by reasoning about
 * shapes of oscillation. A stale **failure** misleads in the safe direction; a
 * stale all-clear is the one thing this layer may never produce, so stamping an
 * `ok` to clear the channel is not an option either — see `mute()`.
 *
 * ## Adding to this set is a decision, not a shortcut
 *
 * The bar is that **no data source reachable by this system can answer the
 * question**, and that this is written down somewhere durable. It is not for a
 * check that is noisy, badly calibrated, or inconvenient — silencing one of
 * those is how a channel goes quiet about something real. Removing a name is
 * always safe: the check simply resumes alerting.
 */
export const ACCEPTED_BLIND_SPOTS: ReadonlySet<HealthCheckName> = new Set([
  HealthCheckName.NetworkToSurvival,
]);

/**
 * Is this verdict from an accepted blind spot?
 *
 * Takes the **persisted** name, scope suffix and all, because that is what both
 * callers hold: they read records out of the store, not check instances.
 */
export function isAcceptedBlindSpot(persistedName: string): boolean {
  return (ACCEPTED_BLIND_SPOTS as ReadonlySet<string>).has(
    parseCheckName(persistedName).name,
  );
}

export const SCOPE_SEPARATOR = ':';

/** Build the persisted name of a check evaluated against a specific subject. */
export function scopedCheckName(name: HealthCheckName, target: string): string {
  return `${name}${SCOPE_SEPARATOR}${target}`;
}

/** Split a persisted name back into its base check and optional target. */
export function parseCheckName(persisted: string): {
  name: string;
  target: string | null;
} {
  const index = persisted.indexOf(SCOPE_SEPARATOR);
  return index === -1
    ? { name: persisted, target: null }
    : {
        name: persisted.slice(0, index),
        target: persisted.slice(index + SCOPE_SEPARATOR.length),
      };
}

/**
 * Structured verdict of one execution.
 *
 * `observed` and `n` travel together on purpose: the project rule is that no
 * percentage is ever published without the base it was computed from. A ratio
 * with an absent or zero `n` is not a small number, it is an unmeasured one —
 * and the check should have returned `no_data` instead.
 */
export interface HealthCheckDetail {
  /** One-line summary in Portuguese — this is what the Discord message shows. */
  summary: string;
  /** The value that drove the verdict, when the check produces a number. */
  observed?: number;
  /** What `observed` was compared against. */
  threshold?: number;
  /** Sample size behind `observed`. Required whenever `observed` is a ratio. */
  n?: number;
  /** Extra context: server name, window, build ids. Never personal data. */
  context?: Record<string, string | number | boolean | null>;
}

/** A persisted check execution, as read back from `health_checks`. */
export interface HealthCheckRecord {
  id: number;
  checkName: string;
  status: HealthCheckStatus;
  checkedAt: Date;
  detail: HealthCheckDetail | null;
  alertedAt: Date | null;
}

/**
 * The last verdict of a check that actually reached Discord.
 *
 * The status matters as much as the timestamp. Alert decisions are made against
 * **what the channel was last told**, not against the last row written: a
 * recovery that was held back leaves the channel believing the check is still
 * failing, and re-announcing the same failure there is noise, not news.
 */
export interface LastAlert {
  status: HealthCheckStatus;
  at: Date;
}
