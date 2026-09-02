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
  /** Why `from`, `to` and `funding_many` rest on an unconfirmed reading. */
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
 * The one caveat a mark can be wrong *about*, rather than merely imprecise.
 *
 * That `receiver` holds the credited account and `source` the counterparty is
 * the natural reading of the schema and **has not been confirmed against a known
 * payment** — the copy's own schema comment says so. Every other caveat in this
 * module travels in the payload; this one lived only in a source comment, while
 * the feed printed `from`/`to` as fact and issued `funding_many` keyed on
 * `source`.
 *
 * If the reading is inverted, a staff member sees uuid X flagged as funding nine
 * people when X is the account that *received* from nine. The
 * `senderRows`/`receiverRows` counter in the ETL detects a broken **pairing**,
 * not an inverted **direction**: 666/666 is consistent with either.
 */
export const PAYMENT_DIRECTION_CAVEAT =
  'A DIRECAO e inferida, nao confirmada. Que `receiver` seja a conta creditada ' +
  'e `source` a contraparte e a leitura natural do schema do PlayerPoints e ' +
  'nunca foi conferida contra um pagamento conhecido. Se estiver invertida, ' +
  '`from`/`to` estao trocados e a marca `funding_many` aponta para quem ' +
  'RECEBEU de muitos, nao para quem financiou. O contador de PAY_SENDER x ' +
  'PAY_RECEIVER do ETL detecta pareamento quebrado, nao direcao invertida: ' +
  '666/666 e compativel com as duas leituras. Conferir contra um pagamento ' +
  'conhecido custa um comando no jogo.';

export const FEED_DISCLAIMER =
  'Marcacao e SINALIZACAO, nunca acusacao automatica: cada marca diz o que foi ' +
  'observado e contra que limiar, e a decisao e humana. Um pagamento marcado ' +
  'nao e prova de nada — valor alto, par repetido e conta nova recebendo muito ' +
  'sao tambem o formato de um presente entre amigos. Este feed e ' +
  'exclusivamente administrativo: nome de jogador e valor de transacao nao ' +
  'aparecem no site publico sob nenhuma hipotese (secao 8, LGPD).';
