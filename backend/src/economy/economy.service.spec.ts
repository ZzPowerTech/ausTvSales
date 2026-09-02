import type { DrizzleDB } from '../db/database.module';
import { EconomyService } from './economy.service';
import type {
  DimensionSyncRecord,
  PlayerDimensionStore,
} from './player-dimension.store';

const PREMIUM = (i: number) =>
  `11111111-1111-4111-8111-${String(i).padStart(12, '0')}`;
const BEDROCK = (i: number) =>
  `00000000-0000-0000-0009-${String(i).padStart(12, '0')}`;

/** A successful ETL run, so cohorts are publishable. */
const SYNCED: DimensionSyncRecord = {
  id: 1,
  ranAt: new Date('2026-09-01T06:30:00.000Z'),
  status: 'ok',
  rowsRead: 5565,
  rowsWritten: 5565,
  rowsDropped: 0,
  durationMs: 800,
  detail: null,
};

/**
 * Stub the Drizzle handle with one result per call, in order.
 *
 * `revenue()` issues the buyer query and then the historical-exclusion query;
 * `firstSpend()` issues one. Order is deterministic because both are started
 * synchronously inside the same `Promise.all`.
 */
function dbWith(results: { rows: unknown[] }[]): DrizzleDB {
  const execute = jest.fn();
  for (const result of results) {
    execute.mockResolvedValueOnce(result);
  }
  return { execute } as unknown as DrizzleDB;
}

function dimensionStore(
  last: DimensionSyncRecord | null,
): PlayerDimensionStore {
  return {
    lastSuccessfulSync: jest.fn().mockResolvedValue(last),
  } as unknown as PlayerDimensionStore;
}

function buyer(
  uuid: string,
  cents: string,
  sales: number,
  cohort: string | null,
) {
  return { player_uuid: uuid, revenue_cents: cents, sales, cohort };
}

