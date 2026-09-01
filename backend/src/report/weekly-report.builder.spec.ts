import type { FunnelService, FunnelSeries } from '../funnel/funnel.service';
import { buildBucket } from '../funnel/funnel-math';
import { FunnelStep } from '../funnel/funnel.types';
import type { InstrumentationHealthService } from '../health/instrumentation-health.service';
import type { InstrumentationSummaryDto } from '../health/dto/instrumentation-health.dto';
import type { RetentionService } from '../retention/retention.service';
import type { RetentionReport } from '../retention/retention.types';
import {
  WeeklyReportBuilder,
  daysBefore,
  monthsBefore,
  WINDOW_DAYS,
} from './weekly-report.builder';

/** A daily bucket with the given survival / tutorial counts. */
function day(
  bucket: string,
  survival: number | null,
  entered: number | null,
  completed: number | null,
) {
  return buildBucket(bucket, {
    network: null,
    survival,
    survivalUnavailableReason:
      survival === null ? 'a fonte nao respondeu neste dia' : undefined,
    tutorialEntered: entered,
    tutorialCompleted: completed,
  });
}

function series(buckets: ReturnType<typeof day>[]): FunnelSeries {
  return {
    granularity: 'daily',
    platform: 'all',
    from: '2026-08-25',
    to: '2026-08-31',
    truncated: false,
    buckets,
    sources: [
      { name: 'plan_users', ok: true, asOf: '2026-09-01T00:00:00.000Z' },
      { name: 'tutorial_daily', ok: true, asOf: '2026-09-01T00:00:00.000Z' },
    ],
  };
}

function emptyRetention(): RetentionReport {
  return {
    semantics: 'intervalo de sobrevivencia',
    from: '2026-06',
    to: '2026-08',
    evaluatedAt: '2026-09-01T00:00:00.000Z',
    minimumCohortSize: 30,
    stampDays: [],
    cohorts: [],
    source: {
      name: 'plan_retention',
      ok: true,
      asOf: '2026-09-01T00:00:00.000Z',
      dataThrough: '2026-08-31',
      rows: 0,
    },
  };
}

function summary(): InstrumentationSummaryDto {
  return {
    status: 'ok',
    stale: false,
    lastCheckedAt: '2026-09-01T00:00:00.000Z',
    oldestCheckedAt: '2026-09-01T00:00:00.000Z',
    total: 7,
    counts: { ok: 7, breached: 0, no_data: 0, error: 0 },
    failing: [],
    staleChecks: [],
    blindSpots: [],
    missing: [],
    schedule: { enabled: true, intervalMinutes: 15, staleAfterMinutes: 30 },
  };
}

function builderWith(buckets: ReturnType<typeof day>[]): WeeklyReportBuilder {
  const funnel = {
    series: jest.fn().mockResolvedValue(series(buckets)),
  } as unknown as FunnelService;
  const retention = {
    report: jest.fn().mockResolvedValue(emptyRetention()),
  } as unknown as RetentionService;
  const health = {
    summary: jest.fn().mockResolvedValue(summary()),
  } as unknown as InstrumentationHealthService;

  return new WeeklyReportBuilder(funnel, retention, health);
}

/** Seven consecutive days ending 2026-08-31. */
const WEEK = [
  '2026-08-25',
  '2026-08-26',
  '2026-08-27',
  '2026-08-28',
  '2026-08-29',
  '2026-08-30',
  '2026-08-31',
];

/**
 * Reason on the unmeasured variant.
 *
 * The union makes `unavailableReason` reachable only after narrowing, which is
 * the point of it — so the tests narrow here once instead of casting at every
 * assertion.
 */
function reasonOf(count: { value: number | null }): string {
  if (count.value !== null) {
    throw new Error('this count is measured; it has no reason');
  }
  return (count as unknown as { unavailableReason: string }).unavailableReason;
}

function countOf(
  bucket: { counts: { step: string; value: number | null }[] },
  step: string,
) {
  const found = bucket.counts.find((c) => c.step === step);
  if (found === undefined) {
    throw new Error(`step ${step} missing`);
  }
  return found;
}

describe('date arithmetic', () => {
  it('walks days backwards across a month boundary', () => {
    expect(daysBefore('2026-09-01', 1)).toBe('2026-08-31');
    expect(daysBefore('2026-03-01', 1)).toBe('2026-02-28');
  });

  it('walks months backwards across a year boundary', () => {
    expect(monthsBefore('2026-02', 3)).toBe('2025-11');
  });
});

