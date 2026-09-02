import { Platform } from '../instrumentation/platform';

/**
 * Cohort retention by month × platform (story S8.2, spec §6.2).
 *
 * ## ⚠️ What this measures is NOT "came back on day N"
 *
 * The source is `GET /v1/retention`, whose rows carry `registerDate` and
 * `lastSeenDate` — one pair per player. From those two dates the only thing
 * derivable is **how long the player's activity spanned**: the interval between
 * the first and the last time Plan saw them.
 *
 * "D30" in the literature usually means *the player returned on or around day
 * 30*. That is a different question, and answering it needs a per-session log,
 * which is exception 1 of ADR-002 — an exception this story deliberately does
 * **not** open, because the interval reading answers the business question
 * (does this cohort stick?) without a MySQL credential.
 *
 * So the number published is the **survival interval**, and the label travels
 * with it in {@link RETENTION_SEMANTICS} rather than living in a docblock
 * nobody opens. Publishing the interval is fine; publishing it under the other
 * name would be the same denominator error that already cost this epic a line
 * of the S8 DoD.
 *
 * @see .specs/features/austv-admin/HANDOFF.md — "`/v1/retention` — derruba a
 *   premissa da exceção 1"
 */
export const RETENTION_SEMANTICS =
  'Intervalo de sobrevivencia, nao retorno no dia N. A fonte `/v1/retention` ' +
  'traz duas datas por jogador (`registerDate` e `lastSeenDate`), e a unica ' +
  'coisa derivavel delas e por quanto tempo a atividade do jogador se ' +
  'estendeu: "D30" aqui significa que o Plan ainda via o jogador 30 dias ' +
  'depois do registro, nao que ele voltou no trigesimo dia. Responder a ' +
  'segunda pergunta exigiria um log de sessao por jogador, que e a excecao 1 ' +
  'do ADR-002 e esta historia nao abre.';
// O identificador da tabela fica no docblock acima e NAO nesta string: ela viaja
// no corpo de toda resposta, e nome de tabela de terceiro em corpo HTTP e
// exatamente o que a regra de CWE-209 deste projeto proibe.

/**
 * The horizons published, in days.
 *
 * Three, matching spec §6.2 (`D1/D7/D30`). Fixed rather than configurable: the
 * comparison numbers this epic already has on record are D1/D7/D30, and a
 * configurable horizon would produce series that cannot be compared with them.
 */
export const RETENTION_HORIZON_DAYS = [1, 7, 30] as const;

export type RetentionHorizonDays = (typeof RETENTION_HORIZON_DAYS)[number];

/** `D1` | `D7` | `D30` — the label a consumer renders. */
export type RetentionHorizonLabel = `D${RetentionHorizonDays}`;

export function horizonLabel(
  days: RetentionHorizonDays,
): RetentionHorizonLabel {
  return `D${days}`;
}

/**
 * Why a horizon has no percentage.
 *
 * A **closed vocabulary**, like `FunnelSourceFailure` and
 * `MetricsFailureReason` before it. The three cases demand different reactions
 * and collapsing them would put a consumer back where the epic started —
 * unable to tell "we cannot measure this yet" from "we could not measure this
 * at all".
 */
