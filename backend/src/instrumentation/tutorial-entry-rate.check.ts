import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TutorialStore } from '../tutorial/tutorial.store';
import { toSaoPauloDay } from '../tutorial/tutorial-day';
import type { HealthCheck } from './health-check.contract';
import type { HealthCheckObservation } from './health-check.store';
import { HealthCheckName, scopedCheckName } from './health-check.types';
import { PlanApiClient } from './plan-api.client';
import { PlanApiError } from './plan-api.errors';
import { parseServerOverview } from './plan-server-overview';
import { PlanServersConfig, type PlanServer } from './plan-servers.config';

/**
 * Pinned to 7 days for the same reason as `network-to-survival.check`: Plan only
 * offers `last_7_days` on this endpoint, and a configurable window would let
 * someone compare a 30-day numerator against a 7-day denominator.
 */
const WINDOW_DAYS = 7;
const MS_PER_DAY = 86_400_000;

/** §6.1 proposes 70%. A conservative guess, not a measurement — see the class doc. */
const DEFAULT_MIN_ENTRY_RATE = 0.7;
/** Below this many server arrivals the ratio is noise, not a measurement. */
const DEFAULT_MIN_SAMPLE = 20;

/**
 * How many newcomers to the server actually start the tutorial? (spec §6.1)
 *
 * ## The seventh check, and the one that matters most
 *
 * This is the check that would have caught the longest outage this server ever
 * had: the tutorial stopped capturing newcomers in **dec/2025** and the entry
 * rate fell from ~100% to 12% over **eight months**, with nobody noticing. Story
 * S6.3 shipped six of seven and left this one out because Plan collects nothing
 * about the tutorial; ADR-0004 and story S8.0 built the source, and this closes
 * the set.
 *
 * ## Two sources that fail in different ways, and both failures are reported
 *
 * - **Numerator** — tutorial entrants, from `tutorial_daily`, which the S8.0 ETL
 *   rebuilds nightly from the game machine's `Quests/playerdata`.
 * - **Denominator** — server arrivals, from `serverOverview.last_7_days`, over
 *   the API (the ADR-002 default path).
 *
 * ## A stale numerator is worse than a missing one, and is the trap here
 *
 * The two sources refresh on different clocks: the denominator is fetched live,
 * the numerator is whatever the last nightly ETL wrote. If the ETL stops, the
 * numerator **freezes** while the denominator keeps moving — and a frozen
 * numerator over a growing denominator is a ratio that falls on its own.
 *
 * That would fire this alert, blame the tutorial, and be wrong: the tutorial
 * would be fine and the *measurement* would be broken. It is the same class of
 * mistake as the one that opened the `HANDOFF.md` — reading a plugin-derived
 * series as if it described reality — pointed at ourselves.
 *
 * So the freshness of the ETL is checked **before** the ratio is computed, and a
 * stale source produces `error` naming the ETL, never `breached` naming the
 * tutorial. `error` rather than `no_data` because only `error` is notifiable: a
 * measurement pipeline that has stopped has to reach Discord, which is the
 * failure this whole epic was built around.
 *
 * ## The threshold, and what the spec's "3 days" became
 *
 * §6.1 words the condition as *"below 70% for 3 days"*. The three-day clause is
 * there to stop a single bad day from alerting, and it was written for a daily
 * metric. This check measures a **7-day window**, which already smooths a single
 * day out — a one-day dip cannot drag the weekly rate under the floor unless it
 * is severe. The substitution is deliberate and stated rather than silently
 * equated; what is not implemented is a separate "N consecutive evaluations"
 * counter, and the alert policy's re-alert grouping covers the noise the clause
 * was worried about.
 *
 * **The floor itself is an uncalibrated guess**, exactly like the three from
 * S6.3, and is marked as such in `.env.example`. The historical entry rate was
 * ~100% before dec/2025 and 12% at its worst, so 70% sits in a wide gap — but
 * "wide gap" is not calibration, and the baseline in `ops/baseline/` is what
 * would turn it into one.
 */
@Injectable()
export class TutorialEntryRateCheck implements HealthCheck {
  readonly name = HealthCheckName.TutorialEntryRate;

  private readonly minEntryRate: number;
  private readonly minSample: number;

  constructor(
    private readonly plan: PlanApiClient,
    private readonly servers: PlanServersConfig,
    private readonly tutorial: TutorialStore,
    config: ConfigService,
  ) {
    this.minEntryRate =
      config.get<number>('FUNNEL_MIN_TUTORIAL_ENTRY_RATE') ??
      DEFAULT_MIN_ENTRY_RATE;
    this.minSample =
      config.get<number>('FUNNEL_MIN_SAMPLE') ?? DEFAULT_MIN_SAMPLE;
  }

