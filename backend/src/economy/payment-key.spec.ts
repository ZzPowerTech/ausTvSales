import { assignOrdinals, naturalKey } from './payment-key';
import type { PaymentRow } from './playerpoints.database';

function payment(over: Partial<PaymentRow> = {}): PaymentRow {
  return {
    transactionType: 'PAY_RECEIVER',
    source: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    receiver: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    amount: 100,
    occurredAt: Date.parse('2026-03-10T15:00:00.000Z'),
    ...over,
  };
}

describe('naturalKey', () => {
  it('is injective for inputs a joined key would collide', () => {
    // `('a', 'bc')` and `('ab', 'c')` are the classic pair a separator-joined
    // key merges, and `source`/`receiver` are strings from someone else's
    // database — so "that character cannot appear" is a guess, not a fact.
    const left = naturalKey(payment({ source: 'a', receiver: 'bc' }));
    const right = naturalKey(payment({ source: 'ab', receiver: 'c' }));

    expect(left).not.toBe(right);
  });

  it('is stable for the same row', () => {
    expect(naturalKey(payment())).toBe(naturalKey(payment()));
  });

  it('separates rows that differ in any single field', () => {
    const base = naturalKey(payment());
    const variants = [
      payment({ transactionType: 'PAY_SENDER' }),
      payment({ source: 'other' }),
      payment({ receiver: 'other' }),
      payment({ amount: 101 }),
      payment({ occurredAt: Date.parse('2026-03-10T15:00:01.000Z') }),
    ];

    for (const variant of variants) {
      expect(naturalKey(variant)).not.toBe(base);
    }
  });
});

describe('assignOrdinals', () => {
  describe('the deliberate collision', () => {
    // Criterion 8 of the story asks for the tiebreak rule to be tested with an
    // intentional collision. Two players genuinely paying the same amount to
    // the same person in the same second is not hypothetical — the source table
    // has no primary key, so it records that as two identical rows.
    const identical = [payment(), payment(), payment()];

    it('keeps every one of them, with distinct ordinals', () => {
      const keyed = assignOrdinals(identical);

      expect(keyed).toHaveLength(3);
      expect(keyed.map((p) => p.ordinal)).toEqual([0, 1, 2]);
    });

    it('would lose a payment if the rows were merged', () => {
      // Guarding the property rather than the implementation: whatever the code
      // does, three source rows must produce three addressable rows.
      const addresses = new Set(
        assignOrdinals(identical).map((p) => `${naturalKey(p)}#${p.ordinal}`),
      );

      expect(addresses.size).toBe(3);
    });
  });

  describe('idempotency', () => {
    it('gives the same ordinals to the same input, twice', () => {
      // This is what makes re-running the ETL a no-op instead of a duplication.
      const rows = [payment(), payment({ amount: 50 }), payment()];

      expect(assignOrdinals(rows).map((p) => p.ordinal)).toEqual(
        assignOrdinals(rows).map((p) => p.ordinal),
      );
    });

    it('counts each natural key separately', () => {
      const rows = [
        payment(),
        payment({ amount: 50 }),
        payment(),
        payment({ amount: 50 }),
      ];

      expect(assignOrdinals(rows).map((p) => p.ordinal)).toEqual([0, 0, 1, 1]);
    });
  });

  it('leaves every original field untouched', () => {
    const [keyed] = assignOrdinals([payment({ amount: -60_000 })]);

    expect(keyed).toMatchObject({
      transactionType: 'PAY_RECEIVER',
      amount: -60_000,
      ordinal: 0,
    });
  });

  it('handles an empty read without inventing a row', () => {
    expect(assignOrdinals([])).toEqual([]);
  });
});