export const RETENTION_UNAVAILABLE_REASONS = [
  /**
   * Nobody in the cohort has had `N` days of opportunity yet.
   *
   * The single easiest number in this module to get wrong: the current month's
   * D30 is `0.0%` if you divide by the whole cohort, and `0.0%` reads as a
   * catastrophe rather than as a cohort that is three days old.
   */
  'immature_horizon',
  /**
   * The cohort's `lastSeenDate` values pile up on a day that is an import
   * stamp, not player behaviour. See {@link CohortContamination}.
   */
  'import_artifact',
  /** The Plan API could not be read at all. Never a zero. */
  'source_unavailable',
  /**
   * The dataset itself stopped advancing before this horizon could close.
   *
   * This is the distinction whose absence was the worst defect this module
   * shipped. Maturity used to be measured against the **wall clock** while
   * survival is measured against `lastSeenDate`, which comes from the data.
   * When collection stalls, every player becomes "mature" by calendar while
   * none of them can possibly have survived — and the resulting zero was
   * published as a measurement, with a healthy-looking `n` beside it.
   *
   * That is the three-month-blackout reading this whole epic exists to
   * eliminate, wearing the clothes of a real number. A horizon is now only
   * measurable up to `dataThrough`.
   */
  'source_stale',
  /**
   * The cohort survives at ~100% across every horizon, which no real cohort
   * does.
   *
   * An independent guard against the bulk-import artefact, sitting beside the
   * stamp-day detector rather than depending on it. `HANDOFF.md` describes the
   * contamination as `lastSeenDate` "posterior por construção" — not
   * necessarily identical on one day — so a detector keyed on calendar days can
   * miss it, and the output of a missed detection is exactly `100%`. This
   * catches the *shape* of the result however the import spread its timestamps.
   */
  'implausible_survival',
  /**
   * The cohort is too small for {@link 'implausible_survival'} to judge it
   * alone, but it shows the same ~100% shape **and** it registers inside a span
   * of months where cohorts large enough to be judged all failed that test.
   *
   * ## Why this reason had to exist
   *
   * The production read of 2026-09-02 over `2024-06..2025-08` returned 45
   * cohorts. 21 were suppressed as implausible; the other 24 published — and 23
   * of those published **100% at D1, D7 and D30 alike**. The only thing telling
   * the two groups apart was cohort size: every suppressed cohort had 20 members
   * or more, every published one had 19 or fewer. Nothing about the data
   * decided; the size floor decided, by itself, everything.
   *
   * That floor is right in isolation — eleven players all sticking around is not
   * evidence of anything. It is wrong in a neighbourhood: the artefact is a
   * property of a bulk **write**, and a write covers a contiguous range of
   * registrations, so a tiny cohort showing the artefact's exact shape between
   * two months where the artefact was proven is the artefact, not luck.
   *
   * Inference, and labelled as inference — which is why it is its own reason and
   * not folded into `implausible_survival`. Suppression here never reaches a
   * cohort with a different shape: only the size requirement is relaxed, and
   * only inside a region where the artefact stands on its own evidence.
   */
  'contaminated_span',
] as const;

export type RetentionUnavailableReason =
  (typeof RETENTION_UNAVAILABLE_REASONS)[number];

/**
 * A retention figure and the base it was computed over — never one without the
 * other.
 *
 * A discriminated union for the same reason `Conversion` is one in the funnel:
 * `{ percent: 50, n: null }` must not compile. The project published "queda de
 * 96%" over a base nobody could check, and the type is the fix for that class
 * of number, not a convention that a future edit can quietly drop.
 *
 * Note that `n` is **per horizon**, not per cohort. It is the number of players
 * who had `N` days of opportunity, which shrinks as `N` grows: a cohort of 200
 * registered ten days ago has `n = 200` at D1 and D7, and no D30 at all. A
 * single cohort-level `n` printed next to three percentages would be wrong for
 * two of them.
 */
