import { Injectable, Logger } from '@nestjs/common';
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
 * How stale the tutorial series may be before the ratio is refused.
 *
 * **Sized to the ETL's period, not to the comparison window**, and the first
 * version of this check got that wrong in a way that mattered. It allowed the
 * source to be as old as the window itself, on the reasoning that "a series
 * older than seven days cannot describe a seven-day window". True, but far too
 * late: the numerator freezes while `fromDay` advances every night, so the ratio
 * **decays continuously from the very first missed run** — by the time seven
 * days have passed, most of the decay has already happened and the alert has
 * already fired blaming the tutorial. That is precisely the trap this check
 * documents itself as avoiding.
 *
 * The nightly cron leaves the series at most ~24h old in normal operation, so 36
 * hours means **one missed night is named**, which is the right moment: a
 * stopped ETL is a problem in its own right, and every hour past it makes the
 * ratio more wrong.
 */
const DEFAULT_MAX_SYNC_AGE_HOURS = 36;
const MS_PER_HOUR = 3_600_000;

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
 * ## ⚠️ The two sides do not count exactly the same population
 *
 * Stated rather than smoothed over, because a ratio built from two series of
 * different provenance is the composition that produced errors 1, 2 and 3 of the
 * five in `HANDOFF.md` — and the lesson written there ("a series derived from a
 * plugin measures that plugin, not reality") applies to this check as much as to
 * anything it watches.
 *
 * | | numerator | denominator |
 * |---|---|---|
 * | source | `Quests/playerdata` via ETL | Plan `/v1/serverOverview` |
 * | scope | the **network** | **this backend** |
 * | who counts | anyone whose earliest tutorial `started-date` falls in the window | players new to this server in the window |
 * | window | 7 calendar days, America/Sao_Paulo | Plan's rolling `last_7_days` |
 *
 * In practice the two nearly coincide, because a player's earliest tutorial
 * start is normally the week they arrived and the tutorial belongs to Survival.
 * But they can diverge — a player who reached the network earlier and only now
 * got to the tutorial counts in the numerator and not the denominator — and the
 * ratio **can exceed 100%**. When it does, the verdict says so in words instead
 * of publishing a tidy-looking percentage.
 *
 * The calendar-day/rolling-window mismatch at the boundary is the same known
 * imprecision `network-to-survival.check` records: small on a weekly window and
 * constant across cycles, so trend movement stays meaningful while the absolute
 * number should not be quoted to the decimal.
 *
 * ## One numerator, N backends
 *
 * The numerator is network-wide and is divided by **each** configured backend.
 * That is sound while the tutorial belongs to one server, which is the case
 * today (§6.1 words the check as `novatos_no_survival`). Configure a second
 * backend and the same entrants are counted against both — so the check logs a
 * warning rather than quietly publishing two ratios that share a numerator.
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

  private readonly logger = new Logger(TutorialEntryRateCheck.name);
  private readonly minEntryRate: number;
  private readonly minSample: number;
  private readonly maxSyncAgeMs: number;
  /** So the fan-out warning is said once, not on every cycle. */
  private warnedAboutFanOut = false;

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
    this.maxSyncAgeMs =
      (config.get<number>('TUTORIAL_MAX_SYNC_AGE_HOURS') ??
        DEFAULT_MAX_SYNC_AGE_HOURS) * MS_PER_HOUR;
  }

  async run(): Promise<HealthCheckObservation[]> {
    const backends = this.servers.backends();
    if (backends.length === 0) {
      return [];
    }

    if (backends.length > 1 && !this.warnedAboutFanOut) {
      // Once, not per cycle: this is a configuration observation, and repeating
      // it every fifteen minutes would train whoever reads the log to skip it.
      this.warnedAboutFanOut = true;
      this.logger.warn(
        `${backends.length} backends configurados, mas o numerador do tutorial e ` +
          'de REDE — as mesmas entradas serao divididas por cada servidor. A ' +
          'secao 6.1 redige este check como `novatos_no_survival`; enquanto o ' +
          'tutorial pertencer a um servidor so, a razao dos demais nao significa ' +
          'nada.',
      );
    }

    const now = Date.now();
    // `WINDOW_DAYS - 1` because both ends are inclusive: today minus six, through
    // today, is seven calendar days. Subtracting the full seven would count
    // eight and inflate the numerator against a seven-day denominator.
    //
    // ⚠️ Dormant edge, recorded rather than fixed: this subtracts *milliseconds*
    // and then converts to a calendar day, so a DST transition inside the window
    // shifts the boundary and the span becomes 8. Brazil has had no DST since
    // 2019 and the tzdb agrees, so it cannot fire today — but it would return
    // with DST, and the fix is to derive `fromDay` from the local date rather
    // than from an epoch offset.
    const fromDay = toSaoPauloDay(now - (WINDOW_DAYS - 1) * MS_PER_DAY);
    const toDay = toSaoPauloDay(now);
    if (fromDay === null || toDay === null) {
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
      entered = await this.tutorial.enteredBetween(fromDay, toDay);
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
   * Returns a `problem` string when it is not. The tolerance is the **ETL's
   * period**, not the comparison window — see {@link DEFAULT_MAX_SYNC_AGE_HOURS}
   * for why the difference is the whole point.
   *
   * ## What this does NOT catch, stated because the ADR introduced it
   *
   * It measures when the ETL last *ran successfully*, not how fresh the files it
   * read were. ADR-0004 recommends `rsync`, so a nightly ETL over a mirror that
   * stopped updating has a fresh `ranAt` and a frozen numerator, and sails
   * through here. Closing that needs a freshness signal from the copy itself,
   * which the ADR leaves as an operations decision.
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

    if (ageMs < 0) {
      // `ranAt` is stamped by Postgres (`defaultNow()`) and compared against
      // this process's clock. `CLAUDE.md` puts the database on a shared
      // instance, so they are not guaranteed to be the same host.
      //
      // A future `ranAt` makes `ageMs` negative, which passes every `>` test
      // below and **switches the freshness gate off entirely** — the check then
      // publishes a ratio from an arbitrarily stale source. Refusing is the only
      // safe reading: a clock we cannot trust is a freshness answer we do not
      // have. The project already treats NTP skew as blocking for
      // `purchased_at`; this is the same exposure.
      return {
        problem:
          `o ultimo sync do tutorial esta ${Math.round(-ageMs / 1000)}s no FUTURO ` +
          '— os relogios do Postgres e desta aplicacao divergem, entao a idade da ' +
          'fonte nao pode ser conferida. Confira o NTP das duas maquinas.',
      };
    }

    if (ageMs > this.maxSyncAgeMs) {
      const ageHours = Math.floor(ageMs / MS_PER_HOUR);
      const toleranceHours = Math.floor(this.maxSyncAgeMs / MS_PER_HOUR);
      return {
        problem:
          `o ETL do tutorial nao roda com sucesso ha ${ageHours}h (tolerancia ` +
          `${toleranceHours}h) — a serie congela enquanto a janela anda, entao a ` +
          'taxa cai sozinha a partir da primeira noite perdida. O problema aqui e ' +
          'a medicao, nao o tutorial.',
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

    if (rate > 1) {
      // Above 100% the two sides have visibly stopped describing the same
      // population, and saying "130% entraram no tutorial" as if it were a clean
      // reading is the kind of number this project has been burned by. Still
      // `ok` — whatever else is true, entry is not collapsing — but the summary
      // names the skew instead of dressing it as a result.
      return {
        checkName,
        status: 'ok',
        detail: {
          ...common,
          summary:
            `${entered} entradas no tutorial contra ${arrivals} chegadas em ` +
            `${server.name} em ${WINDOW_DAYS} dias — razao acima de 100%, o que ` +
            'significa que os dois lados nao estao contando a mesma populacao ' +
            '(o numerador e de rede e o denominador e deste servidor). Entrada ' +
            'nao esta caindo; a razao e que nao deve ser lida como percentual.',
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
