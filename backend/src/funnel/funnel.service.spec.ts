import type { PlanDatabase } from '../instrumentation/plan-database';
import { Platform } from '../instrumentation/platform';
import type { TutorialStore } from '../tutorial/tutorial.store';
import { FunnelService } from './funnel.service';
import { FunnelGranularity, FunnelStep } from './funnel.types';

/** Real uuids by shape (ADR-003), so platform filtering is exercised for real. */
const BEDROCK = '00000000-0000-0000-0009-0000000abcde';
const PREMIUM = '11111111-2222-4333-8444-555555555555';
const OFFLINE = '11111111-2222-3333-8444-555555555555';

/** 2026-03-10 12:00 BRT, and the same day at 21:00 (00:00 UTC on the 11th). */
const MARCH_10_NOON = Date.parse('2026-03-10T12:00:00-03:00');
const MARCH_10_EVENING = Date.parse('2026-03-10T21:00:00-03:00');
const MARCH_11_NOON = Date.parse('2026-03-11T12:00:00-03:00');

interface PlanOptions {
  arrivals?: { uuid: string; registeredAt: number }[];
  configured?: boolean;
  throws?: boolean;
}

function planDbWith({
  arrivals = [],
  configured = true,
  throws = false,
}: PlanOptions): PlanDatabase {
  return {
    configured,
    networkArrivalsBetween: jest.fn(() =>
      throws
        ? Promise.reject(new Error('mysql fora do ar'))
        : Promise.resolve(arrivals),
    ),
  } as unknown as PlanDatabase;
}

interface TutorialOptions {
  rows?: {
    day: string;
    platform: string;
    entered: number;
    completed: number;
  }[];
  neverSynced?: boolean;
  throws?: boolean;
}

function tutorialWith({
  rows = [],
  neverSynced = false,
  throws = false,
}: TutorialOptions): TutorialStore {
  return {
    lastSuccessfulSync: jest.fn(() =>
      neverSynced
        ? Promise.resolve(null)
        : Promise.resolve({
            id: 1,
            ranAt: new Date('2026-03-11T06:00:00.000Z'),
            status: 'ok',
          }),
    ),
    series: jest.fn(() =>
      throws
        ? Promise.reject(new Error('postgres fora do ar'))
        : Promise.resolve(rows),
    ),
  } as unknown as TutorialStore;
}

function countOf(
  bucket: { counts: { step: string; value: number | null }[] },
  step: string,
) {
  return bucket.counts.find((c) => c.step === step);
}

