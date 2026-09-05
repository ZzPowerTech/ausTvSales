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
/**
 * Hard 10 per one-second window. **No burst allowance** — and the absence is
 * load-bearing rather than an omission.
 *
 * Nginx's edge rule is `rate=10r/s burst=20 nodelay` and answers with 503, which
 * the plugin retries safely. This limit is stricter, so it fires *first*, and it
 * answers 429 — which the plugin currently treats as permanent and discards
 * (issue #157). Widening the burst here would paper over that; fixing the
 * classification is the correct resolution, and until it lands this number is
 * the one that decides whether a queue drain loses sales.
 */
export const INGEST_THROTTLE_LIMIT = 10;

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
/**
 * Rate limit for a route whose cost is **outbound**, not inbound.
 *
 * `POST /reports/weekly/run` reaches the game machine and posts to a Discord
 * channel on every call. The dashboard profile is sized for a human clicking
 * around a page (120/min) and is far too generous for that; six an hour is
 * generous for someone checking a report by hand and low enough that a browser
 * tab stuck in a retry loop cannot turn the channel into a flood.
 *
 * Bundled with the guard for the reason `DashboardThrottle` states and this
 * codebase then proved by getting it wrong: `@Throttle` alone is **metadata**,
 * and `ThrottlerGuard` is deliberately not an `APP_GUARD` here. A bare
 * `@Throttle` compiles, reads as throttled, documents itself as throttled — and
 * enforces nothing. It was on the one route with side effects.
 */
export const MANUAL_RUN_THROTTLE_TTL_MS = 3_600_000;
export const MANUAL_RUN_THROTTLE_LIMIT = 6;

export const manualRunThrottle = {
  default: {
    ttl: MANUAL_RUN_THROTTLE_TTL_MS,
    limit: MANUAL_RUN_THROTTLE_LIMIT,
  },
} as const;

export function ManualRunThrottle(): ReturnType<typeof applyDecorators> {
  return applyDecorators(
    UseGuards(ThrottlerGuard),
    Throttle(manualRunThrottle),
    ApiResponse({
      status: 429,
      description:
        'Limite de execucoes manuais excedido (ver manualRunThrottle): cada ' +
        'execucao consulta a maquina do jogo e publica no canal.',
    }),
  );
}

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

/**
 * Bot→API profile (story S10.2).
 *
 * Staff actions on suggestions are human-paced: a moderator working through a
 * backlog approves a handful a minute, not a hundred. The window is generous
 * enough that a burst of button presses never trips it, and tight enough that a
 * loop — a bot bug, or a leaked key used from the same host — cannot rewrite the
 * whole table before anyone notices.
 *
 * Deliberately not the ingest profile. 10 req/s is right for a plugin draining a
 * queue and is far too permissive for a route that mutates staff-facing state.
 */
export const BOT_THROTTLE_TTL_MS = 60_000; // window: 1 minute
export const BOT_THROTTLE_LIMIT = 60;

export const botThrottle = {
  default: { ttl: BOT_THROTTLE_TTL_MS, limit: BOT_THROTTLE_LIMIT },
} as const;

/**
 * Profile for **anonymous** reads (story S11.1).
 *
 * The other three profiles all bound a principal the API knows: an allowlisted
 * game server, a session cookie, an API key. This one bounds nobody in
 * particular — the only key is `req.ip`, and the route it protects is reachable
 * by anyone who finds the URL.
 *
 * That changes what the number is for. `dashboardThrottle` exists to bound what
 * a *leaked* credential can pull and can afford to be generous, because the
 * holder was legitimate a moment ago. Here there is no credential to leak and no
 * legitimacy to assume, so the limit is the whole control: it is what stops the
 * public listing from being a free full-table sort on demand (see the ordering
 * note in `SuggestionsStore.list` — neither sort is indexed).
 *
 * 60 per minute per IP. A person reading a suggestions page fires one request
 * per click and a handful on load; a hundred pages of backlog at 20 rows a page
 * is two thousand suggestions, which this table will not hold for years. So the
 * limit is far above a reader and far below a scraper walking the offsets.
 *
 * ## What it does not bound
 *
 * `req.ip` behind Nginx is only the real client if `TRUST_PROXY` is right — the
 * same dependency the ingest allowlist has, with a different symptom: a wrong
 * value here puts every anonymous reader in one bucket, and the page starts
 * answering 429 to people who did nothing. And nothing here is per-account,
 * because there are no accounts: a distributed scrape is not addressed by this
 * and is not meant to be. The data is public by decision (§8 exception); the
 * limit protects the database, not the rows.
 */
export const PUBLIC_READ_THROTTLE_TTL_MS = 60_000; // window: 1 minute
export const PUBLIC_READ_THROTTLE_LIMIT = 60;

export const publicReadThrottle = {
  default: {
    ttl: PUBLIC_READ_THROTTLE_TTL_MS,
    limit: PUBLIC_READ_THROTTLE_LIMIT,
  },
} as const;

/**
 * Guard + profile + documented 429 for an anonymous read route, in one
 * decorator.
 *
 * Bundled for the reason the file has already had to learn twice: `@Throttle`
 * alone is metadata, `ThrottlerGuard` is deliberately not an `APP_GUARD` here,
 * and the combination that compiles-but-enforces-nothing is exactly the one a
 * hurried edit produces. On an authenticated route that mistake costs a rate
 * limit; on this one it costs the only control the route has.
 */
export function PublicReadThrottle(): ReturnType<typeof applyDecorators> {
  return applyDecorators(
    UseGuards(ThrottlerGuard),
    Throttle(publicReadThrottle),
    ApiResponse({
      status: 429,
      description:
        'Limite de taxa da leitura publica excedido (ver publicReadThrottle).',
    }),
  );
}
