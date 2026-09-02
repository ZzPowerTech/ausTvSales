import { ConfigService } from '@nestjs/config';
import type { DrizzleDB } from '../db/database.module';
import { PaymentsFeedService } from './payments-feed.service';
import type {
  PaymentSyncRecord,
  PaymentsStore,
  StoredPayment,
} from './payments.store';

const SYNCED: PaymentSyncRecord = {
  id: 1,
  ranAt: new Date('2026-09-01T06:45:00.000Z'),
  status: 'ok',
  paymentsRead: 1332,
  paymentsWritten: 1332,
  senderRows: 666,
  receiverRows: 666,
  creationsRead: 1299,
  creationDaysWritten: 200,
  durationMs: 1400,
  sourceQueryMs: 800,
  detail: null,
};

function config(values: Record<string, unknown> = {}): ConfigService {
  return {
    get: <T>(key: string): T | undefined => values[key] as T | undefined,
  } as unknown as ConfigService;
}

function payment(over: Partial<StoredPayment> = {}): StoredPayment {
  return {
    transactionType: 'PAY_RECEIVER',
    source: 'sender-1',
    receiver: 'receiver-1',
    amount: 100,
    occurredAt: new Date('2026-08-30T15:00:00.000Z'),
    ordinal: 0,
    ...over,
  };
}

function service(
  payments: StoredPayment[],
  options: {
    last?: PaymentSyncRecord | null;
    settings?: Record<string, unknown>;
    registrations?: { uuid: string; registered_at: Date }[];
  } = {},
): PaymentsFeedService {
  const db = {
    execute: jest.fn().mockResolvedValue({ rows: options.registrations ?? [] }),
  } as unknown as DrizzleDB;

  const store = {
    allPaymentsSince: jest.fn().mockResolvedValue(payments),
    lastSuccessfulSync: jest
      .fn()
      .mockResolvedValue(options.last === undefined ? SYNCED : options.last),
  } as unknown as PaymentsStore;

  return new PaymentsFeedService(db, store, config(options.settings));
}

/** Twenty ordinary payments, so the outlier mark is allowed to exist. */
function background(): StoredPayment[] {
  return Array.from({ length: 20 }, (_, i) =>
    payment({
      source: `sender-bg-${i}`,
      receiver: `receiver-bg-${i}`,
      amount: 10,
    }),
  );
}

