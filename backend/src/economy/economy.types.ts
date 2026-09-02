import type { Platform } from '../instrumentation/platform';

/**
 * The economy layer (story S9.1, spec §6.4, ADR-007/ADR-008).
 *
 * ## What this file's types refuse to let happen
 *
 * The same thing every contract in this epic refuses: a ratio without the base
 * it was computed over. `Share` is a discriminated union for the same reason
 * `Conversion` and `RetentionMeasure` are — `{ percent: 40, n: null }` must not
 * compile.
 */

/**
 * A percentage and the sample behind it.
 *
 * For a **revenue** share the denominator is money and the sample is a count of
 * sales, so both travel: `percent` is the share of `totals.revenue`, which is
 * published alongside, and `n` is how many sales produced it. A share of 60%
 * built on two sales and a share of 60% built on four hundred are different
 * claims, and only `n` separates them.
 */
export type Share =
  | { percent: number; n: number }
  | { percent: null; n: number | null; unavailableReason: string };

/** Money as a decimal string, never a float. */
export type Money = string;

/** One platform's slice of revenue. */
export interface PlatformRevenue {
  platform: Platform;
  revenue: Money;
  sales: number;
  /** Distinct players who bought. Not the same as `sales`. */
  buyers: number;
  /** Share of `EconomyRevenueReport.totals.revenue`. */
  share: Share;
}

/** One cohort × platform slice of revenue. */
export interface CohortRevenue {
  /** `YYYY-MM` of the player's registration, or `null` when unknown. */
  cohort: string | null;
  platform: Platform;
  revenue: Money;
  sales: number;
  buyers: number;
}

/** Provenance of one input to the economy layer. */
export interface EconomySourceState {
  name: 'sales' | 'player_dimension' | 'player_payments';
  ok: boolean;
  /** ISO-8601 of the data's own currency, where there is one. */
  asOf: string | null;
  /** Closed label. Set exactly when `ok` is false. */
  failure?: EconomySourceFailure;
}

export const ECONOMY_SOURCE_FAILURES = [
  /** The player-dimension ETL has never completed, so cohorts mean nothing. */
  'never_synced',
  /** The query failed. */
  'query_failed',
] as const;

export type EconomySourceFailure = (typeof ECONOMY_SOURCE_FAILURES)[number];

/**
 * E1 — revenue by platform and by cohort (spec §6.4).
 *
 * ## The question this exists to answer
 *
 * *"Bedrock é 45,4% dos jogadores do survival. Quanto por cento da receita
 * produz?"* — and the spec is blunt about the stakes: **nenhuma decisão sobre
 * priorizar Bedrock deveria ser tomada antes desse número**.
 *
 * ## Grants cannot enter this number, by construction
 *
 * R2 requires administrative grants out of every revenue metric — there is a
 * 9.999.999 row in the PlayerPoints log. This report never reads that log: it
 * reads `sales`, our own table, where every row is a purchase with a price
 * carried from the Genesis `%price%` placeholder. The exclusion is structural
 * rather than a filter someone has to remember, which is the strongest form it
 * can take.
 *
 * ## Historical imports are excluded, and said so
 *
 * Rows with `historical_import = true` carry a migrated price and **no real
 * per-event timestamp** (`PROJECT.md`), so they cannot be attributed to a window
 * or compared against a registration date. They are excluded from every figure
 * here and republished in {@link EconomyRevenueReport.excludedHistorical}, so
 * the exclusion is visible instead of being a silent difference against the
 * numbers the analytics endpoints report.
 */
export interface EconomyRevenueReport {
  /** Window applied to `purchased_at`, or nulls for "everything". */
  from: string | null;
  to: string | null;
  totals: {
    revenue: Money;
    sales: number;
    buyers: number;
  };
  byPlatform: PlatformRevenue[];
  /**
   * Revenue by registration cohort, or `null` when the dimension cannot say.
   *
   * `null` and not an empty array: an empty array would read as "no cohort
   * produced revenue", which is the confusion the whole epic exists to remove.
   */
  byCohort: CohortRevenue[] | null;
  /** Set exactly when `byCohort` is null. */
  cohortUnavailableReason?: string;
  /**
   * How much of the window's revenue could be attributed to a cohort at all.
   *
   * Published always, including when it is 100%. A cohort breakdown covering
   * 30% of revenue is a different object from one covering all of it, and
   * nothing else in the payload would reveal which one a reader is holding.
   */
  cohortCoverage: {
    salesWithCohort: number;
    salesTotal: number;
    revenueWithCohort: Money;
  } | null;
  /**
   * What was left out for having no real timestamp.
   *
   * ⚠️ **Not windowed.** This is the whole historical corpus, whatever `from`
   * and `to` say, so a March request republishes every migrated row beside a
   * March figure. That matches `AnalyticsService`, which does the same for the
   * same reason — the historical rows all sit before any window anyway, and the
   * point of the field is to make the exclusion visible rather than to measure
   * it. Stated here because the field name does not say it.
   */
  excludedHistorical: { sales: number; revenue: Money };
  sources: EconomySourceState[];
}

/**
 * E2 — time to first spend, and funnel position as a predictor (spec §6.4).
 *
 * The first half is delivered. The second is not, and the reason is in
 * {@link FUNNEL_POSITION_UNAVAILABLE} rather than in a silent omission.
 */
