import { Platform } from '../instrumentation/platform';

/**
 * The four-step funnel of spec §6.2 (story S8.1).
 *
 * ```
 * conecta na rede (proxy)   → 100%
 * chega ao survival         →  54%    ← descoberto em 2026-08-21
 * entra no tutorial         →  varia  ← quebrou em dez/2025, silencioso
 * conclui o tutorial        →   0,3% historico
 * ```
 *
 * Only the third step had ever been measured, and it was being measured wrong —
 * the series used for it counted tutorial entries and was read as arrivals,
 * which produced three of the five errors in `HANDOFF.md`.
 */
export const FunnelStep = {
  /** Connected to the network. `plan_users.registered` (ADR-002 exception 2). */
  Network: 'rede',
  /** Reached the survival backend. See {@link SURVIVAL_STEP_UNAVAILABLE}. */
  Survival: 'survival',
  /** Touched any tutorial quest. `tutorial_daily.entered` (S8.0). */
  TutorialEntered: 'tutorial_entrou',
  /** Completed the final tutorial quest. `tutorial_daily.completed` (S8.0). */
  TutorialCompleted: 'tutorial_concluiu',
} as const;

export type FunnelStep = (typeof FunnelStep)[keyof typeof FunnelStep];

/** The steps in funnel order. Order is the contract; consumers render it. */
export const FUNNEL_STEPS: readonly FunnelStep[] = [
  FunnelStep.Network,
  FunnelStep.Survival,
  FunnelStep.TutorialEntered,
  FunnelStep.TutorialCompleted,
];

/**
 * Why the `survival` step carries no numbers yet.
 *
 * This is the step whose discovery started the epic — **54% of everyone who
 * connects to the network never reaches survival** — so shipping the funnel
 * without it is a real gap, and it is stated in the payload rather than left for
 * a reader to notice.
 *
 * A *daily series* of arrivals at a backend needs one of two sources, and
 * neither is available to this story:
 *
 * 1. `/v1/graph?type=uniqueAndNew` — the right endpoint, but **nobody has
 *    observed its payload**. Writing a parser against an imagined shape is the
 *    mistake that got story S6.2 written, merged and reverted, and the rule the
 *    S7.2 adapters were built under. Not repeating it.
 * 2. `plan_user_info`, which records registration per server — but that table is
 *    **exception 1** of ADR-002, scoped to the cohort module of story S8.2.
 *    Reaching for it here would widen an exception belonging to another story.
 *
 * What *does* exist is the **7-day windowed** conversion, and it is already
 * watched continuously by the `funnel.network_to_survival` check from S6.3. So
 * the signal is not absent from the system — it is absent from *this series*.
 */
export const SURVIVAL_STEP_UNAVAILABLE =
  'Serie diaria de chegadas ao servidor ainda sem fonte: o payload de ' +
  '`/v1/graph?type=uniqueAndNew` nunca foi observado, e `plan_user_info` ' +
  'pertence a excecao 1 do ADR-002 (modulo de coorte, S8.2). A conversao ' +
  'rede->servidor em janela de 7 dias existe e e vigiada pelo check ' +
  '`funnel.network_to_survival`.';

/**
 * A count that may be absent, and says which.
 *
 * `null` is **not zero**. The distinction is the reason this epic exists: a
 * collection gap read as zero is what made the tutorial's eight-month outage
 * invisible. A shape that cannot express "we did not measure" would force every
 * consumer to guess.
 */
export interface StepCount {
  step: FunnelStep;
  /** Null when this step had no source for the bucket. Never a stand-in zero. */
  value: number | null;
  /**
   * Why `value` is null. Absent when there is a value.
   *
   * Carried per step rather than per response because the steps fail
   * independently: the network step can be unreachable while the tutorial steps
   * are fine, and a single response-level flag would hide which is which.
   */
  unavailableReason?: string;
}

/**
 * A ratio and the base it was computed from — never one without the other.
 *
 * The project rule, and it is not ceremony: the investigation published "queda
 * de 96%" and "48 chegadas/mês", and both were percentages over a contaminated
 * base that nobody could check because the base was not printed. A percentage
 * without `n` is an assertion with no way to be wrong.
 *
 * Both fields are nullable **together**: a conversion needs both sides, and a
 * shape where `value` could be set while `n` was null would reintroduce exactly
 * the thing the rule forbids.
 */
export interface Conversion {
  from: FunnelStep;
  to: FunnelStep;
  /** Percentage, one decimal. Null when either side is missing. */
  percent: number | null;
  /** The denominator. Null exactly when `percent` is. */
  n: number | null;
  /** Set when `percent` is null. */
  unavailableReason?: string;
}

/** One bucket of the funnel — a day or a month, optionally one platform. */
export interface FunnelBucket {
  /** `YYYY-MM-DD` for a daily bucket, `YYYY-MM` for a monthly one. */
  bucket: string;
  counts: StepCount[];
  /** Step-to-step conversions, in funnel order. */
  conversions: Conversion[];
}

/** Granularity of a funnel series. */
export const FunnelGranularity = {
  Daily: 'daily',
  Monthly: 'monthly',
} as const;

export type FunnelGranularity =
  (typeof FunnelGranularity)[keyof typeof FunnelGranularity];

/** Platform filter, or every platform summed. */
export type PlatformFilter = Platform | 'all';
