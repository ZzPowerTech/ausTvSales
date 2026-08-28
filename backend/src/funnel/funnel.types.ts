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
 * A **discriminated union**, not an object with optional fields. `null` is not
 * zero, and the shape makes "absent without a reason" impossible to construct:
 * a consumer that reads `value === null` is guaranteed a `unavailableReason` to
 * show. A collection gap read as zero is what made the tutorial's eight-month
 * outage invisible.
 */
export type StepCount =
  | { step: FunnelStep; value: number }
  | {
      step: FunnelStep;
      value: null;
      /**
       * Why this step has no number for this bucket.
       *
       * Carried per step rather than per response because the steps fail
       * independently: the network step can be unreachable while the tutorial
       * steps are fine, and a response-level flag would hide which is which.
       */
      unavailableReason: string;
    };

/**
 * A ratio and the base it was computed from — never one without the other.
 *
 * ## Why this is a union and not two nullable fields
 *
 * The project rule is not ceremony: the investigation published "queda de 96%"
 * and "48 chegadas/mês", both percentages over a contaminated base that nobody
 * could check because the base was never printed. A percentage without `n` is an
 * assertion with no way to be wrong.
 *
 * `.specs/features/austv-admin/S6-VERIFICACAO.md` found that this rule lived
 * only in a docblock — `n?: number`, optional — and asked for *"um tipo que
 * torne o par inseparável, em vez de dois campos opcionais lado a lado"*. Two
 * nullable fields side by side would still let `{ percent: 50, n: null }`
 * compile, which is exactly the thing forbidden.
 *
 * So: **a measured conversion carries both, and only the unmeasured variant may
 * omit the percentage.** `{ percent: number; n: null }` does not typecheck.
 *
 * The reverse is deliberately allowed — `percent: null` with an `n` — because a
 * denominator without a numerator is still a real measurement, and withholding
 * it would lose information for no reason.
 */
export type Conversion =
  | {
      from: FunnelStep;
      to: FunnelStep;
      /** Percentage, one decimal. Always accompanied by its base. */
      percent: number;
      n: number;
    }
  | {
      from: FunnelStep;
      to: FunnelStep;
      percent: null;
      /** The base, when it was measured. Null when even that is missing. */
      n: number | null;
      unavailableReason: string;
    };

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
