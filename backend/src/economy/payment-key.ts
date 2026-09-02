import type { PaymentRow } from './playerpoints.database';

/** A payment row with the ordinal that makes it addressable. */
export interface KeyedPayment extends PaymentRow {
  /** 0 for the first row identical to this one, 1 for the second, and so on. */
  ordinal: number;
}

/**
 * Assign the tiebreak ordinal that gives each source row a stable identity
 * (story S9.1, criterion 8).
 *
 * ## The problem this exists for
 *
 * `playerpoints_transaction_log` has **no primary key** — measured 2026-08-21,
 * along with the absence of every other index. So a row has no identity of its
 * own, and the ETL has to invent one that survives being re-derived every night.
 *
 * The natural key `(transaction_type, source, receiver, amount, occurred_at)` is
 * almost enough, and the gap is real rather than theoretical: two players can
 * genuinely pay the same amount to the same person inside the same second, and
 * the log records that as two byte-identical rows. Whatever the ETL does with
 * them, it has to do the same thing every night:
 *
 * - **Collapse them** → one payment silently disappears, forever. The feed E4
 *   exists to catch abuse would be the first thing to lose a row.
 * - **Give each run a fresh surrogate key** → every row is new every night, and
 *   the table grows by the whole population each time.
 * - **Count them within the run** → what this does. The same input reproduces
 *   the same ordinals, so re-running is a no-op; two real duplicates keep
 *   ordinals 0 and 1 and both survive.
 *
 * ## The determinism is not free, and it lives upstream
 *
 * This function counts in the order it is given. That order is imposed by the
 * `ORDER BY` in `PlayerPointsDatabase.payments()`, and without it MySQL is free
 * to return identical rows differently on each run — which would shuffle the
 * ordinals and turn a re-read into a set of inserts. The two halves are one
 * mechanism; changing either alone breaks idempotency.
 *
 * ⚠️ One property worth stating because it is a genuine limitation: if the
 * upstream ever **deletes** one of two identical rows, this assigns the survivor
 * ordinal 0, and the copy keeps the orphaned ordinal-1 row until something
 * prunes it. The ETL does not delete, by choice — an absent row is far more
 * often a degraded read than a real deletion, and this domain has no update
 * path that would produce one.
 */
export function assignOrdinals(
  payments: readonly PaymentRow[],
): KeyedPayment[] {
  const seen = new Map<string, number>();

  return payments.map((payment) => {
    const key = naturalKey(payment);
    const ordinal = seen.get(key) ?? 0;
    seen.set(key, ordinal + 1);
    return { ...payment, ordinal };
  });
}

/**
 * The five fields that identify a payment before the tiebreak.
 *
 * Serialised as JSON rather than joined by a separator, and that is not
 * fastidiousness: `source` and `receiver` are strings from someone else's
 * database, and any separator character picked as "impossible" is a guess about
 * data this system does not control. A joined key lets `('a', 'bc')` and
 * `('ab', 'c')` collide the moment that guess is wrong — the classic way a
 * unique key silently stops being one. JSON escaping makes the encoding
 * injective by construction, for any input at all.
 */
export function naturalKey(payment: PaymentRow): string {
  return JSON.stringify([
    payment.transactionType,
    payment.source,
    payment.receiver,
    payment.amount,
    payment.occurredAt,
  ]);
}
