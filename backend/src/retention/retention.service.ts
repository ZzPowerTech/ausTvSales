import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PlanApiClient } from '../instrumentation/plan-api.client';
import { PlanNotConfiguredError } from '../instrumentation/plan-api.errors';
import { PlanCache } from '../metrics/plan-cache';
import { toSaoPauloDay } from '../tutorial/tutorial-day';
import {
  parseRetention,
  type ParsedRetention,
  type RetentionPlayer,
} from './plan-retention';
import {
  applyContaminatedSpan,
  buildCohorts,
  detectContaminatedSpan,
  detectStampDays,
} from './retention-math';
import {
  RETENTION_HORIZON_DAYS,
  RETENTION_SEMANTICS,
  horizonLabel,
  type CohortPlatformFilter,
  type CohortRetention,
  type ContaminatedSpan,
  type RetentionReport,
  type RetentionSourceFailure,
  type RetentionSourceState,
  type StampDay,
} from './retention.types';

/** Path of the single endpoint this module reads. */
const RETENTION_PATH = '/v1/retention';

/** Cache key. One payload, no per-request variation — the window is applied here. */
const CACHE_KEY = 'retention:v1';

/** Defaults, all overridable. Documented in `.env.example` as uncalibrated. */
const DEFAULT_MIN_COHORT_SIZE = 30;
const DEFAULT_STAMP_DAY_MIN_SHARE = 0.1;
const DEFAULT_STAMP_DAY_MIN_POPULATION = 200;
const DEFAULT_CONTAMINATION_MAX = 0.5;
/**
 * Five minutes.
 *
 * Spec §8 requires a TTL cache in front of `/v1/*` as a **mitigation**, not an
 * optimisation: this module pulls the entire 5.565-row payload on every request
 * and the dashboard throttle allows 120 of those per window per caller, against
 * a webserver that runs inside the Minecraft process. Cohort retention moves on
 * the scale of days, so five minutes costs the reader nothing.
 */
const DEFAULT_CACHE_TTL_SECONDS = 300;

