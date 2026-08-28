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
  /**
   * `MIN(registered)`. Defaults to well before the fixtures so the common tests
   * exercise the covered path; set it explicitly to test the coverage floor.
   */
  earliestAt?: number | null;
  /** Captures the window the service actually asked the database for. */
  spy?: jest.Mock;
}

const LONG_AGO = Date.parse('2020-01-01T00:00:00-03:00');

function planDbWith({
  arrivals = [],
  configured = true,
  throws = false,
  earliestAt = LONG_AGO,
  spy,
}: PlanOptions): PlanDatabase {
  const between =
    spy ??
    jest.fn(() =>
      throws
        ? Promise.reject(new Error('mysql fora do ar'))
        : Promise.resolve(arrivals),
    );
  if (spy) {
    spy.mockImplementation(() =>
      throws
        ? Promise.reject(new Error('mysql fora do ar'))
        : Promise.resolve(arrivals),
    );
  }
  return {
    configured,
    earliestArrivalAt: jest.fn(() =>
      throws
        ? Promise.reject(new Error('mysql fora do ar'))
        : Promise.resolve(earliestAt),
    ),
    networkArrivalsBetween: between,
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
      expect(state?.failure).toBe('query_failed');
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
      expect(series.sources.find((s) => s.name === 'plan_users')?.failure).toBe(
        'not_configured',
      );
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
      expect(state?.failure).toBe('never_synced');
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

  describe('the window cap protects the game machine, not just the response', () => {
    it('narrows the window BEFORE querying, and says it truncated', async () => {
      // The first version capped only the output array: a request for
      // 1970..2026 still ran `SELECT ... FROM plan_users` across the whole table
      // and threw the rows away. Asserting on the arguments the database
      // actually received, because that is the thing being protected.
      const spy = jest.fn();
      const service = new FunnelService(planDbWith({ spy }), tutorialWith({}));

      const series = await service.series(
        FunnelGranularity.Daily,
        '1970-01-01',
        '2026-12-31',
      );

      const [from, to] = spy.mock.calls[0] as [number, number];
      const spanDays = Math.round((to - from) / 86_400_000);
      expect(spanDays).toBeLessThanOrEqual(366);
      // And the caller is told, rather than reading `from: 1970` off an
      // envelope that covers one year.
      expect(series.truncated).toBe(true);
      // 366 inclusive days back from 2026-12-31.
      expect(series.from).toBe('2025-12-31');
    });

    it('caps the MONTHLY mode by days too, not by months', async () => {
      // The cap used to count buckets, so the monthly mode allowed 366 *months*
      // — thirty years — while the daily mode allowed 366 days. One constant,
      // two windows, and the endpoint description claimed they were the same.
      const service = new FunnelService(planDbWith({}), tutorialWith({}));

      const series = await service.series(
        FunnelGranularity.Monthly,
        '1990-01-01',
        '2026-12-31',
      );

      // 366 days spans 13 calendar months at most, never 366.
      expect(series.buckets.length).toBeLessThanOrEqual(13);
      expect(series.truncated).toBe(true);
    });

    it('leaves a window inside the cap alone', async () => {
      const service = new FunnelService(planDbWith({}), tutorialWith({}));

      const series = await service.series(
        FunnelGranularity.Daily,
        '2026-03-01',
        '2026-03-10',
      );

      expect(series.truncated).toBe(false);
      expect(series.from).toBe('2026-03-01');
    });
  });

  describe('the network source does not speak for the whole past', () => {
    it('reports null — not zero — before the table starts', async () => {
      // `plan_users` lost the proxy's history in the 2026-08-20 unification, so
      // it is only days deep. A query for March SUCCEEDS and returns nothing,
      // and reading that as a measured zero would publish `rede: 0` for a month
      // when thousands connected — beside a tutorial step whose ETL reads plugin
      // files going back to 2025. The funnel would show more people entering the
      // tutorial than reaching the network.
      const service = new FunnelService(
        planDbWith({
          earliestAt: Date.parse('2026-03-09T00:00:00-03:00'),
          arrivals: [{ uuid: PREMIUM, registeredAt: MARCH_10_NOON }],
        }),
        tutorialWith({}),
      );

      const series = await service.series(
        FunnelGranularity.Daily,
        '2026-03-07',
        '2026-03-10',
      );

      // Before coverage: no source, with a reason.
      expect(countOf(series.buckets[0], FunnelStep.Network)?.value).toBeNull();
      expect(countOf(series.buckets[1], FunnelStep.Network)?.value).toBeNull();
      // Inside coverage and genuinely empty: a measured zero.
      expect(countOf(series.buckets[2], FunnelStep.Network)?.value).toBe(0);
      // Inside coverage, with arrivals.
      expect(countOf(series.buckets[3], FunnelStep.Network)?.value).toBe(1);
    });

    it('publishes where the coverage starts', async () => {
      const service = new FunnelService(
        planDbWith({ earliestAt: Date.parse('2026-08-20T15:00:00-03:00') }),
        tutorialWith({}),
      );

      const series = await service.series(
        FunnelGranularity.Daily,
        '2026-08-19',
        '2026-08-21',
      );

      expect(
        series.sources.find((s) => s.name === 'plan_users')?.coversFrom,
      ).toBe('2026-08-20');
    });

    it('treats an empty table as covering nothing, not everything', async () => {
      const service = new FunnelService(
        planDbWith({ earliestAt: null }),
        tutorialWith({}),
      );

      const series = await service.series(
        FunnelGranularity.Daily,
        '2026-03-10',
        '2026-03-10',
      );

      expect(countOf(series.buckets[0], FunnelStep.Network)?.value).toBeNull();
    });
  });

  it('never publishes an upstream database message in the body', async () => {
    // The same decision story S7.2 made for `MetricsFailureReason`, and CWE-209:
    // a mysql2 error reads `Access denied for user 'plan_ro'@'172.18.0.3'`.
    // Closed label in the body, full message in the log.
    const service = new FunnelService(
      planDbWith({ throws: true }),
      tutorialWith({ throws: true }),
    );

    const series = await service.series(
      FunnelGranularity.Daily,
      '2026-03-10',
      '2026-03-10',
    );

    expect(JSON.stringify(series)).not.toContain('mysql fora do ar');
    expect(JSON.stringify(series)).not.toContain('postgres fora do ar');
    for (const source of series.sources) {
      expect(source.failure).toBe('query_failed');
    }
  });
});