describe('EconomyService.revenue (E1)', () => {
  it('groups by the platform derived from the uuid, and publishes the share with its base', async () => {
    const db = dbWith([
      {
        rows: [
          buyer(PREMIUM(1), '6000', 3, '2026-01'),
          buyer(PREMIUM(2), '2000', 1, '2026-02'),
          buyer(BEDROCK(3), '2000', 2, '2026-01'),
        ],
      },
      { rows: [{ sales: 0, revenue_cents: '0' }] },
    ]);

    const report = await new EconomyService(db, dimensionStore(SYNCED)).revenue(
      null,
      null,
    );

    expect(report.totals).toEqual({
      revenue: '100.00',
      sales: 6,
      buyers: 3,
    });
    expect(report.byPlatform).toEqual([
      {
        platform: 'bedrock',
        revenue: '20.00',
        sales: 2,
        buyers: 1,
        share: { percent: 20, n: 2 },
      },
      {
        platform: 'java_premium',
        revenue: '80.00',
        sales: 4,
        buyers: 2,
        share: { percent: 80, n: 4 },
      },
    ]);
  });

  it('never publishes a share without its base', async () => {
    const db = dbWith([
      { rows: [buyer(PREMIUM(1), '1234', 1, null)] },
      { rows: [{ sales: 0, revenue_cents: '0' }] },
    ]);

    const report = await new EconomyService(db, dimensionStore(SYNCED)).revenue(
      null,
      null,
    );

    for (const platform of report.byPlatform) {
      if (platform.share.percent !== null) {
        expect(platform.share.n).not.toBeNull();
      }
    }
  });

  it('returns null — not 0% — for a share over an empty base', async () => {
    const db = dbWith([
      { rows: [buyer(PREMIUM(1), '0', 1, '2026-01')] },
      { rows: [{ sales: 0, revenue_cents: '0' }] },
    ]);

    const report = await new EconomyService(db, dimensionStore(SYNCED)).revenue(
      null,
      null,
    );

    expect(report.byPlatform[0].share.percent).toBeNull();
    expect(report.byPlatform[0].share.n).toBe(1);
  });

  describe('the cohort axis', () => {
    it('is null with a reason when the dimension never synced', async () => {
      // An empty array would read as "no cohort produced revenue", which is the
      // confusion the whole epic exists to remove.
      const db = dbWith([
        { rows: [buyer(PREMIUM(1), '5000', 1, null)] },
        { rows: [{ sales: 0, revenue_cents: '0' }] },
      ]);

      const report = await new EconomyService(db, dimensionStore(null)).revenue(
        null,
        null,
      );

      expect(report.byCohort).toBeNull();
      expect(report.cohortUnavailableReason).toContain('nunca foi preenchida');
      expect(report.cohortCoverage).toBeNull();
      expect(report.sources).toContainEqual({
        name: 'player_dimension',
        ok: false,
        asOf: null,
        failure: 'never_synced',
      });
    });

    it('keeps revenue by platform answering while the cohort axis is out', async () => {
      // The point of deriving platform from the uuid: the number the spec says
      // no Bedrock decision should be taken without does not wait for an ETL.
      const db = dbWith([
        { rows: [buyer(BEDROCK(1), '5000', 1, null)] },
        { rows: [{ sales: 0, revenue_cents: '0' }] },
      ]);

      const report = await new EconomyService(db, dimensionStore(null)).revenue(
        null,
        null,
      );

      expect(report.byPlatform).toHaveLength(1);
      expect(report.byPlatform[0]).toMatchObject({
        platform: 'bedrock',
        revenue: '50.00',
      });
    });

    it('publishes coverage so a partial cohort breakdown is visible as partial', async () => {
      const db = dbWith([
        {
          rows: [
            buyer(PREMIUM(1), '6000', 3, '2026-01'),
            buyer(PREMIUM(2), '4000', 2, null),
          ],
        },
        { rows: [{ sales: 0, revenue_cents: '0' }] },
      ]);

      const report = await new EconomyService(
        db,
        dimensionStore(SYNCED),
      ).revenue(null, null);

      expect(report.cohortCoverage).toEqual({
        salesWithCohort: 3,
        salesTotal: 5,
        revenueWithCohort: '60.00',
      });
      // The unmatched buyer still appears, under a null cohort, rather than
      // vanishing from the breakdown.
      expect(report.byCohort).toContainEqual(
        expect.objectContaining({ cohort: null, revenue: '40.00' }),
      );
    });
  });

  it('republishes what the historical-import exclusion left out', async () => {
    const db = dbWith([
      { rows: [buyer(PREMIUM(1), '1000', 1, '2026-01')] },
      { rows: [{ sales: 812, revenue_cents: '4500000' }] },
    ]);

    const report = await new EconomyService(db, dimensionStore(SYNCED)).revenue(
      null,
      null,
    );

    // Silent exclusion would make these numbers disagree with the analytics
    // endpoints for a reason nobody could see.
    expect(report.excludedHistorical).toEqual({
      sales: 812,
      revenue: '45000.00',
    });
  });

  it('carries no player uuid into the contract', async () => {
    const db = dbWith([
      { rows: [buyer(PREMIUM(7), '1000', 1, '2026-01')] },
      { rows: [{ sales: 0, revenue_cents: '0' }] },
    ]);

    const report = await new EconomyService(db, dimensionStore(SYNCED)).revenue(
      null,
      null,
    );

    expect(JSON.stringify(report)).not.toContain(PREMIUM(7));
  });
});