describe('PaymentsFeedService', () => {
  describe('degradation', () => {
    it('returns null with a reason when the ETL never ran', async () => {
      // An empty list in a moderation tool reads as "no payments happened",
      // which is the worst possible wrong reading here.
      const report = await service([], { last: null }).feed();

      expect(report.payments).toBeNull();
      expect(report.unavailableReason).toContain('nunca completou');
      expect(report.sources[0]).toMatchObject({ failure: 'never_synced' });
    });
  });

  describe('what the feed reads', () => {
    it('ignores PAY_SENDER, so each payment appears once', async () => {
      // Both sides are copied, and counting both would double every pair count.
      const report = await service([
        payment(),
        payment({ transactionType: 'PAY_SENDER', amount: -100 }),
      ]).feed();

      expect(report.payments).toHaveLength(1);
      expect(report.windowSize).toBe(1);
    });

    it('publishes the thresholds so a mark can be judged', async () => {
      const report = await service([payment()], {
        settings: {
          ECONOMY_FEED_REPEATED_PAIR_MIN: 5,
          ECONOMY_FEED_FUNDING_MANY_MIN: 6,
          ECONOMY_FEED_NEW_ACCOUNT_DAYS: 7,
          ECONOMY_FEED_MIN_WINDOW_FOR_OUTLIER: 8,
        },
      }).feed();

      expect(report.thresholds).toEqual({
        repeatedPair: 5,
        fundingMany: 6,
        newAccountDays: 7,
        minWindowSizeForOutlier: 8,
      });
    });

    it('carries the "signalling, never accusation" rule in every response', async () => {
      const report = await service([payment()]).feed();

      expect(report.disclaimer).toContain('nunca acusacao automatica');
      expect(report.disclaimer).toContain('site publico');
    });

    it('carries what the direction check found, including the column swap', async () => {
      // `from`/`to` and `funding_many` all rest on the reading that `receiver`
      // is the credited account — natural, and never confirmed against a known
      // payment. Every other caveat in this module travels in the payload; this
      // one lived only in a source comment while the feed printed it as fact.
      const report = await service([payment()]).feed();

      // Confirmed on 2026-09-02, and what the check found is worth carrying: the
      // two ledger rows of one payment swap `source` and `receiver`, so the
      // column names are only true once the row type is pinned.
      expect(report.directionCaveat).toContain('CONFIRMADA');
      expect(report.directionCaveat).toContain('TROCAM as colunas');
      expect(report.directionCaveat).toContain('funding_many');
    });

    it('carries the direction note even when there is nothing to show', async () => {
      const report = await service([], { last: null }).feed();

      expect(report.payments).toBeNull();
      expect(report.directionCaveat).toContain('TROCAM as colunas');
    });
  });

  describe('the outlier mark', () => {
    it('abstains on a window too small for a percentile to mean anything', async () => {
      // A p95 over four observations is the maximum of four observations.
      const report = await service([
        payment({ amount: 1 }),
        payment({ amount: 60_000, source: 'sender-2', receiver: 'receiver-2' }),
      ]).feed();

      expect(report.amountP95).toBeNull();
      expect(report.payments?.every((p) => p.flags.length === 0)).toBe(true);
    });

    it('marks the outlier with the value and the threshold', async () => {
      const payments = [
        payment({ amount: 60_000, source: 'whale', receiver: 'receiver-x' }),
        ...background(),
      ];

      const report = await service(payments).feed();

      const marked = report.payments?.find((p) => p.amount === 60_000);
      expect(marked?.flags).toContainEqual({
        flag: 'amount_outlier',
        observed: 60_000,
        threshold: report.amountP95,
      });
    });

    it('computes the percentile over the window, not over the page', async () => {
      // A mark that changed meaning with the page size would be useless for
      // moderation.
      const payments = [
        payment({ amount: 60_000, source: 'whale', receiver: 'receiver-x' }),
        ...background(),
      ];

      const page = await service(payments).feed(30, 1);

      expect(page.windowSize).toBe(21);
      expect(page.payments).toHaveLength(1);
      expect(page.amountP95).not.toBeNull();
    });
  });

  describe('the pair and fan-out marks', () => {
    it('marks a repeated sender to receiver pair', async () => {
      const repeated = Array.from({ length: 3 }, () =>
        payment({ source: 'sender-r', receiver: 'receiver-r' }),
      );

      const report = await service([...repeated, ...background()]).feed();

      const marked = report.payments?.find((p) => p.from === 'sender-r');
      expect(marked?.flags).toContainEqual({
        flag: 'repeated_pair',
        observed: 3,
        threshold: 3,
      });
    });

    it('marks one sender funding many distinct receivers', async () => {
      const fanOut = Array.from({ length: 4 }, (_, i) =>
        payment({ source: 'funder', receiver: `receiver-f-${i}` }),
      );

      const report = await service([...fanOut, ...background()]).feed();

      const marked = report.payments?.find((p) => p.from === 'funder');
      expect(marked?.flags).toContainEqual({
        flag: 'funding_many',
        observed: 4,
        threshold: 4,
      });
    });
  });

  describe('the new-account mark', () => {
    it('marks a recently registered account receiving an outlier', async () => {
      const payments = [
        payment({ amount: 60_000, source: 'whale', receiver: 'fresh' }),
        ...background(),
      ];

      const report = await service(payments, {
        registrations: [
          {
            uuid: 'fresh',
            registered_at: new Date('2026-08-29T15:00:00.000Z'),
          },
        ],
      }).feed();

      const marked = report.payments?.find((p) => p.to === 'fresh');
      expect(marked?.flags).toContainEqual({
        flag: 'new_account_high_value',
        observed: 1,
        threshold: 3,
      });
    });

    it('does not mark when the registration is unknown', async () => {
      // An unknown registration is not evidence of a new account; treating it
      // as one would flag every player the dimension has not synced yet.
      const payments = [
        payment({ amount: 60_000, source: 'whale', receiver: 'unknown' }),
        ...background(),
      ];

      const report = await service(payments, { registrations: [] }).feed();

      const marked = report.payments?.find((p) => p.to === 'unknown');
      expect(
        marked?.flags.some((f) => f.flag === 'new_account_high_value'),
      ).toBe(false);
    });

    it('does not mark when the payment predates the known registration', async () => {
      const payments = [
        payment({ amount: 60_000, source: 'whale', receiver: 'later' }),
        ...background(),
      ];

      const report = await service(payments, {
        registrations: [
          {
            uuid: 'later',
            registered_at: new Date('2026-09-05T15:00:00.000Z'),
          },
        ],
      }).feed();

      const marked = report.payments?.find((p) => p.to === 'later');
      expect(
        marked?.flags.some((f) => f.flag === 'new_account_high_value'),
      ).toBe(false);
    });

    it('keeps the feed usable when the registration lookup fails', async () => {
      const db = {
        execute: jest.fn().mockRejectedValue(new Error('connection reset')),
      } as unknown as DrizzleDB;
      const store = {
        allPaymentsSince: jest.fn().mockResolvedValue([payment()]),
        lastSuccessfulSync: jest.fn().mockResolvedValue(SYNCED),
      } as unknown as PaymentsStore;

      const report = await new PaymentsFeedService(db, store, config()).feed();

      // The mark is a nicety; the feed is the product.
      expect(report.payments).toHaveLength(1);
    });
  });

  describe('an ordinary payment', () => {
    it('carries no flags at all', async () => {
      const report = await service(background()).feed();

      expect(report.payments?.every((p) => p.flags.length === 0)).toBe(true);
    });
  });
});
