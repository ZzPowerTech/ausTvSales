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
  /** Network → survival conversion drifting from its 30-day mean. */
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