describe('EconomyService.firstSpend (E2)', () => {
  const registeredAt = new Date('2026-01-10T15:00:00.000Z');

  function player(uuid: string, firstPurchase: Date | null) {
    return {
      uuid,
      cohort: '2026-01',
      registered_at: registeredAt,
      first_purchase_at: firstPurchase,
    };
  }

  it('uses the cohort as the denominator, not the buyers', async () => {
    // Joining the other way round would make "share of the cohort that ever
    // spent" 100% by construction.
    const db = dbWith([
      {
        rows: [
          player(PREMIUM(1), new Date('2026-01-15T15:00:00.000Z')),
          player(PREMIUM(2), null),
          player(PREMIUM(3), null),
          player(PREMIUM(4), null),
        ],
      },
    ]);

    const report = await new EconomyService(
      db,
      dimensionStore(SYNCED),
    ).firstSpend('2026-01', '2026-01');

    expect(report.byCohort).toEqual([
      {
        cohort: '2026-01',
        platform: 'java_premium',
        cohortSize: 4,
        spenders: 1,
        everSpent: { percent: 25, n: 4 },
        medianDaysToFirstSpend: 5,
        p90DaysToFirstSpend: 5,
        beforeRegistration: 0,
      },
    ]);
  });

  it('counts a purchase that predates registration instead of clamping it to zero', async () => {
    // Clamping would bias the median downwards while looking like data.
    const db = dbWith([
      {
        rows: [
          player(PREMIUM(1), new Date('2025-12-01T15:00:00.000Z')),
          player(PREMIUM(2), new Date('2026-01-20T15:00:00.000Z')),
        ],
      },
    ]);

    const report = await new EconomyService(
      db,
      dimensionStore(SYNCED),
    ).firstSpend('2026-01', '2026-01');

    expect(report.byCohort?.[0]).toMatchObject({
      // BOTH bought. The one whose purchase predates registration stays out of
      // the percentile sample and stays IN the numerator: dropping them would
      // publish a share whose numerator silently loses real buyers.
      spenders: 2,
      beforeRegistration: 1,
      medianDaysToFirstSpend: 10,
      everSpent: { percent: 100, n: 2 },
    });
  });

  it('reads a timestamp the driver handed back as a string', async () => {
    // `pg` parses a plain `timestamptz` column into a `Date` and handed back
    // `min(purchased_at)` as a **string**. The unit tests stub the driver, so
    // they could not see it; the e2e could, and did. This pins the shape so the
    // regression cannot come back through a path the e2e does not cover.
    const db = dbWith([
      {
        rows: [
          {
            uuid: PREMIUM(1),
            cohort: '2026-01',
            registered_at: '2026-01-10T15:00:00.000Z',
            first_purchase_at: '2026-01-20T15:00:00.000Z',
          },
        ],
      },
    ]);

    const report = await new EconomyService(
      db,
      dimensionStore(SYNCED),
    ).firstSpend('2026-01', '2026-01');

    expect(report.byCohort?.[0]).toMatchObject({
      spenders: 1,
      medianDaysToFirstSpend: 10,
    });
  });

  it('drops a player whose registration date is unreadable', async () => {
    // Counting them in `cohortSize` with no usable interval would deflate the
    // "ever spent" share by a player nobody can account for.
    const db = dbWith([
      {
        rows: [
          {
            uuid: PREMIUM(1),
            cohort: '2026-01',
            registered_at: 'nao e data',
            first_purchase_at: null,
          },
          player(PREMIUM(2), null),
        ],
      },
    ]);

    const report = await new EconomyService(
      db,
      dimensionStore(SYNCED),
    ).firstSpend('2026-01', '2026-01');

    expect(report.byCohort?.[0].cohortSize).toBe(1);
  });

  it('returns null percentiles — never zero — for a cohort where nobody spent', async () => {
    const db = dbWith([{ rows: [player(PREMIUM(1), null)] }]);

    const report = await new EconomyService(
      db,
      dimensionStore(SYNCED),
    ).firstSpend('2026-01', '2026-01');

    expect(report.byCohort?.[0]).toMatchObject({
      spenders: 0,
      medianDaysToFirstSpend: null,
      p90DaysToFirstSpend: null,
      everSpent: { percent: 0, n: 1 },
    });
  });

  it('publishes the funnel-position half as null with the reason, never omitted', async () => {
    const db = dbWith([{ rows: [] }]);

    const report = await new EconomyService(
      db,
      dimensionStore(SYNCED),
    ).firstSpend('2026-01', '2026-01');

    expect(report.byFunnelPosition).toBeNull();
    expect(report.funnelPositionUnavailableReason).toContain(
      'posicao do jogador no tutorial',
    );
    expect(report.funnelPositionUnavailableReason).toContain('decisao do dono');
  });

  it('does not query at all when the dimension never synced', async () => {
    const execute = jest.fn();
    const db = { execute } as unknown as DrizzleDB;

    const report = await new EconomyService(
      db,
      dimensionStore(null),
    ).firstSpend('2026-01', '2026-01');

    expect(execute).not.toHaveBeenCalled();
    expect(report.byCohort).toBeNull();
    expect(report.unavailableReason).toContain('nunca foi preenchida');
  });
});
