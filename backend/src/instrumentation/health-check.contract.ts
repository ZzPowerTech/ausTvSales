import type { HealthCheckObservation } from './health-check.store';
import type { HealthCheckName } from './health-check.types';

/**
 * Injection token for the list of checks the runner executes.
 *
 * A token holding an array, rather than each check injected by name, so adding a
 * check is one line in the module and zero lines in the runner. The runner must
 * not know which checks exist — it only knows how to run, persist and announce.
 */
export const HEALTH_CHECKS = Symbol('HEALTH_CHECKS');

/**
 * One instrumentation-health check (spec §6.1, ADR-006).
 *
 * ## The contract, and why each clause is here
 *
 * A check answers "is this measurement still happening?" and returns one
 * observation per subject it evaluated. It must obey three rules:
 *
 * 1. **Never invent a number.** If the source had nothing for the window, return
 *    `no_data` — not `ok`, and never a zero. A collection gap read as zero is the
 *    exact mistake that made the tutorial collapse invisible for eight months.
 * 2. **Never swallow a failure.** If the source could not be reached or the
 *    response did not look like what was expected, return `error` with a summary
 *    that names the cause. The runner will also catch a thrown exception and turn
 *    it into `error`, but a check that knows why it failed should say so.
 * 3. **Always ship `n` beside a ratio.** `HealthCheckDetail.observed` without
 *    `detail.n` is a percentage without its base, which the project forbids
 *    everywhere and most of all in an alert, where somebody is about to act on it.
 *
 * ## Why `run` returns an array
 *
 * Some checks are inherently per-target: "no new session in 6h **on a server that
 * should be online**" is a verdict per server, not one global verdict. Those emit
 * one observation per target, named with {@link scopedCheckName}. A check with a
 * single global verdict returns an array of one.
 *
 * An empty array is legitimate and means "there was nothing to evaluate" — no
 * servers registered yet, for instance. It is not a failure, and the runner does
 * not manufacture a row for it.
 */
export interface HealthCheck {
  /** Base name, before any scoping suffix. Persisted, so it is a data contract. */
  readonly name: HealthCheckName;

  /**
   * Evaluate the check.
   *
   * Should not throw — return an `error` observation instead, so the reason
   * reaches Discord. The runner catches anyway, because an uncaught check must
   * never take down the whole cycle and silence the others.
   */
  run(): Promise<HealthCheckObservation[]>;
}
