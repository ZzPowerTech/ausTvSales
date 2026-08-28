import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PlanApiClient } from '../instrumentation/plan-api.client';
import {
  PlanAuthError,
  PlanForbiddenError,
  PlanHttpError,
  PlanMalformedResponseError,
  PlanNotConfiguredError,
  PlanUnreachableError,
} from '../instrumentation/plan-api.errors';
import { PlanServersConfig } from '../instrumentation/plan-servers.config';
import { parseServerOverview } from '../instrumentation/plan-server-overview';
import type {
  ConfiguredServersDto,
  MetricsFailureReason,
  MetricsFreshnessDto,
  MetricsWindowDto,
  ServerActivityDto,
  ServerActivityResponseDto,
  ServerOverviewDto,
  ServerOverviewResponseDto,
} from './dto/metrics.dto';
import { PlanCache, type CacheResult } from './plan-cache';
import { parseOnlineOverview, type OnlineWindow } from './plan-online-overview';

/** Defaults documented in `.env.example`. */
const DEFAULT_OVERVIEW_TTL_SECONDS = 60;
const DEFAULT_ACTIVITY_TTL_SECONDS = 900;

/**
 * A Plan response that parsed as JSON but no longer matches the observed shape.
 *
 * Its own class so the failure is classifiable rather than a bare `Error` that
 * would land in `unknown`. It is the failure a Plan upgrade produces, and it
 * deserves to be distinguishable from an outage in the one field a consumer
 * gets to see.
 */
export class ContractMismatchError extends Error {
  constructor(reason: string) {
    super(`resposta do Plan nao reconhecida: ${reason}`);
    this.name = 'ContractMismatchError';
  }
}

/** A response plus whether it should leave as a 503. */
export interface MetricsRead<T> {
  body: T;
  /** True when Plan could not be reached — stale value, or nothing at all. */
  degraded: boolean;
}

/**
 * Normalised reads of the Plan JSON API (story S7.2, issue #111).
 *
 * ## ADR-002 lives here
 *
 * Everything this service knows about Plan goes through {@link PlanApiClient}
 * and the two adapters. No table name appears in this file, and none should:
 * Plan's internal schema changes between versions, and the one documented
 * exception in the whole system is the cohort module of S8.2.
 *
 * The adapters are also where Plan's spelling stops. `new_players_7d` and
 * `session_length_30d_avg` never reach a route — a consumer that grew to depend
 * on them would break on an upgrade nobody here controls.
 *
 * ## The server name is validated against configuration, not passed through
 *
 * `?server=` is forwarded to Plan, so accepting an arbitrary string would let a
 * caller probe the Plan instance for server names through this API. It also
 * would not work: Plan answers `403` for a name it does not know, which would
 * surface here as `forbidden` — a label that names three candidate causes and
 * sends the reader looking at the whitelist, rather than the honest "that is not
 * one of ours". Unknown names are a 404 before any request leaves the process.
 *
 * ## A parse failure is a fetch failure
 *
 * The adapters run **inside** the cache's fetch closure, so a Plan response that
 * no longer matches the observed shape is thrown rather than returned. That is
 * deliberate: it means a contract change degrades exactly like an outage — the
 * last good value is served marked stale, and if there is none the answer is an
 * explicit failure naming the mismatch. The alternative, publishing a
 * half-parsed body, is how a silent schema drift becomes a wrong number on a
 * dashboard.
 */
@Injectable()
export class MetricsService {
  private readonly overviewTtlMs: number;
  private readonly activityTtlMs: number;

  constructor(
    private readonly plan: PlanApiClient,
    private readonly servers: PlanServersConfig,
    private readonly cache: PlanCache,
    config: ConfigService,
  ) {
    this.overviewTtlMs =
      (config.get<number>('PLAN_CACHE_TTL_SERVER_SECONDS') ??
        DEFAULT_OVERVIEW_TTL_SECONDS) * 1000;
    this.activityTtlMs =
      (config.get<number>('PLAN_CACHE_TTL_ACTIVITY_SECONDS') ??
        DEFAULT_ACTIVITY_TTL_SECONDS) * 1000;
  }

  /**
   * The instances this API is configured to read.
   *
   * The **declared** inventory, not a discovery of what Plan actually runs. A
   * caller reading this as "the servers that exist" would miss precisely the
   * instance nobody configured — which is why `plan.orphan_instance` reconciles
   * this list against the observed one instead of trusting it. Cost and the
   * falsified premise behind it are stated in `PlanServersConfig`.
   */
  configuredServers(): ConfiguredServersDto {
    return {
      servers: this.servers.all().map((server) => ({
        name: server.name,
        proxy: server.proxy,
      })),
    };
  }

  /**
   * Point-in-time view of one server, from `/v1/serverOverview`.
   *
   * `now` is a parameter so a test can move past a TTL without `useFakeTimers`,
   * which also mocks `setTimeout` and would hang against the transport's own
   * retry backoff.
   */
  async serverOverview(
    name: string,
    now: Date = new Date(),
  ): Promise<MetricsRead<ServerOverviewResponseDto>> {
    const server = this.requireConfigured(name);

    const result = await this.cache.read(
      `serverOverview:${server}`,
      this.overviewTtlMs,
      async () => {
        const body = await this.plan.getJson('/v1/serverOverview', {
          server,
        });
        const parsed = parseServerOverview(body);
        if (!parsed.ok) {
          throw new ContractMismatchError(parsed.reason);
        }
        return parsed.value;
      },
      now,
    );

    const data: ServerOverviewDto | null =
      result.value === null
        ? null
        : {
            server,
            observedAt: toIso(result.value.timestamp),
            onlinePlayers: result.value.numbers.onlinePlayers,
            totalPlayers: result.value.numbers.totalPlayers,
            totalSessions: result.value.numbers.sessions,
            lastPeakAt: toIso(result.value.numbers.lastPeakDate),
            newPlayers7d: result.value.last7Days.newPlayers,
            uniquePlayers7d: result.value.last7Days.uniquePlayers,
            newPlayerRetention7d: {
              value: result.value.last7Days.newPlayersRetention,
              // The base is the arrivals of the same window, reused from the
              // parsed value rather than re-read. Never derived from the
              // percentage Plan also prints — that string is dropped at the
              // adapter precisely so it cannot become a source here.
              n: result.value.last7Days.newPlayers,
            },
          };

    return {
      body: { freshness: toFreshness(result), data },
      degraded: isDegraded(result),
    };
  }

