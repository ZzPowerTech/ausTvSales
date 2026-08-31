import { Platform } from '../instrumentation/platform';

/**
 * The four-step funnel of spec §6.2 (story S8.1).
 *
 * ```
 * conecta na rede (proxy)   → 100%   ← sem fonte: ver NETWORK_STEP_UNAVAILABLE
 * chega ao survival         →  54%   ← descoberto em 2026-08-21
 * entra no tutorial         →  varia ← quebrou em dez/2025, silencioso
 * conclui o tutorial        →   0,3% historico
 * ```
 *
 * Only the third step had ever been measured, and it was being measured wrong —
 * the series used for it counted tutorial entries and was read as arrivals,
 * which produced three of the five errors in `HANDOFF.md`.
 *
 * ## ⚠️ The first two steps swapped places on 2026-08-31
 *
 * Until then `plan_users` fed the **network** step and `survival` had no source.
 * Production measurement inverted that: `plan_users` holds the **Survival**
 * population, not the network's. Three facts, one conclusion — the proxy has
 * zero rows in `plan_user_info`, `Survival` is the only server that appears
 * there, and the monthly counts of `plan_users` match the `survival` column of
 * `HANDOFF.md` exactly across eight months (682, 641, 727, 374, 258, 192, 1,
 * 106) while the `rede` column is roughly double.
 *
 * So the step that had a number was the one wearing the wrong name, and the
 * `rede → survival` conversion derived from it was Survival ÷ Survival — a
 * number near 100% that would have read as a healthy funnel with the whole
 * network gone. The counts did not change; the labels did.
 */
export const FunnelStep = {
  /** Connected to the network. No source. See {@link NETWORK_STEP_UNAVAILABLE}. */
  Network: 'rede',
  /**
   * Reached the survival backend. `plan_users.registered` (ADR-002 exception 2).
   *
   * The provenance caveat travels in the payload, not only here — see
   * {@link SURVIVAL_STEP_PROVENANCE}.
   */
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
 * Why the `rede` step carries no numbers, and will not until a source exists.
 *
 * This is the step whose absence started the epic — **54% of everyone who
 * connects to the network never reaches survival** — so its emptiness is stated
 * in the payload rather than left for a reader to notice.
 *
 * ## It used to carry a number, and the number was the Survival step
 *
 * `plan_users` was read as network arrivals from story S8.1 until 2026-08-31.
 * Measured that day: the proxy (`AusTv`, `is_proxy = 1`) is in the `plan_servers`
 * catalogue with **zero** players in `plan_user_info`; `Survival` is the only
 * server that appears there, with 5575 of the 5638 rows; and the monthly counts
 * of `plan_users` are, to the row, the `survival` column of the verified table
 * in `HANDOFF.md`. The network’s population is in the **old** database, which is
 * where that table’s `rede` column came from.
 *
 * ## Why this is `null` and not a best-effort number
 *
 * The conversion `rede → survival` computed from `plan_users` was Survival ÷
 * Survival: close to 100%, plausible, and unable to move if the entire network
 * vanished. That is the same class of number as the 4500% this module published
 * twice — high, believable and false — and the project rule that settles it is
 * the one in §6.1: a collection gap never becomes a zero **nor a healthy value**.
 *
 * **Trigger to revisit:** a source that counts arrivals at the *proxy*. The old
 * database is one candidate; `/v1/networkMetadata` and `/v1/playersTable` have
 * never been read for this purpose. Until one exists, saying “não sei” is the
 * only answer this step is entitled to.
 */
export const NETWORK_STEP_UNAVAILABLE =
  'A populacao da rede nao esta nesta fonte: `plan_users` guarda o Survival — ' +
  'o proxy tem zero jogadores em `plan_user_info`, e as contagens mensais ' +
  'batem exatamente com a coluna `survival` dos numeros verificados (medido em ' +
  '2026-08-31). Publicar este degrau a partir dela daria uma conversao ' +
  'rede->survival de Survival dividido por Survival, perto de 100%, incapaz de ' +
  'cair com a rede inteira fora do ar. Sem fonte de chegadas no proxy, este ' +
  'degrau fica sem numero.';

/**
 * What the `survival` step is actually counting, carried with every series.
 *
 * Not a footnote in a docblock: this string travels in `FunnelSourceState` so a
 * consumer rendering the chart has the caveat in hand. Two things it says, and
 * both matter.
 *
 * 1. **The table is `plan_users`, not `plan_user_info`.** The latter is the one
 *    that records registration *per server* and would settle the question by
 *    schema; it is **exception 1** of ADR-002, scoped to the cohort module of
 *    story S8.2, and reaching for it here would widen an exception belonging to
 *    another story.
 * 2. **So the Survival identity is empirical, not guaranteed.** It rests on the
 *    2026-08-31 measurement — eight months matching to the row, zero proxy
 *    players. If the proxy ever starts registering into `plan_users`, or the old
 *    database is merged in, this series becomes network-wide again and the
 *    `survival` label would begin to **overstate** arrivals, silently. The
 *    counter-signal is cheap and already collected: `plan.orphan_instance` and
 *    `plan.proxy_registration_alive` both watch this catalogue.
 *
 * Stated rather than assumed because the alternative — dropping a measured
 * 26-month series (`coversFrom` = 2024-06-02) because its label needed a
 * caveat — loses more than it protects, and the owner made the same call for the
 * cohorts of S8.2 on this same population.
 */
export const SURVIVAL_STEP_PROVENANCE =
  'Contagem de `plan_users` (ADR-002 excecao 2). A tabela e a de identidade da ' +
  'rede, mas nesta instalacao guarda so o Survival — medido em 2026-08-31: zero ' +
  'jogadores no proxy e oito meses batendo linha a linha com a coluna ' +
  '`survival` dos numeros verificados. E coincidencia medida, nao garantia de ' +
  'schema: `plan_user_info`, que registraria por servidor, e a excecao 1 do ' +
  'ADR-002 e pertence a S8.2.';

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
