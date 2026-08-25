import { applyDecorators, Module, UseGuards } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import {
  Throttle,
  ThrottlerGuard,
  ThrottlerModule,
  type ThrottlerOptions,
} from '@nestjs/throttler';

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
 *
 * The cost of opting in is that forgetting `@Throttle` while remembering
 * `@UseGuards(ThrottlerGuard)` silently inherits the **ingest** profile — 10
 * req/s on a dashboard page. {@link DashboardThrottle} exists so that
 * combination cannot be written by accident.
 *
 * ## Counters live in this process, and only in this process
 *
 * The default `ThrottlerStorageService` is a plain `Map` per process. That is
 * correct for the deployment described in `CLAUDE.md` — one isolated container
 * behind Nginx — and it silently halves the effective limit per replica the day
 * somebody runs two. The escape hatch is `ThrottlerStorageRedis`; the point of
 * saying so here is that the assumption should fail loudly in review rather than
 * quietly in production.
 *
 * ## `TRUST_PROXY` decides who a "client" is
 *
 * The tracker key is `req.ip`, so the same setting that governs the ingest IP
 * allowlist also decides how these buckets are partitioned. `docs/nginx-ingest.md`
 * documents it as an allowlist concern whose symptom is a 403 — but a wrong value
 * behind Nginx makes `req.ip` the proxy's address for *every* request, and then
 * every dashboard client shares one bucket. That failure looks nothing like a
 * 403: it is intermittent 429s that correlate with no single user.
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
/**
 * 120 per minute **per route**, not per controller.
 *
 * The tracker key that `ThrottlerGuard` builds includes the handler name, so
 * every route gets its own independent bucket. A controller with three routes
 * therefore admits 360/min from one client, and the ceiling grows with each
 * route added — which matters because the stated purpose is bounding what a
 * leaked session cookie can pull.
 *
 * Left per-route deliberately: a shared controller budget would let a single
 * hot endpoint starve the others, and the ceiling is still far below anything a
 * human generates.
 */
export const DASHBOARD_THROTTLE_LIMIT = 120;

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
 * Modules hosting a throttled route import this. Strictly speaking they do not
 * have to — `ThrottlerModule` is `@Global()`, so once this module is
 * instantiated anywhere its providers resolve app-wide. The explicit import is
 * kept because it makes the dependency readable at the module that has it, and
 * because a global that works by side effect is the kind of thing that breaks
 * confusingly when the graph is rearranged.
 *
 * The re-export, on the other hand, **is** required: Nest only lets a module
 * export what it imports, so `IngestModule` has to re-export `ThrottlingModule`
 * rather than `ThrottlerModule`. Getting that wrong fails at boot, and no unit
 * test catches it — none of them builds the whole module graph.
 */
@Module({
  imports: [ThrottlerModule.forRoot(appThrottlerOptions)],
  exports: [ThrottlerModule],
})
export class ThrottlingModule {}

/**
 * Everything a dashboard read route needs to be rate limited, in one decorator.
 *
 * Composition, and why it is a bundle rather than three imports at each call
 * site — the same argument `@IngestAuth()` makes for the ingest routes:
 *
 *  - `ThrottlerGuard` applies the limit.
 *  - `@Throttle` replaces the **ingest** baseline with the dashboard profile.
 *    Applying the guard without this is the failure mode worth designing out: it
 *    compiles, it looks throttled, and it puts 10 req/s on a page a human uses.
 *  - `@ApiResponse` documents the 429, so a consumer reading the contract knows
 *    the status exists before meeting it.
 *
 * Bundling makes the wrong combination unrepresentable.
 */
export function DashboardThrottle(): ReturnType<typeof applyDecorators> {
  return applyDecorators(
    UseGuards(ThrottlerGuard),
    Throttle(dashboardThrottle),
    ApiResponse({
      status: 429,
      description:
        'Limite de taxa das leituras de dashboard excedido (ver dashboardThrottle).',
    }),
  );
}
