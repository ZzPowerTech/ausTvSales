import type { EconomySourceState, Share } from './economy.types';

/**
 * E3 and E4 — the social half of the economy layer (story S9.1, spec §6.4).
 *
 * ## The label these numbers cannot be published without
 *
 * The "D7" here is the **survival interval** of the retention module, not
 * return-on-day-7: it comes from `player_dimension.last_seen_at`, which is
 * `/v1/retention`'s `lastSeenDate`. Every caveat the retention module carries
 * applies unchanged, and the reason it is repeated rather than referenced is
 * that this payload is read on its own.
 */
export const SOCIAL_D7_SEMANTICS =
  'D7 aqui e INTERVALO DE SOBREVIVENCIA: o jogador ainda era visto 7 dias ' +
  'depois de registrar, nao "voltou no setimo dia". Vem de ' +
  '`player_dimension.last_seen_at`, que e o `lastSeenDate` do `/v1/retention`. ' +
  'As duas leituras sao perguntas diferentes e esta responde a primeira.';

/**
 * Why separating the tutorial payment from spontaneous contact is a heuristic.
 *
 * The `10tutorial` step requires `/pagar <nick> 100`, so a payment of exactly
 * that amount from a newcomer is *probably* the tutorial rather than a social
 * act — and the spec is explicit that separating the two is a requirement, not a
 * detail.
 *
 * What it is **not** is a fact. The log records an amount, not an intent, and a
 * genuinely spontaneous payment of exactly 100 is indistinguishable from the
 * tutorial step. So the separation is published as what it is: a split by amount
 * signature, with the amount stated, so a reader can judge it instead of
 * inheriting a false precision.
 *
 * A player with both a matching and a non-matching payment counts as
 * **spontaneous**: the tutorial explains one payment, never two.
 */
export const TUTORIAL_SEPARATION_CAVEAT =
  'A separacao entre o passo `10tutorial` e interacao espontanea e por ' +
  'ASSINATURA DE VALOR, nao por intencao: o passo exige `/pagar <nick> 100`, ' +
  'entao um pagamento exatamente desse valor e provavelmente o tutorial. Um ' +
  'pagamento espontaneo de exatamente 100 e indistinguivel dele. Quem tem um ' +
  'pagamento fora da assinatura conta como espontaneo — o tutorial explica um ' +
  'pagamento, nunca dois.';

/** How a newcomer's first minutes went, socially. */
export const CONTACT_GROUPS = [
  /** Had at least one payment that does not match the tutorial signature. */
  'spontaneous',
  /** Every payment in the window matched the tutorial amount. */
  'tutorial_only',
  /** No payment at all in the window. */
  'none',
] as const;

export type ContactGroup = (typeof CONTACT_GROUPS)[number];

/** One group, and how it survived. */
export interface ContactGroupResult {
  group: ContactGroup;
  /** Players in this group. **Not** the base for `d7` — see that field. */
  players: number;
  /**
   * Share of the group still seen 7 days after registering.
   *
   * The base is `players - immature`, **not** `players`: a player whose seven
   * days have not elapsed cannot have an outcome, and leaving them in the
   * denominator would drag every group down by however many of them it happens
   * to contain. `Share.n` carries the real base.
   */
  d7: Share;
  /**
   * Players whose 7-day window has not closed yet, excluded from `d7`.
   *
   * Counted and published: a cohort three days old would otherwise drag every
   * group's D7 down by exactly the number of immature players in it, and the
   * effect is invisible without this number.
   */
  immature: number;
}

/** E3 — social contact in the first minutes, and the D7 of that group. */
export interface SocialContactReport {
  /** First cohort month included. */
  from: string;
  /** Last cohort month included. */
  to: string;
  /** Minutes after registration counted as "the first minutes". */
  contactWindowMinutes: number;
  /** Amount that marks a payment as the `10tutorial` step. */
  tutorialPaymentAmount: number;
  /** What the D7 in this payload means. Carried, never assumed. */
  d7Semantics: string;
  /** Why the tutorial split is a heuristic. Carried for the same reason. */
  tutorialSeparationCaveat: string;
  groups: ContactGroupResult[] | null;
  /** Set exactly when `groups` is null. */
  unavailableReason?: string;
  sources: EconomySourceState[];
}