/**
 * Cohort retention by month × platform (story S8.2, spec §6.2).
 *
 * ## This module does **not** open exception 1 of ADR-002
 *
 * The story was written on the assumption that cohort retention needed direct
 * SQL against Plan's tables, and the plan of record listed that as *"o único
 * ponto do sistema autorizado a fazer SQL direto"*. Reading `/v1/retention` on
 * 2026-08-29 removed the premise: the endpoint carries `registerDate` (the
 * cohort) and `playerUUID` (the platform, by ADR-003), which are exactly the two
 * axes §6.2 asks for.
 *
 * So there is no MySQL connection here, no dedicated read-only account to
 * provision, and no second place in the codebase that knows Plan's schema.
 *
 * ## What the numbers mean, and why the label is in the payload
 *
 * Survival interval, not return-on-day-N. {@link RETENTION_SEMANTICS} says so,
 * and it travels in every response. The two readings are different questions and
 * the endpoint only answers the first; calling it the second would be the
 * denominator error this epic has already paid for once.
 *
 * ## Horizons are bounded by the data, never by the clock
 *
 * The single most dangerous thing this module could do — and did, in its first
 * version — is measure maturity against wall-clock time while measuring survival
 * against `lastSeenDate`. When collection stalls, the calendar keeps making
 * players eligible while none of them can be observed surviving, and the ratio
 * falls to zero for reasons that have nothing to do with players. `dataThrough`
 * is what bounds eligibility now, and a horizon it cannot reach comes back
 * `source_stale`, never `0.0%`.
 *
 * ## Degradation
 *
 * Plan unreachable, misconfigured, or answering a shape this module does not
 * know produces a report with **no cohorts and a named failure**, never a report
 * of zeroes. When Plan fails and a previous payload is cached, that payload is
 * served **marked stale with its age**, which is better than nothing and is only
 * acceptable because the mark travels with it.
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  private readonly minimumCohortSize: number;
  private readonly stampDayMinShare: number;
  private readonly stampDayMinPopulation: number;
  private readonly contaminationMax: number;
  private readonly cacheTtlMs: number;

  constructor(
    private readonly plan: PlanApiClient,
    private readonly cache: PlanCache,
    config: ConfigService,
  ) {
    this.minimumCohortSize =
      config.get<number>('RETENTION_MIN_COHORT_SIZE') ??
      DEFAULT_MIN_COHORT_SIZE;
    this.stampDayMinShare =
      config.get<number>('RETENTION_STAMP_DAY_MIN_SHARE') ??
      DEFAULT_STAMP_DAY_MIN_SHARE;
    this.stampDayMinPopulation =
      config.get<number>('RETENTION_STAMP_DAY_MIN_POPULATION') ??
      DEFAULT_STAMP_DAY_MIN_POPULATION;
    this.contaminationMax =
      config.get<number>('RETENTION_COHORT_CONTAMINATION_MAX') ??
      DEFAULT_CONTAMINATION_MAX;
    this.cacheTtlMs =
      (config.get<number>('RETENTION_CACHE_TTL_SECONDS') ??
        DEFAULT_CACHE_TTL_SECONDS) * 1000;
  }

  /**
   * Build the cohort report between two months, inclusive.
   *
   * @param fromMonth `YYYY-MM`
   * @param toMonth `YYYY-MM`
   * @param platform `'all'` keeps every platform as its own row; anything else
   *   filters to it. Note that `all` does **not** sum platforms into one row —
   *   the whole point of the segmentation is that Bedrock and Java behave
   *   differently, and a summed row would hide exactly that.
   */
  async report(
    fromMonth: string,
    toMonth: string,
    platform: CohortPlatformFilter = 'all',
  ): Promise<RetentionReport> {
    const evaluatedAt = Date.now();

    const loaded = await this.load();
    if (!loaded.ok) {
      return this.emptyReport(fromMonth, toMonth, evaluatedAt, loaded.state);
    }

    const players = loaded.parsed.players;

    // Stamp detection runs over the WHOLE payload, not over the requested
    // window. An import stamp is a property of the dataset, and a request for
    // three months would otherwise be unable to see that the run it lands on is
    // shared by five thousand players outside the window.
    const stampDays = detectStampDays(
      players,
      this.stampDayMinShare,
      this.stampDayMinPopulation,
    );

    // Cohorts are built over the WHOLE payload and the window is applied to the
    // result, not to the players. Filtering first is equivalent for every number
    // in a cohort — the grouping is by month and nothing crosses cohorts — but
    // it is NOT equivalent for the artefact detectors, which reason about the
    // dataset. `2024-09..2025-01` contains no cohort large enough to judge, and
    // judging that window in isolation publishes fifteen cohorts at 100%.
    const all = buildCohorts(players, {
      evaluatedAt,
      dataThrough: latestEpoch(players),
      stampDays,
      minimumCohortSize: this.minimumCohortSize,
      contaminationMax: this.contaminationMax,
    });

    const spanned = applyContaminatedSpan(all, detectContaminatedSpan(all));

    const cohorts = spanned.cohorts.filter(
      (cohort) =>
        cohort.cohort >= fromMonth &&
        cohort.cohort <= toMonth &&
        (platform === 'all' || cohort.platform === platform),
    );

    this.warnOnSuppression(cohorts, stampDays, spanned.span);

    return {
      semantics: RETENTION_SEMANTICS,
      from: fromMonth,
      to: toMonth,
      evaluatedAt: new Date(evaluatedAt).toISOString(),
      minimumCohortSize: this.minimumCohortSize,
      stampDays,
      ...(spanned.span === null ? {} : { contaminatedSpan: spanned.span }),
      cohorts,
      ...this.coverageWarning(loaded.state, fromMonth, toMonth, cohorts.length),
      source: loaded.state,
    };
  }

  /**
   * Fetch and parse the payload, turning every failure into a closed label.
   *
   * The fetch goes through `PlanCache`: inside the TTL nothing reaches the game
   * machine at all, and when Plan fails with a previous payload in hand that
   * payload is served marked stale rather than dropped.
   */
  private async load(): Promise<LoadResult> {
    if (!this.plan.configured) {
      return { ok: false, state: this.failed('not_configured', null) };
    }

    const result = await this.cache.read<unknown>(
      CACHE_KEY,
      this.cacheTtlMs,
      () => this.plan.getJson(RETENTION_PATH),
    );

    if (result.outcome === 'unavailable') {
      // The message names the host and sometimes an upstream body. It goes to
      // the log; the response gets a closed label (CWE-209, the same call story
      // S7.2 made for `MetricsFailureReason`).
      const error = result.error;
      this.logger.warn(
        `Retencao por coorte indisponivel: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      // Only two labels here, and that is deliberate: from a reader's point of
      // view "we are misconfigured" and "the game VPS did not answer" send you
      // to different places, while a 403 and a timeout send you to the same one.
      const failure: RetentionSourceFailure =
        error instanceof PlanNotConfiguredError
          ? 'not_configured'
          : 'unreachable';
      return { ok: false, state: this.failed(failure, null) };
    }

    const parsed = parseRetention(result.value);
    if (!parsed.ok) {
      // Loud on purpose. A shape mismatch means a Plan upgrade moved the
      // contract, and the reason names which field went missing — the single
      // most useful line for whoever has to fix it.
      this.logger.error(
        `Contrato de ${RETENTION_PATH} mudou: ${parsed.reason}. Nenhuma coorte ` +
          'foi publicada; a alternativa seria publicar zeros.',
      );
      return { ok: false, state: this.failed('contract_mismatch', null) };
    }

    if (parsed.value.dropped > 0) {
      this.logger.warn(
        `${parsed.value.dropped} de ${parsed.value.rows} linhas de ` +
          `${RETENTION_PATH} foram descartadas por data ou uuid ilegivel. As ` +
          'coortes abaixo cobrem o resto, e o payload publica as duas contagens.',
      );
    }

    const stale = result.outcome === 'stale';
    if (stale) {
      this.logger.warn(
        `Plan fora do ar; servindo o payload anterior de ${RETENTION_PATH} com ` +
          `${result.ageMs ?? 0}ms de idade, marcado como stale no corpo.`,
      );
    }

    return {
      ok: true,
      parsed: parsed.value,
      state: {
        name: 'plan_retention',
        ok: true,
        asOf: (result.storedAt ?? new Date()).toISOString(),
        dataThrough: latestDay(parsed.value.players),
        dataFrom: earliestDay(parsed.value.players),
        rows: parsed.value.rows,
        parsed: parsed.value.players.length,
        dropped: parsed.value.dropped,
        stale,
        ageMs: result.ageMs,
      },
    };
  }

  private failed(
    failure: RetentionSourceFailure,
    rows: number | null,
  ): RetentionSourceState {
    return {
      name: 'plan_retention',
      ok: false,
      asOf: null,
      failure,
      dataThrough: null,
      dataFrom: null,
      rows,
      parsed: null,
      dropped: null,
      stale: false,
      ageMs: null,
    };
  }

  /**
   * Say so when the window falls outside what the source covers.
   *
   * `cohorts: []` beside `source.ok: true` is otherwise indistinguishable from
   * "nobody registered in that period" — a measurement this module never made.
   * PR #180 fixed the same confusion in the funnel with `coversFrom`.
   */
  private coverageWarning(
    state: RetentionSourceState,
    fromMonth: string,
    toMonth: string,
    cohorts: number,
  ): { coverageWarning?: string } {
    if (cohorts > 0 || state.dataFrom === null || state.dataThrough === null) {
      return {};
    }

    const coversFrom = state.dataFrom.slice(0, 7);
    const coversTo = state.dataThrough.slice(0, 7);
    if (toMonth >= coversFrom && fromMonth <= coversTo) {
      // Inside coverage and genuinely empty. That is a real answer.
      return {};
    }

    return {
      coverageWarning:
        `A janela ${fromMonth}..${toMonth} esta fora do que a fonte cobre ` +
        `(${coversFrom}..${coversTo}). A lista vazia NAO significa "ninguem se ` +
        'registrou nesse periodo" — significa que este sistema nao tem como ' +
        'saber. Ver `source.dataFrom` e `source.dataThrough`.',
    };
  }

  /**
   * A report whose only content is why there is none.
   *
   * `cohorts: []` next to `source.ok: false` is the contract: an empty array is
   * never to be read as "no cohorts exist", and the source state is where a
   * consumer finds out which it is.
   */
  private emptyReport(
    fromMonth: string,
    toMonth: string,
    evaluatedAt: number,
    source: RetentionSourceState,
  ): RetentionReport {
    return {
      semantics: RETENTION_SEMANTICS,
      from: fromMonth,
      to: toMonth,
      evaluatedAt: new Date(evaluatedAt).toISOString(),
      minimumCohortSize: this.minimumCohortSize,
      stampDays: [],
      cohorts: [],
      source,
    };
  }

  /**
   * Say out loud when the artifact detector suppressed something.
   *
   * The evidence is already in the payload, but a detector that silently blanks
   * half a report is one configuration mistake away from being indistinguishable
   * from an outage — and the operator would have no reason to look. One log line
   * per read, with the numbers behind the decision.
   */
  private warnOnSuppression(
    cohorts: readonly CohortRetention[],
    stampDays: readonly StampDay[],
    span: ContaminatedSpan | null,
  ): void {
    if (span !== null && span.inheritedCohorts > 0) {
      this.logger.warn(
        `Faixa contaminada ${span.from}..${span.to}: ${span.confirmedCohorts} ` +
          `coorte(s) reprovadas por evidencia propria em ` +
          `${span.confirmedMonths.length} mes(es), e mais ` +
          `${span.inheritedCohorts} coorte(s) (${span.inheritedPlayers} ` +
          'jogadores) suprimidas por heranca — pequenas demais para julgar ' +
          'sozinhas, mesma forma de ~100%, dentro da faixa.',
      );
    }

    const suppressed = cohorts.filter((cohort) => cohort.contamination.suspect);
    if (suppressed.length === 0) {
      return;
    }

    this.logger.warn(
      `${suppressed.length} de ${cohorts.length} coortes tiveram ` +
        `${RETENTION_HORIZON_DAYS.map(horizonLabel).join('/')} suprimidos por ` +
        `carimbo de importacao (limiar ${this.contaminationMax}). Dias ` +
        `detectados: ${
          stampDays.map((stamp) => `${stamp.day} (n=${stamp.n})`).join(', ') ||
          'nenhum (deteccao por coorte)'
        }.`,
    );
  }
}

type LoadResult =
  | { ok: true; parsed: ParsedRetention; state: RetentionSourceState }
  | { ok: false; state: RetentionSourceState };

/** Most recent `lastSeenDate` in the payload, epoch ms. */
function latestEpoch(players: readonly RetentionPlayer[]): number | null {
  let latest = 0;
  for (const player of players) {
    if (player.lastSeenAt > latest) {
      latest = player.lastSeenAt;
    }
  }
  return latest === 0 ? null : latest;
}

/** Most recent `lastSeenDate` in the payload, as a São Paulo day. */
function latestDay(players: readonly RetentionPlayer[]): string | null {
  const latest = latestEpoch(players);
  return latest === null ? null : toSaoPauloDay(latest);
}

/** Earliest `registerDate` in the payload — the coverage floor. */
function earliestDay(players: readonly RetentionPlayer[]): string | null {
  let earliest = Number.POSITIVE_INFINITY;
  for (const player of players) {
    if (player.registeredAt < earliest) {
      earliest = player.registeredAt;
    }
  }
  return Number.isFinite(earliest) ? toSaoPauloDay(earliest) : null;
}
