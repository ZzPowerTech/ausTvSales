import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { HealthCheck } from './health-check.contract';
import type { HealthCheckObservation } from './health-check.store';
import { HealthCheckName, scopedCheckName } from './health-check.types';
import { PlanApiClient } from './plan-api.client';
import { PlanApiError } from './plan-api.errors';
import { PlanDatabase } from './plan-database';
import { parseServerOverview } from './plan-server-overview';
import { PlanServersConfig, type PlanServer } from './plan-servers.config';

/**
 * Pinned to 7 days, not configurable, and that is a constraint rather than a
 * shortcut — see the class doc.
 */
const WINDOW_DAYS = 7;
const MS_PER_DAY = 86_400_000;

const DEFAULT_MIN_CONVERSION = 0.3;
/** Below this many network arrivals the ratio is noise, not a measurement. */
const DEFAULT_MIN_SAMPLE = 20;

/**
 * How many of the people who reach the network reach a backend? (spec §6.2)
 *
 * ## The step nobody was measuring
 *
 * The 2026-08-21 investigation found that **54% of everyone who connects to the
 * network never reaches survival** — a funnel step that had never been measured
 * because nothing compared the two sides. Historically the conversion sat around
 * **46%**. This check turns that one-off finding into a continuous signal.
 *
 * ## Two sources, and why
 *
 * The numerator and denominator live in different places, and neither side can
 * produce both:
 *
 * - **Network arrivals** come from `plan_users` (ADR-002 exception 2). The proxy
 *   records users, not sessions, so no session-derived endpoint can supply it.
 * - **Backend arrivals** come from `serverOverview.last_7_days.new_players` over
 *   the API, which is the ADR-002 default path.
 *
 * ## Why the window is 7 days and not configurable
 *
 * Plan only offers `last_7_days` on this endpoint. Making the window a setting
 * would let someone configure 30 days and silently compare a 30-day numerator
 * against a 7-day denominator — a ratio that looks fine and means nothing. The
 * constraint belongs to the data source, so it is encoded, not exposed.
 *
 * **Known imprecision, stated rather than hidden:** Plan's `last_7_days` and this
 * check's `now - 7d` may not align exactly at the boundary. The effect is small
 * on a weekly window and constant across cycles, so trend movement stays
 * meaningful — but the absolute number should not be quoted to the decimal.
 */
@Injectable()
export class NetworkToSurvivalCheck implements HealthCheck {
  readonly name = HealthCheckName.NetworkToSurvival;

  private readonly minConversion: number;
  private readonly minSample: number;

  constructor(
    private readonly plan: PlanApiClient,
    private readonly db: PlanDatabase,
    private readonly servers: PlanServersConfig,
    config: ConfigService,
  ) {
    this.minConversion =
      config.get<number>('FUNNEL_MIN_NETWORK_TO_SERVER') ??
      DEFAULT_MIN_CONVERSION;
    this.minSample =
      config.get<number>('FUNNEL_MIN_SAMPLE') ?? DEFAULT_MIN_SAMPLE;
  }

  async run(): Promise<HealthCheckObservation[]> {
    const backends = this.servers.backends();
    if (backends.length === 0) {
      return [];
    }

    // The denominator is shared, so it is fetched once rather than once per
    // backend — one query instead of N against the game's database.
    let networkArrivals: number | null;
    try {
      const since = Date.now() - WINDOW_DAYS * MS_PER_DAY;
      networkArrivals = (await this.db.networkArrivals(since)).total;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return backends.map((server) => ({
        checkName: scopedCheckName(this.name, server.name),
        status: 'error' as const,
        detail: {
          summary: `Nao foi possivel ler as chegadas de rede: ${reason}`,
          context: { server: server.name },
        },
      }));
    }

    if (networkArrivals === null) {
      // The query answered and the count came back in a shape `toNumber` does
      // not read. `error`, not a small sample: a denominator that could not be
      // read is not a denominator of zero, and letting it fall through to the
      // `< minSample` branch below would file a failed read as "quiet week".
      return backends.map((server) => ({
        checkName: scopedCheckName(this.name, server.name),
        status: 'error' as const,
        detail: {
          summary:
            'A contagem de chegadas de rede veio num formato ilegivel — sem ' +
            'denominador, nenhuma conversao pode ser calculada',
          context: { server: server.name },
        },
      }));
    }

    return Promise.all(
      backends.map((server) => this.evaluate(server, networkArrivals)),
    );
  }

  private async evaluate(
    server: PlanServer,
    networkArrivals: number,
  ): Promise<HealthCheckObservation> {
    const checkName = scopedCheckName(this.name, server.name);
    const context = { server: server.name, janela_dias: WINDOW_DAYS };

    if (networkArrivals < this.minSample) {
      return {
        checkName,
        status: 'no_data',
        detail: {
          summary:
            `Apenas ${networkArrivals} chegada(s) de rede em ${WINDOW_DAYS} dias — ` +
            `abaixo do minimo de ${this.minSample} para publicar uma conversao`,
          n: networkArrivals,
          context,
        },
      };
    }

    let body: unknown;
    try {
      body = await this.plan.getJson('v1/serverOverview', {
        server: server.name,
      });
    } catch (error) {
      const reason =
        error instanceof PlanApiError ? error.message : String(error);
      return {
        checkName,
        status: 'error',
        detail: {
          summary: `Nao foi possivel consultar o Plan: ${reason}`,
          context,
        },
      };
    }

    const parsed = parseServerOverview(body);
    if (!parsed.ok) {
      return {
        checkName,
        status: 'error',
        detail: {
          summary: `Resposta do Plan em formato inesperado: ${parsed.reason}`,
          context,
        },
      };
    }

    const serverArrivals = parsed.value.last7Days.newPlayers;
    if (serverArrivals === null) {
      // Plan reported no measurement for the numerator. Treating that as zero
      // would publish a 0% conversion — an alarming number invented out of a
      // gap, which is the failure this epic exists to prevent.
      return {
        checkName,
        status: 'no_data',
        detail: {
          summary:
            'O Plan nao reportou chegadas novas neste servidor — sem numerador ' +
            'para a conversao',
          n: networkArrivals,
          context,
        },
      };
    }

    const conversion = serverArrivals / networkArrivals;
    const percent = Math.round(conversion * 1000) / 10;
    const thresholdPercent = Math.round(this.minConversion * 1000) / 10;

    const common = {
      observed: percent,
      threshold: thresholdPercent,
      // The denominator travels with the ratio, always.
      n: networkArrivals,
      context: { ...context, chegadas_no_servidor: serverArrivals },
    };

    if (conversion < this.minConversion) {
      return {
        checkName,
        status: 'breached',
        detail: {
          ...common,
          summary:
            `${percent}% das ${networkArrivals} chegadas de rede alcancaram ` +
            `${server.name} em ${WINDOW_DAYS} dias (minimo ${thresholdPercent}%) — ` +
            'o degrau entre a rede e o servidor piorou',
        },
      };
    }

    return {
      checkName,
      status: 'ok',
      detail: {
        ...common,
        summary:
          `${percent}% das ${networkArrivals} chegadas de rede alcancaram ` +
          `${server.name} em ${WINDOW_DAYS} dias`,
      },
    };
  }
}