export type RetentionMeasure =
  | {
      horizon: RetentionHorizonLabel;
      /** Percentage, one decimal. Always accompanied by its base. */
      percent: number;
      /** Players who had `horizon` days of opportunity. The denominator. */
      n: number;
      /** Players still seen `horizon` days after registering. The numerator. */
      survived: number;
      /**
       * True when **this horizon's base** is below the configured minimum.
       *
       * ## Why the cohort-level mark was not enough
       *
       * {@link CohortRetention.belowMinimum} looks at the cohort's *size*, and
       * the first production read showed what that misses: `2026-08 / bedrock`
       * has 43 players — comfortably above a minimum of 30, so the cohort is
       * unmarked — and publishes `D30: 0%` over `n: 5`. Five people. A number
       * that reads as a total collapse of retention, resting on a base small
       * enough that one player moves it twenty points, with nothing anywhere
       * saying so.
       *
       * The bases of one cohort routinely differ across horizons, because
       * maturity is filtered per player: a cohort registered three weeks ago has
       * its whole size at D1 and almost nobody at D30. So a single mark next to
       * three percentages is wrong for two of them, exactly as a single `n`
       * would be — and this project already refused the single `n` for that
       * reason.
       *
       * **Marked, never hidden**, which is the rule criterion 2 of the story
       * fixed and the owner reaffirmed on 2026-09-02 when choosing between
       * marking and suppressing. A suppressed small sample is invisible; a
       * marked one leaves the judgement with whoever reads it.
       */
      belowMinimum: boolean;
    }
  | {
      horizon: RetentionHorizonLabel;
      percent: null;
      /** The eligible base, when it could be counted at all. */
      n: number | null;
      survived: null;
      reason: RetentionUnavailableReason;
      unavailableReason: string;
    };

/**
 * A calendar day on which an implausible share of the whole population was last
 * seen — the fingerprint of a bulk import, not of player behaviour.
 *
 * ## Why detection is a test on the data and not a date in the code
 *
 * `HANDOFF.md` records that cohorts up to 2025-08 come back at D1/D7/D30 =
 * 100%, because players brought in by the 2026-08-20 database unification carry
 * a `lastSeenDate` that was written by the import rather than lived by the
 * player. It also records why hardcoding that boundary is wrong: *"a fronteira
 * de 2025-08 é ajuste empírico, não mecanismo"* — if the contamination comes
 * from the unification it should not stop at a particular month, and a constant
 * in the code would give whoever maintains this a magic number with no way to
 * tell whether it still applies.
 *
 * So the module looks for the mechanism instead: a bulk write leaves every row
 * it touched with the **same** `lastSeenDate`, and an organic population never
 * concentrates a tenth of itself on one calendar day. The days that do are
 * published here with their share and base, so a human can confirm the detector
 * found the unification rather than a launch event.
 *
 * ⚠️ **The thresholds are uncalibrated**, in the same sense the three of story
 * S6.3 were: they were chosen to be obviously outside organic behaviour, not
 * measured against this population. The first production read is what turns
 * them into calibration, and the evidence needed to do it is in this payload.
 */
export interface StampDay {
  /** `YYYY-MM-DD` in America/Sao_Paulo. */
  day: string;
  /** Share of the whole population last seen on this day, 0..1. */
  share: number;
  /** Players last seen on this day. */
  n: number;
  /** Population the share was taken over — the denominator, always published. */
  population: number;
  /**
   * The run of adjacent days this one belongs to, `YYYY-MM-DD..YYYY-MM-DD`.
   *
   * Detection is **per run**, not per day, and the difference is not cosmetic:
   * an import that wrote across a midnight boundary leaves two days of ~8% each
   * where the threshold is 10%, and a per-day test sees nothing at all. The
   * `HANDOFF.md` wording is "idêntico **ou colado** à data da unificação", and
   * "colado" is precisely the case a single-day test cannot see.
   */
  run: string;
  /** Share of the whole population across the entire run. Never below `share`. */
  runShare: number;
}

/** How much of one cohort landed on a stamp day. */
export interface CohortContamination {
  /** Share of the cohort last seen on any {@link StampDay}, 0..1. */
  share: number;
  /** Players in the cohort last seen on a stamp day. */
  n: number;
  /**
   * True when `share` reached the configured ceiling, which makes every horizon
   * of this cohort `null` with `import_artifact`.
   *
   * Published even when false: a cohort at 40% contamination is not suppressed,
   * and whoever reads the number deserves to know it is 40% and not 0%.
   */
  suspect: boolean;
  /**
   * Which detector fired, or `null` when none did.
   *
   * One value today — `population_stamp`, the cohort sitting on a run the whole
   * dataset piles onto. The field exists rather than being implied by `suspect`
   * because the *other* artefact guard, `implausible_survival`, reports through
   * the measures instead, and a reader looking at a suppressed cohort needs to
   * know which of the two spoke.
   */
  detectedBy: 'population_stamp' | null;
}