  /** Windowed activity of one server, from `/v1/onlineOverview`. */
  async serverActivity(
    name: string,
    now: Date = new Date(),
  ): Promise<MetricsRead<ServerActivityResponseDto>> {
    const server = this.requireConfigured(name);

    const result = await this.cache.read(
      `onlineOverview:${server}`,
      this.activityTtlMs,
      async () => {
        const body = await this.plan.getJson('/v1/onlineOverview', {
          server,
        });
        const parsed = parseOnlineOverview(body);
        if (!parsed.ok) {
          throw new ContractMismatchError(parsed.reason);
        }
        return parsed.value;
      },
      now,
    );

    const data: ServerActivityDto | null =
      result.value === null
        ? null
        : {
            server,
            observedAt: toIso(result.value.timestamp),
            last24h: toWindow(result.value.last24h),
            last7d: toWindow(result.value.last7d),
            last30d: toWindow(result.value.last30d),
          };

    return {
      body: { freshness: toFreshness(result), data },
      degraded: isDegraded(result),
    };
  }

  /**
   * Resolve a requested name to a configured one, case-insensitively.
   *
   * Returns the **configured** spelling rather than what the caller sent, because
   * Plan's `?server=` is case sensitive: forwarding `survival` where the instance
   * is `Survival` earns a 403 from Plan, which leaves here as `forbidden` — a
   * label whose candidate causes are all about access, none of them a typo.
   */
  private requireConfigured(name: string): string {
    const match = this.servers
      .all()
      .find((server) => server.name.toLowerCase() === name.toLowerCase());

    if (!match) {
      throw new NotFoundException(
        `Servidor "${name}" nao esta em PLAN_SERVERS. Configurados: ` +
          `${this.servers
            .all()
            .map((server) => server.name)
            .join(', ')}`,
      );
    }
    return match.name;
  }
}

function toWindow(window: OnlineWindow): MetricsWindowDto {
  return {
    newPlayers: window.newPlayers,
    uniquePlayers: window.uniquePlayers,
    sessions: window.sessions,
    playtimeMs: window.playtimeMs,
    sessionLengthAvgMs: window.sessionLengthAvgMs,
    newPlayerRetention: window.newPlayerRetention,
  };
}

function toFreshness(result: CacheResult<unknown>): MetricsFreshnessDto {
  return {
    stale: result.outcome === 'stale',
    fetchedAt: result.storedAt?.toISOString() ?? null,
    ageSeconds: result.ageMs === null ? null : Math.round(result.ageMs / 1000),
    reason: classify(result.error),
  };
}

/**
 * Map a transport failure to the closed vocabulary the contract publishes.
 *
 * The raw message never crosses this function. It names the Plan host and, for
 * `PlanHttpError` and `PlanMalformedResponseError`, quotes up to 200 characters
 * of whatever Plan returned — which the client's own doc says is typically an
 * HTML login page. Behind the session that is not an open disclosure, but it is
 * unfiltered upstream content reaching a browser, and there is no reason for it
 * to. `PlanCache` already logs the full message.
 */
function classify(error: unknown): MetricsFailureReason | null {
  if (error === null || error === undefined) {
    return null;
  }
  if (error instanceof ContractMismatchError) {
    return 'contract_mismatch';
  }
  if (error instanceof PlanNotConfiguredError) {
    return 'not_configured';
  }
  if (error instanceof PlanUnreachableError) {
    return 'unreachable';
  }
  if (error instanceof PlanAuthError) {
    return 'auth';
  }
  // Separate from `auth`: a 403 here is not a credential being wrong — see the
  // candidate causes enumerated in `PlanForbiddenError`.
  if (error instanceof PlanForbiddenError) {
    return 'forbidden';
  }
  if (error instanceof PlanMalformedResponseError) {
    return 'malformed';
  }
  if (error instanceof PlanHttpError) {
    return 'upstream_error';
  }
  // Never dropped: an unclassified failure is still a failure, and answering
  // `null` here would make a degraded response look fresh.
  return 'unknown';
}

/** Both failure outcomes leave as 503; they differ in whether `data` is null. */
function isDegraded(result: CacheResult<unknown>): boolean {
  return result.outcome === 'stale' || result.outcome === 'unavailable';
}

/**
 * Epoch ms to ISO-8601, treating a non-positive value as "not reported".
 *
 * `toNumber` already maps Plan's sentinels to `null`, but a literal `0` is a
 * finite number and would render as `1970-01-01T00:00:00.000Z` — an invented
 * timestamp in a module whose whole premise is not inventing values. A server
 * that never had a player peak is exactly the case that would produce it.
 */
function toIso(epochMs: number | null): string | null {
  return epochMs === null || epochMs <= 0
    ? null
    : new Date(epochMs).toISOString();
}