describe('FunnelService', () => {
  describe('the series covers the whole range, not just the days with data', () => {
    it('emits a bucket per day even when nothing happened', async () => {
      // Deriving buckets from the rows that came back would make a collection
      // gap invisible: the day would simply be absent from the chart, and a
      // missing day reads as a day that did not happen.
      const service = new FunnelService(planDbWith({}), tutorialWith({}));

      const series = await service.series(
        FunnelGranularity.Daily,
        '2026-03-10',
        '2026-03-12',
      );

      expect(series.buckets.map((b) => b.bucket)).toEqual([
        '2026-03-10',
        '2026-03-11',
        '2026-03-12',
      ]);
    });

    it('collapses days into months at monthly granularity', async () => {
      const service = new FunnelService(planDbWith({}), tutorialWith({}));

      const series = await service.series(
        FunnelGranularity.Monthly,
        '2026-02-27',
        '2026-04-02',
      );

      expect(series.buckets.map((b) => b.bucket)).toEqual([
        '2026-02',
        '2026-03',
        '2026-04',
      ]);
    });
  });

  describe('the network step', () => {
    it('buckets arrivals by São Paulo day, not by UTC', async () => {
      // A 21:00 BRT arrival is 00:00 UTC the next day. Bucketing in UTC would
      // push every Brazilian evening — the busiest hours — into the next day.
      const service = new FunnelService(
        planDbWith({
          arrivals: [
            { uuid: PREMIUM, registeredAt: MARCH_10_NOON },
            { uuid: BEDROCK, registeredAt: MARCH_10_EVENING },
            { uuid: OFFLINE, registeredAt: MARCH_11_NOON },
          ],
        }),
        tutorialWith({}),
      );

      const series = await service.series(
        FunnelGranularity.Daily,
        '2026-03-10',
        '2026-03-11',
      );

      expect(countOf(series.buckets[0], FunnelStep.Network)?.value).toBe(2);
      expect(countOf(series.buckets[1], FunnelStep.Network)?.value).toBe(1);
    });

    it('filters by platform from the uuid alone (ADR-003)', async () => {
      const service = new FunnelService(
        planDbWith({
          arrivals: [
            { uuid: PREMIUM, registeredAt: MARCH_10_NOON },
            { uuid: BEDROCK, registeredAt: MARCH_10_NOON },
            { uuid: BEDROCK, registeredAt: MARCH_10_NOON },
          ],
        }),
        tutorialWith({}),
      );

      const series = await service.series(
        FunnelGranularity.Daily,
        '2026-03-10',
        '2026-03-10',
        Platform.Bedrock,
      );

      expect(countOf(series.buckets[0], FunnelStep.Network)?.value).toBe(2);
    });

    it('reports a measured zero when the source answered and nobody came', async () => {
      const service = new FunnelService(planDbWith({}), tutorialWith({}));

      const series = await service.series(
        FunnelGranularity.Daily,
        '2026-03-10',
        '2026-03-10',
      );

      expect(countOf(series.buckets[0], FunnelStep.Network)?.value).toBe(0);
      expect(series.sources.find((s) => s.name === 'plan_users')?.ok).toBe(
        true,
      );
    });

    it('reports null — never zero — when the source failed', async () => {
      // "Nobody connected all month" and "the database was down" must not look
      // the same. This is the distinction the whole epic turns on.
      const service = new FunnelService(
        planDbWith({ throws: true }),
        tutorialWith({}),
      );

      const series = await service.series(
        FunnelGranularity.Daily,
        '2026-03-10',
        '2026-03-10',
      );

      expect(countOf(series.buckets[0], FunnelStep.Network)?.value).toBeNull();
      const state = series.sources.find((s) => s.name === 'plan_users');
      expect(state?.ok).toBe(false);
      expect(state?.detail).toContain('mysql fora do ar');
    });

    it('reports null when the Plan database is not configured', async () => {
      const service = new FunnelService(
        planDbWith({ configured: false }),
        tutorialWith({}),
      );

      const series = await service.series(
        FunnelGranularity.Daily,
        '2026-03-10',
        '2026-03-10',
      );

      expect(countOf(series.buckets[0], FunnelStep.Network)?.value).toBeNull();
      expect(
        series.sources.find((s) => s.name === 'plan_users')?.detail,
      ).toContain('PLAN_DB_HOST');
    });
  });

  describe('the tutorial steps', () => {
    it('sums the daily rows into their buckets', async () => {
      const service = new FunnelService(
        planDbWith({
          arrivals: [{ uuid: PREMIUM, registeredAt: MARCH_10_NOON }],
        }),
        tutorialWith({
          rows: [
            {
              day: '2026-03-10',
              platform: 'bedrock',
              entered: 3,
              completed: 1,
            },
            {
              day: '2026-03-10',
              platform: 'java_premium',
              entered: 2,
              completed: 0,
            },
          ],
        }),
      );

      const series = await service.series(
        FunnelGranularity.Daily,
        '2026-03-10',
        '2026-03-10',
      );

      expect(
        countOf(series.buckets[0], FunnelStep.TutorialEntered)?.value,
      ).toBe(5);
      expect(
        countOf(series.buckets[0], FunnelStep.TutorialCompleted)?.value,
      ).toBe(1);
    });

    it('dates the series by the ETL run, not by the request', async () => {
      // The series is only as fresh as the last successful rebuild. Reporting
      // "now" would claim a currency the data does not have.
      const service = new FunnelService(planDbWith({}), tutorialWith({}));

      const series = await service.series(
        FunnelGranularity.Daily,
        '2026-03-10',
        '2026-03-10',
      );

      expect(
        series.sources.find((s) => s.name === 'tutorial_daily')?.asOf,
      ).toBe('2026-03-11T06:00:00.000Z');
    });

    it('reports null when the ETL has never run', async () => {
      // An empty table read as "nobody entered the tutorial" is precisely the
      // disaster the seventh check exists to catch.
      const service = new FunnelService(
        planDbWith({}),
        tutorialWith({ neverSynced: true }),
      );

      const series = await service.series(
        FunnelGranularity.Daily,
        '2026-03-10',
        '2026-03-10',
      );

      expect(
        countOf(series.buckets[0], FunnelStep.TutorialEntered)?.value,
      ).toBeNull();
      const state = series.sources.find((s) => s.name === 'tutorial_daily');
      expect(state?.ok).toBe(false);
      expect(state?.detail).toContain('NAO e o mesmo que ninguem ter entrado');
    });
  });

  describe('the two sources fail independently', () => {
    it('keeps the tutorial steps when the network source is down', async () => {
      // A funnel that went blank because one of two databases blinked would be
      // less useful than one that says which half it still has.
      const service = new FunnelService(
        planDbWith({ throws: true }),
        tutorialWith({
          rows: [
            {
              day: '2026-03-10',
              platform: 'bedrock',
              entered: 7,
              completed: 2,
            },
          ],
        }),
      );

      const series = await service.series(
        FunnelGranularity.Daily,
        '2026-03-10',
        '2026-03-10',
      );

      expect(countOf(series.buckets[0], FunnelStep.Network)?.value).toBeNull();
      expect(
        countOf(series.buckets[0], FunnelStep.TutorialEntered)?.value,
      ).toBe(7);
    });

    it('keeps the network step when the tutorial source is down', async () => {
      const service = new FunnelService(
        planDbWith({
          arrivals: [{ uuid: PREMIUM, registeredAt: MARCH_10_NOON }],
        }),
        tutorialWith({ throws: true }),
      );

      const series = await service.series(
        FunnelGranularity.Daily,
        '2026-03-10',
        '2026-03-10',
      );

      expect(countOf(series.buckets[0], FunnelStep.Network)?.value).toBe(1);
      expect(
        countOf(series.buckets[0], FunnelStep.TutorialEntered)?.value,
      ).toBeNull();
    });
  });

  it('caps the range so one request cannot stream years out of the game MySQL', async () => {
    const service = new FunnelService(planDbWith({}), tutorialWith({}));

    const series = await service.series(
      FunnelGranularity.Daily,
      '2020-01-01',
      '2026-12-31',
    );

    expect(series.buckets).toHaveLength(366);
  });
});
