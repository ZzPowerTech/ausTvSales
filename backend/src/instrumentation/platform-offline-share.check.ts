import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { HealthCheck } from './health-check.contract';
import type { HealthCheckObservation } from './health-check.store';
import { HealthCheckName } from './health-check.types';
import { PlanApiClient } from './plan-api.client';
import { PlanApiError } from './plan-api.errors';
import { Platform, platformOf } from './platform';
import { PlanServersConfig } from './plan-servers.config';

const DEFAULT_WINDOW_DAYS = 7;
/**
 * Ceiling for the offline share among arrivals, calibrated 2026-08-29.
 *
 * The first value shipped was 0.5, marked in `.env.example` as a conservative
 * guess rather than a measurement. Production then measured it, the hard way:
 * on 2026-08-26 the check read 51,5% (17/33), 50,0% (16/32) and 51,6% (16/31)
 * within two hours and announced each one. The threshold had been set exactly
 * on top of the real distribution, so a single player crossing it flipped the
 * verdict.
 *
 * The reading itself is the calibration: the real share is ~51% and stable, so
 * the ceiling belongs above the band, not inside it. 0.65 leaves roughly 14
 * points of headroom — wide enough that ordinary variation is quiet, narrow
 * enough that the bot-registration surge this check exists to catch (which
 * would push the share toward 1.0, not toward 0.55) still trips it.
 */
const DEFAULT_MAX_SHARE = 0.65;
/** Below this many arrivals the share is noise, not a trend. */
const DEFAULT_MIN_SAMPLE = 20;
const MS_PER_DAY = 86_400_000;

/**
 * Is the share of offline accounts climbing out of its usual band? (spec §6.1)
 *
 * ## What it is really watching
 *
 * `java_offline` converts network → survival at **39,3%** against Bedrock's
 * **71,5%**. That gap is the signature of bot traffic: connections that arrive,
 * are counted as acquisition, and never become players. A marketing decision
 * taken on an acquisition number inflated that way is a decision taken on a
 * number that is not real.
 *
 * ## Window, not stock — and the reason is written down
 *
 * `playersTable` returns every player ever registered. Computing the share over
 * that is the exact trap the investigation already fell into: the all-time mix
 * (59,2% Bedrock) is **not** the current mix, and the project rule from that
 * lesson is that a platform number without an explicit window is meaningless.
 *
 * So this check filters by `registered` and measures **arrivals in the window**.
 * That is also what "crescimento anormal" in the spec means: growth, not stock.
 *
 * ## Small samples are refused, not reported
 *
 * With a handful of arrivals the share swings wildly — 2 of 3 is 67% and means
 * nothing. Below {@link DEFAULT_MIN_SAMPLE} the verdict is `no_data`, never a
 * percentage. The project rule is `n` beside every percentage; this goes one step
 * further and refuses to publish the percentage at all when `n` cannot support it.
 */
@Injectable()
export class PlatformOfflineShareCheck implements HealthCheck {
  readonly name = HealthCheckName.OfflineAccountShare;

  private readonly windowDays: number;
  private readonly maxShare: number;
  private readonly minSample: number;

  constructor(
    private readonly plan: PlanApiClient,
    private readonly servers: PlanServersConfig,
    config: ConfigService,
  ) {
    this.windowDays =
      config.get<number>('PLATFORM_OFFLINE_WINDOW_DAYS') ?? DEFAULT_WINDOW_DAYS;
    this.maxShare =
      config.get<number>('PLATFORM_OFFLINE_SHARE_MAX') ?? DEFAULT_MAX_SHARE;
    this.minSample =
      config.get<number>('PLATFORM_OFFLINE_MIN_SAMPLE') ?? DEFAULT_MIN_SAMPLE;
  }

  async run(): Promise<HealthCheckObservation[]> {
    const backends = this.servers.backends();
    return Promise.all(backends.map((server) => this.evaluate(server.name)));
  }

  private async evaluate(server: string): Promise<HealthCheckObservation> {
    const checkName = `${this.name}:${server}`;

    let body: unknown;
    try {
      body = await this.plan.getJson('v1/playersTable', { server });
    } catch (error) {
      const reason =
        error instanceof PlanApiError ? error.message : String(error);
      return {
        checkName,
        status: 'error',
        detail: {
          summary: `Nao foi possivel consultar o Plan: ${reason}`,
          context: { server },
        },
      };
    }

    const players = extractPlayers(body);
    if (players === null) {
      return {
        checkName,
        status: 'error',
        detail: {
          summary:
            'Resposta do Plan em formato inesperado: `players` ausente ou nao e lista',
          context: { server },
        },
      };
    }

    const since = Date.now() - this.windowDays * MS_PER_DAY;
    const arrivals = players.filter(
      (player) => player.registered !== null && player.registered >= since,
    );

    if (arrivals.length < this.minSample) {
      return {
        checkName,
        status: 'no_data',
        detail: {
          summary:
            `Apenas ${arrivals.length} chegada(s) em ${this.windowDays} dia(s) — ` +
            `amostra abaixo do minimo de ${this.minSample} para publicar um percentual`,
          n: arrivals.length,
          context: { server, janela_dias: this.windowDays },
        },
      };
    }

    const offline = arrivals.filter(
      (player) => platformOf(player.uuid) === Platform.JavaOffline,
    ).length;
    const share = offline / arrivals.length;
    const percent = Math.round(share * 1000) / 10;

    const common = {
      observed: percent,
      threshold: Math.round(this.maxShare * 1000) / 10,
      // Never a percentage without its base — and here the base is also the
      // thing that decides whether the percentage was allowed to exist at all.
      n: arrivals.length,
      context: {
        server,
        janela_dias: this.windowDays,
        offline,
        bedrock: countOf(arrivals, Platform.Bedrock),
        java_premium: countOf(arrivals, Platform.JavaPremium),
        desconhecido: countOf(arrivals, Platform.Unknown),
      },
    };

    if (share > this.maxShare) {
      return {
        checkName,
        status: 'breached',
        detail: {
          ...common,
          summary:
            `${percent}% das ${arrivals.length} chegadas de ${this.windowDays} dia(s) ` +
            `sao java_offline (limite ${common.threshold}%) — possivel trafego de bot ` +
            'inflando a aquisicao',
        },
      };
    }

    return {
      checkName,
      status: 'ok',
      detail: {
        ...common,
        summary:
          `${percent}% das ${arrivals.length} chegadas de ${this.windowDays} dia(s) ` +
          'sao java_offline',
      },
    };
  }
}

interface PlayerRow {
  uuid: string | null;
  registered: number | null;
}

function countOf(players: readonly PlayerRow[], platform: Platform): number {
  return players.filter((player) => platformOf(player.uuid) === platform)
    .length;
}

/**
 * Pull the two fields this check needs out of the `playersTable` payload.
 *
 * Returns `null` when the envelope itself is wrong, so the caller can report
 * `error` instead of computing a share over an empty list — which would look
 * like a healthy 0%.
 */
function extractPlayers(body: unknown): PlayerRow[] | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }

  const players = (body as Record<string, unknown>).players;
  if (!Array.isArray(players)) {
    return null;
  }

  return players.map((raw) => {
    const row = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<
      string,
      unknown
    >;
    return {
      uuid: typeof row.playerUUID === 'string' ? row.playerUUID : null,
      registered:
        typeof row.registered === 'number' && Number.isFinite(row.registered)
          ? row.registered
          : null,
    };
  });
}
