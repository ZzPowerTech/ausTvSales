import type { PaymentSyncRecord, PaymentsStore } from './payments.store';
import { PaymentsSyncService, toDailySeries } from './payments-sync.service';
import type { PlayerPointsDatabase } from './playerpoints.database';

function payment(over: Record<string, unknown> = {}) {
  return {
    transactionType: 'PAY_RECEIVER',
    source: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    receiver: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    amount: 100,
    occurredAt: Date.parse('2026-03-10T15:00:00.000Z'),
    ...over,
  };
}

function previous(read: number): PaymentSyncRecord {
  return {
    id: 1,
    ranAt: new Date('2026-08-31T06:45:00.000Z'),
    status: 'ok',
    paymentsRead: read,
    paymentsWritten: read,
    senderRows: read / 2,
    receiverRows: read / 2,
    creationsRead: 1299,
    creationDaysWritten: 200,
    durationMs: 1500,
    sourceQueryMs: 900,
    detail: null,
  };
}

function harness(
  over: {
    configured?: boolean;
    payments?: jest.Mock;
    accountCreations?: jest.Mock;
    lastSuccessfulSync?: PaymentSyncRecord | null;
    upsertPayments?: jest.Mock;
    replaceCreations?: jest.Mock;
  } = {},
) {
  const upsertPayments =
    over.upsertPayments ??
    jest.fn().mockImplementation((rows: unknown[]) => rows.length);
  const replaceCreations =
    over.replaceCreations ??
    jest.fn().mockImplementation((rows: unknown[]) => rows.length);
  const recordSuccess = jest.fn().mockResolvedValue(undefined);
  const recordFailure = jest.fn().mockResolvedValue(undefined);
  const lastSuccessfulSync = jest
    .fn()
    .mockResolvedValue(over.lastSuccessfulSync ?? null);

  const service = new PaymentsSyncService(
    {
      configured: over.configured ?? true,
      payments: over.payments ?? jest.fn().mockResolvedValue([]),
      // Defaults to ONE creation, not zero. With `[]` as the default, every test
      // in this file executed `replaceCreations([])` — the exact call that wipes
      // the arrivals series — and none of them asserted anything about it. The
      // destructive path ran unnoticed on the happy path.
      accountCreations:
        over.accountCreations ??
        jest
          .fn()
          .mockResolvedValue([
            { occurredAt: Date.parse('2026-03-10T15:00:00Z') },
          ]),
    } as unknown as PlayerPointsDatabase,
    {
      upsertPayments,
      replaceCreations,
      recordSuccess,
      recordFailure,
      lastSuccessfulSync,
    } as unknown as PaymentsStore,
  );

  return {
    service,
    upsertPayments,
    replaceCreations,
    recordSuccess,
    recordFailure,
  };
}

/** One `SET` row, so the happy path is not silently the destructive one. */
function creation(day = '2026-03-10') {
  return { occurredAt: Date.parse(`${day}T15:00:00Z`) };
}

/** First argument of the first call, typed by the caller. */
function firstArg<T>(mock: jest.Mock): T {
  const calls = mock.mock.calls as unknown[][];
  if (calls.length === 0) {
    throw new Error('mock was never called');
  }
  return calls[0][0] as T;
}

describe('toDailySeries', () => {
  it('buckets an evening in Brazil into the Brazilian day', () => {
    // 21:00 BRT is 00:00 UTC the next day; a UTC bucket would move every busy
    // evening on this server into the following day, always in one direction.
    const evening = Date.parse('2026-03-10T21:00:00-03:00');

    expect(toDailySeries([{ occurredAt: evening }])).toEqual([
      { day: '2026-03-10', created: 1 },
    ]);
  });

  it('omits a day with no creations instead of writing a zero', () => {
    // A missing row means "nobody arrived" only when a successful sync covers
    // the range, and the provenance table is what says so. Writing zeros would
    // make an absent day and a measured-empty day identical.
    const series = toDailySeries([
      { occurredAt: Date.parse('2026-03-10T15:00:00Z') },
      { occurredAt: Date.parse('2026-03-12T15:00:00Z') },
    ]);

    expect(series.map((d) => d.day)).toEqual(['2026-03-10', '2026-03-12']);
  });

  it('drops an unusable timestamp instead of filing it under today', () => {
    expect(toDailySeries([{ occurredAt: Number.NaN }])).toEqual([]);
  });

  it('returns days in order', () => {
    const series = toDailySeries([
      { occurredAt: Date.parse('2026-03-12T15:00:00Z') },
      { occurredAt: Date.parse('2026-03-10T15:00:00Z') },
    ]);

    expect(series.map((d) => d.day)).toEqual(['2026-03-10', '2026-03-12']);
  });
});

