import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PlanApiClient } from '../instrumentation/plan-api.client';
import { PlanNotConfiguredError } from '../instrumentation/plan-api.errors';
import { toSaoPauloDay } from '../tutorial/tutorial-day';
import { parseRetention, type RetentionPlayer } from './plan-retention';
import {
  buildCohorts,
  detectStampDays,
  toSaoPauloMonth,
} from './retention-math';
import {
  RETENTION_HORIZON_DAYS,
  RETENTION_SEMANTICS,
  horizonLabel,
  type CohortPlatformFilter,
  type CohortRetention,
  type RetentionReport,
  type RetentionSourceFailure,
  type RetentionSourceState,
  type StampDay,
} from './retention.types';

/** Path of the single endpoint this module reads. */
const RETENTION_PATH = '/v1/retention';

/** Defaults, all overridable. Documented in `.env.example` as uncalibrated. */
const DEFAULT_MIN_COHORT_SIZE = 30;
const DEFAULT_STAMP_DAY_MIN_SHARE = 0.1;
const DEFAULT_STAMP_DAY_MIN_POPULATION = 200;
const DEFAULT_CONTAMINATION_MAX = 0.5;

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
 * provision, and no second place in the codebase that knows Plan's schema. The
 * exception stays closed, and its stated justification stays falsified rather
 * than quietly repaired — see the ADR.
 *
 * ## What the numbers mean, and why the label is in the payload
 *
 * Survival interval, not return-on-day-N. {@link RETENTION_SEMANTICS} says so,
 * and it travels in every response. The two readings are different questions and
 * the endpoint only answers the first; calling it the second would be the
 * denominator error this epic has already paid for once.
 *
 * ## Degradation
 *
 * Plan unreachable, misconfigured, or answering a shape this module does not
 * know produces a report with **no cohorts and a named failure**, never a report
 * of zeroes. Same rule as the funnel, same reason: a collection gap read as a
 * measurement is the failure mode ADR-006 exists to remove.
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  private readonly minimumCohortSize: number;
  private readonly stampDayMinShare: number;
  private readonly stampDayMinPopulation: number;
  private readonly contaminationMax: number;

  constructor(
    private readonly plan: PlanApiClient,
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

    // Stamp detection runs over the WHOLE payload, not over the requested
    // window. An import stamp is a property of the dataset, and a request for
    // three months would otherwise be unable to see that the day it lands on is
    // shared by five thousand players outside the window.
    const stampDays = detectStampDays(
      loaded.players,
      this.stampDayMinShare,
      this.stampDayMinPopulation,
    );

    const inWindow = loaded.players.filter((player) => {
      const month = toSaoPauloMonth(player.registeredAt);
      return month !== null && month >= fromMonth && month <= toMonth;
    });

    const cohorts = buildCohorts(inWindow, {
      evaluatedAt,
      stampDays,
      minimumCohortSize: this.minimumCohortSize,
      contaminationMax: this.contaminationMax,
    }).filter((cohort) => platform === 'all' || cohort.platform === platform);

    this.warnOnSuppression(cohorts, stampDays);

    return {
      semantics: RETENTION_SEMANTICS,
      from: fromMonth,
      to: toMonth,
      evaluatedAt: new Date(evaluatedAt).toISOString(),
      minimumCohortSize: this.minimumCohortSize,
      stampDays,
      cohorts,
      source: loaded.state,
    };
  }

  /** Fetch and parse the payload, turning every failure into a closed label. */
  private async load(): Promise<LoadResult> {
    if (!this.plan.configured) {
      return { ok: false, state: this.failed('not_configured', null) };
    }

    let body: unknown;
    try {
      body = await this.plan.getJson(RETENTION_PATH);
    } catch (error) {
      // The message names the host and sometimes an upstream body. It goes to
      // the log; the response gets a closed label (CWE-209, the same call story
      // S7.2 made for `MetricsFailureReason`).
      this.logger.warn(
        `Retencao por coorte indisponivel: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      // Only two labels here, and that is deliberate: from a reader's point of
      // view "we are misconfigured" and "the game VPS did not answer" send you
      // to different places, while a 403 and a timeout send you to the same one.
      // The taxonomy that separates those lives in `plan-api.errors.ts` and
      // reaches the log; the body gets the distinction that changes behaviour.
      const failure: RetentionSourceFailure =
        error instanceof PlanNotConfiguredError
          ? 'not_configured'
          : 'unreachable';
      return { ok: false, state: this.failed(failure, null) };
    }

    const parsed = parseRetention(body);
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
          'coortes abaixo cobrem o resto.',
      );
    }

    return {
      ok: true,
      players: parsed.value.players,
      state: {
        name: 'plan_retention',
        ok: true,
        asOf: new Date().toISOString(),
        dataThrough: latestDay(parsed.value.players),
        rows: parsed.value.rows,
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
      rows,
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
  ): void {
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
          'nenhum'
        }.`,
    );
  }
}

type LoadResult =
  | { ok: true; players: RetentionPlayer[]; state: RetentionSourceState }
  | { ok: false; state: RetentionSourceState };

/** Most recent `lastSeenDate` in the payload, as a São Paulo day. */
function latestDay(players: readonly RetentionPlayer[]): string | null {
  let latest = 0;
  for (const player of players) {
    if (player.lastSeenAt > latest) {
      latest = player.lastSeenAt;
    }
  }
  return latest === 0 ? null : toSaoPauloDay(latest);
}