/** One cohort — a registration month and a platform. */
export interface CohortRetention {
  /** `YYYY-MM` in America/Sao_Paulo, from `registerDate`. */
  cohort: string;
  /** Platform derived from the UUID (ADR-003). */
  platform: Platform;
  /** Players who registered in this month on this platform. */
  size: number;
  /**
   * True when the cohort's **size** is below the configured minimum.
   *
   * **Marked, never hidden** (criterion 2 of the story). Hiding a small sample
   * is the same error as omitting `n`: it turns noise into an apparent trend by
   * leaving only the cohorts that happened to be large. Marking leaves the
   * decision with whoever reads it.
   *
   * ⚠️ This is about the cohort, not about any one number in it. A cohort can be
   * large and still publish a percentage over five people — see
   * {@link RetentionMeasure} `belowMinimum`, which is the per-horizon mark and
   * the one that qualifies an actual figure.
   */
  belowMinimum: boolean;
  contamination: CohortContamination;
  measures: RetentionMeasure[];
}

/** Why the source could not answer. Closed vocabulary; never an upstream text. */
export const RETENTION_SOURCE_FAILURES = [
  /** `PLAN_BASE_URL` is unset — our deploy, not an outage. */
  'not_configured',
  /** Plan was unreachable, refused, or answered a non-2xx. */
  'unreachable',
  /** Plan answered, but not with the shape this module knows how to read. */
  'contract_mismatch',
] as const;

export type RetentionSourceFailure = (typeof RETENTION_SOURCE_FAILURES)[number];

/** State of the single upstream source at read time. */
export interface RetentionSourceState {
  name: 'plan_retention';
  ok: boolean;
  /** When this process asked. ISO-8601. */
  asOf: string | null;
  /** Set exactly when `ok` is false. Never an upstream message (CWE-209). */
  failure?: RetentionSourceFailure;
  /**
   * The most recent `lastSeenDate` in the payload, `YYYY-MM-DD`.
   *
   * The dataset's own currency, which is not the same as `asOf`. A Plan that
   * answers instantly with data frozen a week ago produces a fresh `asOf` and a
   * stale `dataThrough`, and only the second one tells a reader that the recent
   * cohorts are being measured against a horizon that stopped advancing.
   */
  dataThrough: string | null;
  /** Rows the payload carried, before any filtering. */
  rows: number | null;
  /**
   * Rows that survived parsing — the base every number here was computed over.
   *
   * Published beside `rows` because the two can differ and the difference is
   * otherwise invisible: `rows` is the pre-filter total, so a payload with 2.000
   * unreadable dates out of 5.565 would advertise 5.565 next to cohorts summing
   * 3.565, with nothing to notice. Same family as the `n` rule — the published
   * base has to be the base the numbers came from.
   */
  parsed: number | null;
  /** Rows dropped for an unreadable uuid or date. `rows - parsed`. */
  dropped: number | null;
  /**
   * Earliest `registerDate` in the payload, `YYYY-MM-DD`.
   *
   * The coverage floor. A window entirely before it produces no cohorts, and
   * without this field that is indistinguishable from "nobody registered then"
   * — the same defect PR #180 fixed in the funnel with `coversFrom`.
   */
  dataFrom: string | null;
  /**
   * Whether the served payload came from cache after Plan failed.
   *
   * Spec §8 requires a TTL cache in front of `/v1/*`; when Plan is down and a
   * previous payload exists, serving it beats serving nothing — but only if the
   * consumer is told, which is what this field is for.
   */
  stale: boolean;
  /** Age of the served payload in milliseconds, when it came from cache. */
  ageMs: number | null;
}