describe('WeeklyReportBuilder', () => {
  it('asks the funnel for exactly the seven-day window', async () => {
    // The mocks are held as standalone functions rather than read back off the
    // stub objects: asserting on `funnel.series` would detach a method from its
    // receiver, which the lint rule about unbound methods exists to catch.
    const seriesFn = jest
      .fn()
      .mockResolvedValue(series(WEEK.map((d) => day(d, 10, 5, 1))));
    const reportFn = jest.fn().mockResolvedValue(emptyRetention());
    const summaryFn = jest.fn().mockResolvedValue(summary());

    const report = await new WeeklyReportBuilder(
      { series: seriesFn } as unknown as FunnelService,
      { report: reportFn } as unknown as RetentionService,
      { summary: summaryFn } as unknown as InstrumentationHealthService,
    ).build('2026-08-31');

    expect(report.from).toBe('2026-08-25');
    expect(report.to).toBe('2026-08-31');
    expect(seriesFn).toHaveBeenCalledWith(
      'daily',
      '2026-08-25',
      '2026-08-31',
      'all',
    );
    // Three cohort months ending in the window's month.
    expect(reportFn).toHaveBeenCalledWith('2026-06', '2026-08', 'all');
  });

  describe('the roll-up refuses a partial week', () => {
    it('sums a step covered on every day', async () => {
      const report = await builderWith(WEEK.map((d) => day(d, 10, 4, 1))).build(
        '2026-08-31',
      );

      expect(countOf(report.funnel.bucket, FunnelStep.Survival).value).toBe(70);
      expect(
        countOf(report.funnel.bucket, FunnelStep.TutorialEntered).value,
      ).toBe(28);
    });

    it('returns null — not a six-day sum — when one day is missing', async () => {
      // A six-day numerator published as a week is the smaller-denominator
      // defect this module already shipped twice.
      const buckets = WEEK.map((d, i) =>
        i === 3 ? day(d, null, 4, 1) : day(d, 10, 4, 1),
      );

      const report = await builderWith(buckets).build('2026-08-31');

      const survival = countOf(report.funnel.bucket, FunnelStep.Survival);
      expect(survival.value).toBeNull();
      expect(
        report.funnel.coverage.find((c) => c.step === FunnelStep.Survival),
      ).toEqual({ step: FunnelStep.Survival, days: 6, ofDays: WINDOW_DAYS });
      // The other step is untouched: the steps fail independently.
      expect(
        countOf(report.funnel.bucket, FunnelStep.TutorialEntered).value,
      ).toBe(28);
    });

    it('says which of the two absences it is', async () => {
      const none = await builderWith(WEEK.map((d) => day(d, null, 4, 1))).build(
        '2026-08-31',
      );
      const partial = await builderWith(
        WEEK.map((d, i) => (i === 0 ? day(d, null, 4, 1) : day(d, 10, 4, 1))),
      ).build('2026-08-31');

      const noneReason = countOf(none.funnel.bucket, FunnelStep.Survival);
      const partialReason = countOf(partial.funnel.bucket, FunnelStep.Survival);

      expect(noneReason.value).toBeNull();
      expect(partialReason.value).toBeNull();
      // "the source is out" and "the week is incomplete" must not read alike.
      expect(reasonOf(partialReason)).toContain('6 dos 7 dias');
      expect(reasonOf(noneReason)).not.toContain('dos 7 dias');
    });

    it('keeps the rede step null in the weekly roll-up too', async () => {
      const report = await builderWith(WEEK.map((d) => day(d, 10, 4, 1))).build(
        '2026-08-31',
      );

      expect(
        countOf(report.funnel.bucket, FunnelStep.Network).value,
      ).toBeNull();
      // And therefore the first conversion carries no percentage.
      expect(report.funnel.bucket.conversions[0].percent).toBeNull();
    });

    it('never publishes a conversion without its base', async () => {
      const report = await builderWith(WEEK.map((d) => day(d, 10, 4, 1))).build(
        '2026-08-31',
      );

      for (const conversion of report.funnel.bucket.conversions) {
        if (conversion.percent !== null) {
          expect(conversion.n).not.toBeNull();
        }
      }
      // survival(70) → tutorial_entrou(28) is 40%.
      expect(report.funnel.bucket.conversions[1]).toMatchObject({
        percent: 40,
        n: 70,
      });
    });
  });

  it('carries the retention label through rather than restating it', async () => {
    const report = await builderWith(WEEK.map((d) => day(d, 10, 4, 1))).build(
      '2026-08-31',
    );

    expect(report.retention.semantics).toBe('intervalo de sobrevivencia');
  });
});