/** Why one payment in the feed is worth a human look. */
export const PAYMENT_FLAGS = [
  /**
   * Amount **strictly above** the window's 95th percentile.
   *
   * Strictly, and not "at or above": in a window whose amounts are all equal
   * every row sits at its own p95, and `>=` would mark the entire feed — which
   * is how a signal becomes noise and then becomes ignored.
   *
   * This is a **tail marker**, not a statistical test. In a window with real
   * dispersion it marks roughly the top 5% by construction, which is what a feed
   * that exists to surface candidates for a human should do.
   */
  'amount_outlier',
  /** The same sender→receiver pair repeated in the window. */
  'repeated_pair',
  /** A recently registered account receiving an outlier amount. */
  'new_account_high_value',
  /** One sender paying many distinct receivers in the window. */
  'funding_many',
] as const;

export type PaymentFlag = (typeof PAYMENT_FLAGS)[number];

/**
 * A flag on one payment, with the evidence behind it.
 *
 * The evidence is not decoration. Spec §6.4 is explicit: *"marcar é
 * sinalização, **nunca acusação automática** — a decisão é humana."* A flag
 * without its numbers asks a person to trust a threshold they cannot see, which
 * is the opposite of leaving the decision with them.
 */
export interface FlagMark {
  flag: PaymentFlag;
  /** What was observed — the pair count, the sender's fan-out, the amount. */
  observed: number;
  /** What it was compared against. */
  threshold: number;
}

/** One payment in the moderation feed. */
export interface FeedPayment {
  /** ISO-8601. */
  occurredAt: string;
  /** Counterparty uuid, as the source records it. */
  from: string;
  /** Credited uuid, as the source records it. */
  to: string;
  amount: number;
  /** Empty for an ordinary payment. */
  flags: FlagMark[];
}

/** E4 — the admin-only payments feed. */
export interface PaymentsFeedReport {
  /** Days of history the window covers. */
  windowDays: number;
  /** Payments in the window, before the display cap. */
  windowSize: number;
  /** The 95th percentile of amounts in the window, or null with too few. */
  amountP95: number | null;
  /** Thresholds in force, published so a mark can be judged. */
  thresholds: {
    repeatedPair: number;
    fundingMany: number;
    newAccountDays: number;
    minWindowSizeForOutlier: number;
  };
  /** Newest first, capped. */
  payments: FeedPayment[] | null;
  /** Set exactly when `payments` is null. */
  unavailableReason?: string;
  /** The rule that governs how this feed may be used. */
  disclaimer: string;
  /**
   * What the column layout is measured to be, and why `from`, `to` and
   * `funding_many` still rest on an unconfirmed reading of it.
   */
  directionCaveat: string;
  sources: EconomySourceState[];
}

/**
 * What the flags mean, in the payload, every time.
 *
 * A moderation tool that ships its own limits inside the response is harder to
 * misuse than one whose limits live in a spec nobody opens while looking at a
 * suspicious row.
 */
/**
 * The one row type this system reads, and the reason it is the one.
 *
 * ## The two rows swap their columns, and that is the whole point
 *
 * Confirmed against a real payment on 2026-09-02. PlayerPoints logs each
 * transfer **twice**, and the pair is not two copies of one description — the
 * `source` and `receiver` columns trade places between them:
 *
 * ```
 * PAY_RECEIVER  source=<pagador>   receiver=<creditado>  amount=+35
 * PAY_SENDER    source=<creditado> receiver=<pagador>    amount=-35
 * ```
 *
 * So `receiver` names the credited account on one row and the payer on the
 * other, and there is no reading of `source`/`receiver` that is true for both.
 * The type has to be pinned before the columns mean anything.
 *
 * `PAY_RECEIVER` is the one pinned, because it is the row carrying the positive
 * amount — what a human reads as "the payment".
 *
 * ⚠️ Any query over `player_payments` that does **not** filter on this reads
 * both rows of every payment — doubling counts, and mixing two opposite column
 * meanings into one result. Pinning the type is a prerequisite for the columns
 * to mean anything; it is **not**, on its own, an answer to which one is the
 * payer. See {@link PAYMENT_DIRECTION_CAVEAT}.
 */