/** A full cohort-retention read. */
export interface RetentionReport {
  /**
   * What the percentages mean. Carried in the payload on purpose — see
   * {@link RETENTION_SEMANTICS}.
   */
  semantics: string;
  /** First cohort month returned, `YYYY-MM`. */
  from: string;
  /** Last cohort month returned, `YYYY-MM`. */
  to: string;
  /** Instant the maturity filter was evaluated against. ISO-8601. */
  evaluatedAt: string;
  /** Minimum cohort size below which a cohort is marked. */
  minimumCohortSize: number;
  /** Days detected as bulk-import stamps. Empty is the healthy case. */
  stampDays: StampDay[];
  /**
   * Runs of registration months carrying the import artefact. Empty is healthy.
   *
   * A list and not a single span: the walls that bound a run (a clean month, a
   * gap too long) can split one dataset into several, and collapsing them into
   * one interval would re-introduce exactly the unbounded reach the walls exist
   * to remove.
   */
  contaminatedSpans: ContaminatedSpan[];
  cohorts: CohortRetention[];
  /**
   * Set when the requested window falls wholly outside what the source covers.
   *
   * Without it, `cohorts: []` beside `source.ok: true` reads as "nobody
   * registered in that period" — a measurement the module never made.
   */
  coverageWarning?: string;
  source: RetentionSourceState;
}

/**
 * A run of registration months carrying the bulk-import artefact.
 *
 * ## What bounds it, and why it is bounded at all
 *
 * `from`..`to` is a run **grown** from the months holding a cohort that
 * {@link 'implausible_survival'} judged on its own evidence — not simply the
 * interval between the first and the last of them. The difference is the whole
 * safety of the mechanism: `[min, max]` is unbounded extrapolation, and a second
 * import a year after the first would silently swallow everything between two
 * unrelated events. It is the same failure the stamp detector's two-day cap
 * exists to prevent, one level up.
 *
 * A run stops at either of two walls:
 *
 * - **a clean month** — one whose judgeable cohorts all *passed* and which holds
 *   no failing cohort of its own. A month with a healthy 200-player cohort is
 *   evidence *against* a write covering it, and inference must not cross it.
 * - **a gap too long** — more consecutive months without evidence than the
 *   detector will bridge.
 *
 * Months inside the run with no judgeable cohort **are** part of it. A gap means
 * "nobody here was big enough to test", not "this month is clean", and reading
 * the gap as clean is what published fifteen consecutive cohorts at 100%.
 *
 * Published in the report for the same reason `stampDays` is: a detector that
 * blanks half a report has to hand over the evidence it decided on.
 */
export interface ConfirmedSpan {
  /** First month of the run. `YYYY-MM`. */
  from: string;
  /** Last month of the run. `YYYY-MM`. */
  to: string;
  /** Every month in the run that carried its own evidence. Gaps are not listed. */
  confirmedMonths: string[];
  /** Cohorts inside the run judged implausible on their own evidence. */
  confirmedCohorts: number;
  /**
   * Cohorts inside the run that were large enough to be judged at all.
   *
   * The base of `confirmedCohorts`, and it is **not** always equal to it: a
   * month can hold a failing cohort and a passing one at once, which makes the
   * month evidence without making every cohort in it evidence. Published so the
   * suppression reason can say "21 of 22" instead of claiming a completeness
   * nobody measured.
   */
  judgedCohorts: number;
}

/** A {@link ConfirmedSpan} plus what inheriting it actually suppressed. */
export interface ContaminatedSpan extends ConfirmedSpan {
  /**
   * Cohorts suppressed **by inheritance** — too small to judge, right shape,
   * inside the span. Counted across the whole dataset, not the request window,
   * because the span is a property of the dataset and not of the question asked.
   */
  inheritedCohorts: number;
  /**
   * Players in those cohorts, dataset-wide like `inheritedCohorts`.
   *
   * The base of the decision. Note that none of the four counts on this type is
   * restricted to the cohorts a given response renders — a request filtered to
   * one platform and three months still reports the span over the whole dataset,
   * because a span narrowed to the question would stop being checkable.
   */
  inheritedPlayers: number;
}

/** Platform filter, or every platform reported separately. */
export type CohortPlatformFilter = Platform | 'all';
