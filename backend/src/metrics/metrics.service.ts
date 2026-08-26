import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PlanApiClient } from '../instrumentation/plan-api.client';
import { PlanServersConfig } from '../instrumentation/plan-servers.config';
import { parseServerOverview } from '../instrumentation/plan-server-overview';
import type {
  ConfiguredServersDto,
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
 * surface here as a confusing upstream error rather than an honest "that is not
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
   * Configuration rather than discovery, because Plan exposes no catalogue:
   * `/v1/servers` and `/v1/networkOverview` both answer 404 (verified
   * 2026-08-23). The cost is stated in `PlanServersConfig`.
   */
  configuredServers(): ConfiguredServersDto {
    return {
      servers: this.servers.all().map((server) => ({
        name: server.name,
        proxy: server.proxy,
      })),
    };
  }

  /** Point-in-time view of one server, from `/v1/serverOverview`. */
  async serverOverview(
    name: string,
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
          throw new Error(`resposta do Plan nao reconhecida: ${parsed.reason}`);
        }
        return parsed.value;
      },
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
              // The base of the 7-day retention is the arrivals of the same
              // window — the number this payload already carries. Never derived
              // from the percentage Plan also prints.
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
          throw new Error(`resposta do Plan nao reconhecida: ${parsed.reason}`);
        }
        return parsed.value;
      },
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
   * is `Survival` earns a 403 from Plan that would look like an outage here.
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
    reason: result.reason,
  };
}

/** Both failure outcomes leave as 503; they differ in whether `data` is null. */
function isDegraded(result: CacheResult<unknown>): boolean {
  return result.outcome === 'stale' || result.outcome === 'unavailable';
}

/** Epoch ms to ISO-8601, keeping "not reported" as null rather than epoch zero. */
function toIso(epochMs: number | null): string | null {
  return epochMs === null ? null : new Date(epochMs).toISOString();
}
