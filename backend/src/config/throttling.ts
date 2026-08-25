import { Module } from '@nestjs/common';
import { ThrottlerModule, type ThrottlerOptions } from '@nestjs/throttler';

/**
 * Rate-limit profiles for the API (ADR-0001; AusTV Admin S7.2, issue #111).
 *
 * ## One root, several profiles
 *
 * `ThrottlerModule.forRoot()` may only be called **once** per application — it
 * registers the options and the storage as global providers, and a second call
 * silently wins over the first. It used to live inside `IngestModule`, which
 * made "add a rate limit to a dashboard route" a choice between importing the
 * ingest module from unrelated feature modules or breaking the app.
 *
 * So the root lives here, unnamed, and per-route profiles override it with
 * `@Throttle({ default: … })`. There is deliberately no *named* throttler:
 * `ThrottlerGuard` applies **every** configured throttler to any route it
 * guards, so a second named profile would silently stack on top of ingest's
 * rather than replace it.
 *
 * ## Nothing is throttled by default
 *
 * This is not registered as an `APP_GUARD`, and that is the same decision the
 * ingest slice made: `ThrottlerGuard` is applied per route, so a limit is
 * something a route opts into and can be read at the route. A global throttler
 * would also count the dashboard's own polling against the same bucket as an
 * attacker, which is how a legitimate operator gets a 429 during an incident —
 * exactly when they need the page.
 */

/**
 * Baseline profile, inherited by any route that guards with `ThrottlerGuard`
 * and does not override it.
 *
 * Calibrated for the real ingest workload: one request per in-game purchase, so
 * the natural volume is low. Nginx (`limit_req`) is the edge defence on the
 * game-server IP; this is the second line if somebody bypasses the proxy.
 *
 * `ttl` is in milliseconds (@nestjs/throttler v6 convention).
 */
export const INGEST_THROTTLE_TTL_MS = 1_000; // window: 1 second
export const INGEST_THROTTLE_LIMIT = 10; // ~10 req/s with a small burst → 429

/**
 * Profile for authenticated dashboard reads.
 *
 * A minute-long window rather than ingest's one second, because the shapes of
 * abuse differ. Ingest is machine traffic at a steady trickle and a burst is
 * the anomaly. The dashboard is a human opening a page that fires several
 * requests at once and then goes quiet, so a per-second limit would punish
 * normal use while leaving a slow scrape untouched.
 *
 * Deliberately generous. The point is not to make a legitimate operator think
 * about it — it is to bound what a leaked session cookie can pull, and to stop
 * a runaway frontend loop from turning into load on the Plan behind the cache.
 */
export const DASHBOARD_THROTTLE_TTL_MS = 60_000; // window: 1 minute
export const DASHBOARD_THROTTLE_LIMIT = 120; // ~2 req/s sustained per client

// Typed as the array member rather than `ThrottlerModuleOptions`, which is a
// union with an object form and therefore not indexable. The array shape is the
// one this project uses, and saying so keeps the spec able to assert on it.
export const appThrottlerOptions: ThrottlerOptions[] = [
  {
    ttl: INGEST_THROTTLE_TTL_MS,
    limit: INGEST_THROTTLE_LIMIT,
  },
];

/** The dashboard profile, for `@Throttle(...)` on a controller or handler. */
export const dashboardThrottle = {
  default: {
    ttl: DASHBOARD_THROTTLE_TTL_MS,
    limit: DASHBOARD_THROTTLE_LIMIT,
  },
} as const;

/**
 * Holds the single `ThrottlerModule.forRoot()` and re-exports it.
 *
 * Any module hosting a route that applies `ThrottlerGuard` imports this, so the
 * guard can resolve its options and storage.
 */
@Module({
  imports: [ThrottlerModule.forRoot(appThrottlerOptions)],
  exports: [ThrottlerModule],
})
export class ThrottlingModule {}