export const CANONICAL_PAYMENT_TYPE = 'PAY_RECEIVER';

/**
 * The one caveat a mark can be wrong *about*, rather than merely imprecise.
 *
 * ## What the 2026-09-02 read established, and what it did not
 *
 * It established that the two rows of one payment **swap** `source` and
 * `receiver` and negate the amount. That is real and it is why
 * {@link CANONICAL_PAYMENT_TYPE} exists.
 *
 * It did **not** establish the direction, and the first version of this comment
 * claimed it had. The observed pair is a perfect mirror, so two readings survive
 * it intact:
 *
 * - `receiver` is the **subject** of the row and `source` the counterparty — on
 *   a `PAY_RECEIVER` row that makes `source` the payer, which is what this
 *   module assumes;
 * - `source` is the subject and `receiver` the counterparty — which inverts
 *   every `from`/`to` and points `funding_many` at the account that *received*
 *   from many.
 *
 * Nothing in the pair breaks the tie. Not the sign (the `+` sits on the
 * receiver's row under both), not the type names (both readings agree those name
 * the row's subject), not the timestamps. "The columns swap" is a consequence of
 * the symmetry, not evidence against it.
 *
 * ## What would settle it, and it is a `SELECT`
 *
 * A row type with only **one** real party — `SET` (the arrivals series) or
 * `OFFSET` (the administrative grant). Whichever column carries the real player
 * uuid there is the subject, and the direction follows by deduction with no
 * symmetry left to hide in. Worth noting that this codebase already bets on the
 * first reading: `PlayerPointsDatabase.accountCreations` declines to select
 * `receiver` from a `SET` row *because that is the player*. A bet is not a
 * measurement, which is exactly why this caveat still travels.
 */

export const PAYMENT_DIRECTION_CAVEAT =
  'MEDIDO em 2026-09-02: o PlayerPoints grava DUAS linhas por transferencia e ' +
  'elas TROCAM `source` e `receiver` entre si, com o amount negado. Logo nenhuma ' +
  'leitura dessas colunas vale para as duas linhas, e filtrar por ' +
  '`transaction_type` e pre-requisito para elas significarem qualquer coisa — ' +
  'quem consultar `player_payments` direto sem filtrar mistura duas leituras ' +
  'opostas no mesmo resultado. ' +
  'A DIRECAO, essa, CONTINUA INFERIDA: o par observado e um espelho perfeito, ' +
  'entao ele e compativel tanto com `receiver` sendo o SUJEITO da linha (o que ' +
  'faz `source` ser o pagador na `PAY_RECEIVER`, que e o que este feed assume) ' +
  'quanto com `source` sendo o sujeito, que inverteria tudo. Se estiver ' +
  'invertida, `from`/`to` estao trocados e `funding_many` aponta para quem ' +
  'RECEBEU de muitos, nao para quem financiou. O contador de PAY_SENDER x ' +
  'PAY_RECEIVER do ETL detecta pareamento quebrado, nao direcao invertida. ' +
  'O que resolve e uma linha de tipo UNILATERAL (`SET` ou `OFFSET`): a coluna ' +
  'que carrega o uuid do jogador real ali e o sujeito, e a direcao sai por ' +
  'deducao. Custa um SELECT.';

export const FEED_DISCLAIMER =
  'Marcacao e SINALIZACAO, nunca acusacao automatica: cada marca diz o que foi ' +
  'observado e contra que limiar, e a decisao e humana. Um pagamento marcado ' +
  'nao e prova de nada — valor alto, par repetido e conta nova recebendo muito ' +
  'sao tambem o formato de um presente entre amigos. Este feed e ' +
  'exclusivamente administrativo: nome de jogador e valor de transacao nao ' +
  'aparecem no site publico sob nenhuma hipotese (secao 8, LGPD).';