  async run(): Promise<HealthCheckObservation[]> {
    const backends = this.servers.backends();
    if (backends.length === 0) {
      return [];
    }

    const windowStart = Date.now() - WINDOW_DAYS * MS_PER_DAY;
    const fromDay = toSaoPauloDay(windowStart);
    if (fromDay === null) {
      // Unreachable in practice — `Date.now()` is always a usable epoch — but
      // returning a verdict beats letting a null flow into a query.
      return backends.map((server) =>
        this.errorFor(server, 'nao foi possivel calcular a janela de 7 dias'),
      );
    }

    // Both numerator reads are shared across backends, so they happen once.
    let entered: number;
    let sourceAge: SourceFreshness;
    try {
      sourceAge = await this.tutorialFreshness();
      if (sourceAge.problem !== null) {
        // `error`, not `no_data`, and the difference is the whole point:
        // `NOTIFIABLE_STATUSES` contains `error` and not `no_data`, so a stale
        // ETL reported as `no_data` would sit in the table unannounced. A
        // measurement pipeline that has stopped is exactly what has to reach
        // Discord — it is the failure this epic was built around.
        return backends.map((server) =>
          this.errorFor(server, sourceAge.problem as string),
        );
      }
      entered = await this.tutorial.enteredSince(fromDay);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return backends.map((server) =>
        this.errorFor(
          server,
          `nao foi possivel ler o funil do tutorial: ${reason}`,
        ),
      );
    }

    return Promise.all(
      backends.map((server) => this.evaluate(server, entered, fromDay)),
    );
  }

  /**
   * Is the tutorial series recent enough to be compared against a live number?
   *
   * Returns a `problem` string when it is not. The tolerance is the window
   * itself: a series older than seven days cannot describe a seven-day window,
   * and comparing it against a live denominator would manufacture a falling
   * ratio out of a stopped job.
   */
  private async tutorialFreshness(): Promise<SourceFreshness> {
    const last = await this.tutorial.lastSuccessfulSync();

    if (last === null) {
      return {
        problem:
          'o ETL do tutorial nunca rodou com sucesso — sem numerador. Confira ' +
          'TUTORIAL_SYNC_ENABLED e os diretorios da fonte.',
      };
    }

    const ageMs = Date.now() - last.ranAt.getTime();
    const ageDays = Math.floor(ageMs / MS_PER_DAY);
    if (ageMs > WINDOW_DAYS * MS_PER_DAY) {
      return {
        problem:
          `o ETL do tutorial nao roda com sucesso ha ${ageDays} dia(s), mais que a ` +
          `janela de ${WINDOW_DAYS} — um numerador congelado contra um denominador ` +
          'vivo produz uma taxa que cai sozinha, e o problema seria a medicao, ' +
          'nao o tutorial.',
      };
    }

    return { problem: null };
  }

  private async evaluate(
    server: PlanServer,
    entered: number,
    fromDay: string,
  ): Promise<HealthCheckObservation> {
    const checkName = scopedCheckName(this.name, server.name);
    const context = {
      server: server.name,
      janela_dias: WINDOW_DAYS,
      desde: fromDay,
    };

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

    const arrivals = parsed.value.last7Days.newPlayers;
    if (arrivals === null) {
      // Plan reported no measurement. Treating that as zero would divide by it.
      return {
        checkName,
        status: 'no_data',
        detail: {
          summary:
            `O Plan nao reportou chegadas novas em ${server.name} — sem ` +
            'denominador para a taxa de entrada no tutorial',
          context,
        },
      };
    }

    if (arrivals < this.minSample) {
      return {
        checkName,
        status: 'no_data',
        detail: {
          summary:
            `Apenas ${arrivals} chegada(s) em ${server.name} em ${WINDOW_DAYS} ` +
            `dias — abaixo do minimo de ${this.minSample} para publicar uma taxa`,
          n: arrivals,
          context,
        },
      };
    }

    const rate = entered / arrivals;
    const percent = Math.round(rate * 1000) / 10;
    const thresholdPercent = Math.round(this.minEntryRate * 1000) / 10;

    const common = {
      observed: percent,
      threshold: thresholdPercent,
      // The denominator travels with the ratio, always.
      n: arrivals,
      context: { ...context, entraram_no_tutorial: entered },
    };

    if (rate < this.minEntryRate) {
      return {
        checkName,
        status: 'breached',
        detail: {
          ...common,
          summary:
            `${percent}% das ${arrivals} chegadas em ${server.name} entraram no ` +
            `tutorial em ${WINDOW_DAYS} dias (minimo ${thresholdPercent}%) — ` +
            'foi assim que o tutorial parou de capturar novatos por 8 meses',
        },
      };
    }

    return {
      checkName,
      status: 'ok',
      detail: {
        ...common,
        summary:
          `${percent}% das ${arrivals} chegadas em ${server.name} entraram no ` +
          `tutorial em ${WINDOW_DAYS} dias`,
      },
    };
  }

  private errorFor(server: PlanServer, reason: string): HealthCheckObservation {
    return {
      checkName: scopedCheckName(this.name, server.name),
      status: 'error',
      detail: { summary: reason, context: { server: server.name } },
    };
  }
}

/** Whether the tutorial series is recent enough to be compared. */
interface SourceFreshness {
  /** Null when fresh; otherwise why it cannot be used. */
  problem: string | null;
}