export interface FirstSpendReport {
  /** Cohort months covered. */
  from: string;
  to: string;
  byCohort: CohortFirstSpend[] | null;
  /** Set exactly when `byCohort` is null. */
  unavailableReason?: string;
  /**
   * Spend by tutorial position — the second half of E2.
   *
   * `null` when the per-player position table has never been filled, with the
   * reason in {@link FirstSpendReport.funnelPositionUnavailableReason}. It stayed
   * permanently null from story S9.1 until the owner authorised the footprint on
   * 2026-09-02; the field was in the shape the whole time, because a requirement
   * that quietly disappears from a contract is one nobody remembers was asked
   * for.
   */
  byFunnelPosition: FunnelPositionSpend[] | null;
  /** Set exactly when `byFunnelPosition` is null. */
  funnelPositionUnavailableReason?: string;
  /**
   * Spend per furthest tutorial step, for players who entered.
   *
   * This is the half of the spec's question that groups cannot answer:
   * *"quem trava no passo 03 gasta alguma coisa?"* needs the step, not the
   * bucket. Null under the same condition as `byFunnelPosition`.
   */
  byFurthestStep: FurthestStepSpend[] | null;
  /**
   * The step order the positions were computed against, in order.
   *
   * Carried because `furthestIndex` is a position in it and that order is
   * **inferred from quest file names**, not read from the quests themselves. A
   * consumer that wants to check the inference has the list in hand.
   */
  stepOrder: string[] | null;
  sources: EconomySourceState[];
}

/** One cohort's spending behaviour. */
export interface CohortFirstSpend {
  cohort: string;
  platform: Platform;
  /** Players in the dimension who registered in this cohort. The denominator. */
  cohortSize: number;
  /** Of those, how many ever bought anything. */
  spenders: number;
  /** Share of the cohort that ever spent. */
  everSpent: Share;
  /** Median days from registration to first purchase. Null with no spenders. */
  medianDaysToFirstSpend: number | null;
  /** 90th percentile of the same. */
  p90DaysToFirstSpend: number | null;
  /**
   * Buyers whose first purchase predates their registration date.
   *
   * Counted and excluded from the percentiles rather than clamped to zero: a
   * negative interval means the two sources disagree about when this player
   * started, and averaging it in as "bought on day 0" would quietly bias the
   * median downwards. Usually a player who bought before Plan's history begins.
   */
  beforeRegistration: number;
}

/** Where a player stopped in the tutorial, as three coarse groups. */
export const FUNNEL_POSITIONS = [
  /** No tutorial progress at all — absent from the position table. */
  'nao_entrou',
  /** Touched the tutorial, did not complete the configured final quest. */
  'entrou_nao_concluiu',
  /** Completed the final quest. */
  'concluiu',
] as const;

export type FunnelPosition = (typeof FUNNEL_POSITIONS)[number];

/** Spend of one funnel position. */
export interface FunnelPositionSpend {
  position: FunnelPosition;
  /** Buyers in this position. The base for `share`. */
  players: number;
  /** Of those, how many ever bought anything. */
  spenders: number;
  /** Share of the position that ever spent. */
  everSpent: Share;
  /** Total revenue from this position, in the window. */
  revenue: Money;
  /**
   * Median furthest step index, for the players who entered.
   *
   * Null for `nao_entrou`, which has no step by definition.
   */
  medianFurthestStep: number | null;
}

/** Spend of the players whose furthest step is exactly this one. */
export interface FurthestStepSpend {
  /** Quest id, e.g. `03tutorial`. */
  step: string;
  /** Position of the step in `stepOrder`. */
  index: number;
  players: number;
  spenders: number;
  everSpent: Share;
  revenue: Money;
}

/**
 * Why "spend by funnel position" was not published until 2026-09-02.
 *
 * This is half of E2 as the spec writes it: *"quem conclui o tutorial gasta
 * mais? Quem trava no passo 03 gasta alguma coisa?"* Both need the tutorial
 * position **of an individual player**, and no store in this system has it.
 *
 * `tutorial_daily` is aggregated at `(day, platform)` by an explicit decision of
 * story S8.0, taken so that player identities from the game would not land in
 * this database for a question that is answered by counting. That decision is
 * documented in the table itself and is correct for the funnel.
 *
 * It is also the thing that blocks this metric, and the two cannot both hold.
 * Delivering it means persisting a per-player tutorial position — a widening of
 * the personal-data footprint that spec §8 governs, and therefore **the owner's
 * call, not this session's**. The cost of getting it wrong is asymmetric: a
 * metric can be added next sprint, and player data written into a database is
 * not un-written.
 *
 * What it would take, so the decision is cheap to make: one extra table keyed by
 * `(player_uuid)` holding the furthest tutorial quest reached, written by the
 * S8.0 ETL, which already reads exactly that from `Quests/playerdata` and throws
 * it away.
 */
export const FUNNEL_POSITION_UNAVAILABLE =
  'A posicao por jogador no tutorial nunca foi gravada: o ETL do tutorial roda ' +
  'com `TUTORIAL_POSITION_ENABLED` desligado, ou ainda nao completou uma ' +
  'execucao com ele ligado. Sem ela nao ha como cruzar onde o jogador parou com ' +
  'o que ele gastou — e uma lista vazia aqui se leria como "ninguem em posicao ' +
  'nenhuma gastou", que e a confusao que este epico existe para remover. O ' +
  'restante de E2 (tempo ate o primeiro gasto) nao depende disto e continua ' +
  'valendo.';