describe('PaymentsSyncService', () => {
  describe('a successful run', () => {
    it('writes the payments and the arrivals series, and records both timings', async () => {
      const h = harness({
        payments: jest
          .fn()
          .mockResolvedValue([
            payment(),
            payment({ transactionType: 'PAY_SENDER', amount: -100 }),
          ]),
        accountCreations: jest
          .fn()
          .mockResolvedValue([
            { occurredAt: Date.parse('2026-03-10T15:00:00Z') },
          ]),
      });

      const result = await h.service.sync();

      expect(result.status).toBe('ok');
      const recorded = firstArg<{
        paymentsRead: number;
        senderRows: number;
        receiverRows: number;
        creationsRead: number;
        durationMs: number;
        sourceQueryMs: number;
      }>(h.recordSuccess);

      expect(recorded.paymentsRead).toBe(2);
      // The two types counted apart: if they ever stop matching, the assumption
      // that they are the two halves of one payment is wrong.
      expect(recorded.senderRows).toBe(1);
      expect(recorded.receiverRows).toBe(1);
      expect(recorded.creationsRead).toBe(1);
      // The DoD of S9 asks for a timing that proves the ETL costs the game
      // nothing; both numbers have to exist for that to be answerable.
      expect(typeof recorded.durationMs).toBe('number');
      expect(typeof recorded.sourceQueryMs).toBe('number');
    });

    it('assigns tiebreak ordinals before writing', async () => {
      const h = harness({
        payments: jest.fn().mockResolvedValue([payment(), payment()]),
      });

      await h.service.sync();

      const written = firstArg<{ ordinal: number }[]>(h.upsertPayments);
      expect(written.map((p) => p.ordinal)).toEqual([0, 1]);
    });
  });

  describe('the floor rules', () => {
    it('refuses an empty read and keeps the previous copy', async () => {
      const h = harness({
        payments: jest.fn().mockResolvedValue([]),
        lastSuccessfulSync: previous(1332),
      });

      const result = await h.service.sync();

      expect(result.status).toBe('error');
      expect(h.upsertPayments).not.toHaveBeenCalled();
      expect(h.replaceCreations).not.toHaveBeenCalled();
    });

    it('refuses a zero SET read rather than deleting 26 months of arrivals', async () => {
      // The arrivals series is REPLACED, not upserted: a short read does not
      // degrade it, it destroys it. And it is the only record of the
      // mai–jul/2026 proxy blackout, which exists nowhere else to recover from.
      // A log pruned to 30 days, or a renamed `SET` label, would have deleted it
      // and committed — then written an `ok` provenance row on top.
      const h = harness({
        payments: jest.fn().mockResolvedValue([payment()]),
        accountCreations: jest.fn().mockResolvedValue([]),
        lastSuccessfulSync: previous(1332),
      });

      const result = await h.service.sync();

      expect(result.status).toBe('error');
      expect(result.detail).toContain('26 meses');
      expect(h.replaceCreations).not.toHaveBeenCalled();
      // The payments copy is untouched too: the run refuses as a whole.
      expect(h.upsertPayments).not.toHaveBeenCalled();
    });

    it('refuses a SET read that collapsed against the last successful run', async () => {
      // A healthy payments read, so the failure can only come from the SET side
      // — otherwise the payments floor trips first and the test proves nothing.
      const h = harness({
        payments: jest
          .fn()
          .mockResolvedValue(Array.from({ length: 1332 }, () => payment())),
        accountCreations: jest
          .fn()
          .mockResolvedValue(Array.from({ length: 100 }, () => creation())),
        lastSuccessfulSync: previous(1332),
      });

      const result = await h.service.sync();

      expect(result.status).toBe('error');
      expect(result.detail).toContain('100 linhas');
      expect(h.replaceCreations).not.toHaveBeenCalled();
    });

    it('refuses a read that collapsed against the last successful run', async () => {
      // A short feed that does not look broken is the worst degradation a
      // moderation tool can have.
      const h = harness({
        payments: jest
          .fn()
          .mockResolvedValue(Array.from({ length: 100 }, () => payment())),
        accountCreations: jest
          .fn()
          .mockResolvedValue(Array.from({ length: 1299 }, () => creation())),
        lastSuccessfulSync: previous(1332),
      });

      const result = await h.service.sync();

      expect(result.status).toBe('error');
      expect(result.detail).toContain('100 pagamentos contra 1332');
    });

    it('writes the arrivals series when both reads are healthy', async () => {
      const h = harness({
        payments: jest.fn().mockResolvedValue([payment()]),
        accountCreations: jest
          .fn()
          .mockResolvedValue([creation('2026-03-10'), creation('2026-03-12')]),
      });

      expect((await h.service.sync()).status).toBe('ok');

      const written = firstArg<{ day: string; created: number }[]>(
        h.replaceCreations,
      );
      expect(written).toEqual([
        { day: '2026-03-10', created: 1 },
        { day: '2026-03-12', created: 1 },
      ]);
    });

    it('accepts the first run, which has nothing to compare against', async () => {
      const h = harness({
        payments: jest.fn().mockResolvedValue([payment()]),
        lastSuccessfulSync: null,
      });

      expect((await h.service.sync()).status).toBe('ok');
    });
  });

  describe('failures never take the previous copy down', () => {
    it('records an error when PlayerPoints is unconfigured, without querying', async () => {
      const payments = jest.fn();
      const h = harness({ configured: false, payments });

      const result = await h.service.sync();

      expect(result.status).toBe('error');
      expect(payments).not.toHaveBeenCalled();
    });

    it('records an error when the source query fails', async () => {
      const h = harness({
        payments: jest
          .fn()
          .mockRejectedValue(new Error("Access denied for 'pp_ro'@'10.0.0.5'")),
      });

      const result = await h.service.sync();

      expect(result.status).toBe('error');
      expect(h.upsertPayments).not.toHaveBeenCalled();
      // The message names a host and an account; it goes to the log, not to the
      // row that a route could one day publish (CWE-209).
      const recorded = firstArg<{ detail: string }>(h.recordFailure);
      expect(recorded.detail).not.toContain('10.0.0.5');
      expect(recorded.detail).not.toContain('pp_ro');
    });

    it('records an error when the write fails', async () => {
      const h = harness({
        payments: jest.fn().mockResolvedValue([payment()]),
        upsertPayments: jest.fn().mockRejectedValue(new Error('deadlock')),
      });

      expect((await h.service.sync()).status).toBe('error');
      expect(h.recordFailure).toHaveBeenCalled();
    });
  });
});
