import { Platform } from '../instrumentation/platform';
import type { RetentionPlayer } from './plan-retention';
import {
  buildCohorts,
  detectStampDays,
  toSaoPauloMonth,
} from './retention-math';
import type { CohortOptions } from './retention-math';
import type { RetentionMeasure, StampDay } from './retention.types';

const MS_PER_DAY = 86_400_000;

/** 2026-08-01 12:00 BRT — a fixed "now" so maturity never depends on the clock. */
const NOW = Date.parse('2026-08-01T12:00:00-03:00');

/** UUID v4 → java_premium (ADR-003). Suffix keeps players distinguishable. */
function premium(suffix: number): string {
  return `11111111-1111-4111-8111-${String(suffix).padStart(12, '0')}`;
}

/** Floodgate prefix → bedrock. */
function bedrock(suffix: number): string {
  return `00000000-0000-0000-0009-${String(suffix).padStart(12, '0')}`;
}

function player(
  uuid: string,
  registeredDay: string,
  lastSeenDay: string,
): RetentionPlayer {
  return {
    uuid,
    registeredAt: Date.parse(`${registeredDay}T12:00:00-03:00`),
    lastSeenAt: Date.parse(`${lastSeenDay}T12:00:00-03:00`),
  };
}

function options(over: Partial<CohortOptions> = {}): CohortOptions {
  return {
    evaluatedAt: NOW,
    stampDays: [],
    minimumCohortSize: 30,
    contaminationMax: 0.5,
    ...over,
  };
}

function measureOf(
  measures: readonly RetentionMeasure[],
  horizon: string,
): RetentionMeasure {
  const found = measures.find((m) => m.horizon === horizon);
  if (found === undefined) {
    throw new Error(`horizon ${horizon} missing from the cohort`);
  }
  return found;
}

describe('toSaoPauloMonth', () => {
  it('buckets an evening in Brazil into the Brazilian month, not the UTC one', () => {
    // 2026-03-31 21:00 BRT is 2026-04-01 00:00 UTC. Slicing an ISO string would
    // file this player under April and move a whole cohort boundary.
    const evening = Date.parse('2026-03-31T21:00:00-03:00');
    expect(toSaoPauloMonth(evening)).toBe('2026-03');
  });

  it('returns null for an unusable epoch instead of guessing a month', () => {
    expect(toSaoPauloMonth(Number.NaN)).toBeNull();
    expect(toSaoPauloMonth(0)).toBeNull();
  });
});

describe('detectStampDays', () => {
  it('flags a day that holds an implausible share of the population', () => {
    // 300 players: 200 of them last seen on the very same day, which is what a
    // bulk import leaves behind and what player behaviour never does.
    const stamped = Array.from({ length: 200 }, (_, i) =>
      player(premium(i), '2025-01-10', '2026-08-20'),
    );
    const organic = Array.from({ length: 100 }, (_, i) =>
      player(
        premium(1000 + i),
        '2026-06-10',
        `2026-07-${String((i % 28) + 1).padStart(2, '0')}`,
      ),
    );

    const stamps = detectStampDays([...stamped, ...organic], 0.1, 200);

    expect(stamps).toHaveLength(1);
    expect(stamps[0]).toEqual({
      day: '2026-08-20',
      // Rounded to four decimals by the detector: a share is evidence for a
      // human, not an input to further arithmetic.
      share: 0.6667,
      n: 200,
      population: 300,
    });
  });

  it('abstains below the minimum population, where one day is trivially 10%', () => {
    const tiny = Array.from({ length: 20 }, (_, i) =>
      player(premium(i), '2026-06-10', '2026-06-15'),
    );

    expect(detectStampDays(tiny, 0.1, 200)).toEqual([]);
  });

  it('publishes the base of every stamp, never a bare share', () => {
    const players = Array.from({ length: 250 }, (_, i) =>
      player(premium(i), '2025-01-10', '2026-08-20'),
    );

    for (const stamp of detectStampDays(players, 0.1, 200)) {
      expect(stamp.n).toBeGreaterThan(0);
      expect(stamp.population).toBe(250);
    }
  });

  it('orders the biggest stamp first when an import left two marks', () => {
    const players = [
      ...Array.from({ length: 120 }, (_, i) =>
        player(premium(i), '2025-01-10', '2026-08-20'),
      ),
      ...Array.from({ length: 60 }, (_, i) =>
        player(premium(500 + i), '2025-02-10', '2026-05-05'),
      ),
      ...Array.from({ length: 120 }, (_, i) =>
        player(
          premium(900 + i),
          '2026-06-10',
          `2026-07-${String((i % 28) + 1).padStart(2, '0')}`,
        ),
      ),
    ];

    const stamps = detectStampDays(players, 0.1, 200);

    expect(stamps.map((s) => s.day)).toEqual(['2026-08-20', '2026-05-05']);
  });
});

describe('buildCohorts', () => {
  describe('maturity is filtered per player, not per cohort', () => {
    it('publishes D1 and D7 but not D30 for a cohort ten days old', () => {
      // Registered 2026-07-25, evaluated 2026-08-01: ten days of opportunity at
      // most. Dividing the whole cohort at D30 would print 0,0%, which reads as
      // a collapse and is the calendar.
      const members = Array.from({ length: 40 }, (_, i) =>
        player(premium(i), '2026-07-25', i < 20 ? '2026-07-31' : '2026-07-25'),
      );

      const [cohort] = buildCohorts(members, options());

      const d1 = measureOf(cohort.measures, 'D1');
      const d30 = measureOf(cohort.measures, 'D30');

      expect(d1.percent).toBe(50);
      expect(d1.n).toBe(40);
      expect(d30.percent).toBeNull();
      expect(d30.n).toBe(0);
      expect(d30).toMatchObject({ reason: 'immature_horizon' });
    });

    it('never publishes zero for an immature horizon', () => {
      const members = [player(premium(1), '2026-07-31', '2026-07-31')];

      const [cohort] = buildCohorts(members, options());

      for (const horizon of ['D7', 'D30']) {
        const measure = measureOf(cohort.measures, horizon);
        expect(measure.percent).not.toBe(0);
        expect(measure.percent).toBeNull();
      }
    });

    it('shrinks the base as the horizon grows, within one cohort', () => {
      // Same cohort month, two registration days: evaluated on 2026-07-10, the
      // first half has had 39 days of opportunity and the second only 12.
      const evaluatedAt = Date.parse('2026-07-10T12:00:00-03:00');
      const early = Array.from({ length: 10 }, (_, i) =>
        player(premium(i), '2026-06-01', '2026-07-05'),
      );
      const late = Array.from({ length: 10 }, (_, i) =>
        player(premium(100 + i), '2026-06-28', '2026-06-29'),
      );

      const [cohort] = buildCohorts(
        [...early, ...late],
        options({ evaluatedAt }),
      );

      expect(measureOf(cohort.measures, 'D1').n).toBe(20);
      expect(measureOf(cohort.measures, 'D30').n).toBe(10);
    });
  });

  describe('no percentage without its base', () => {
    it('carries percent, n and survived together on a measured horizon', () => {
      const members = Array.from({ length: 100 }, (_, i) =>
        player(premium(i), '2026-01-10', i < 30 ? '2026-03-20' : '2026-01-11'),
      );

      const d30 = measureOf(
        buildCohorts(members, options())[0].measures,
        'D30',
      );

      expect(d30).toEqual({
        horizon: 'D30',
        percent: 30,
        n: 100,
        survived: 30,
      });
    });
  });

  describe('small cohorts are marked, never hidden', () => {
    it('returns the cohort with belowMinimum set', () => {
      const members = Array.from({ length: 3 }, (_, i) =>
        player(premium(i), '2026-01-10', '2026-03-01'),
      );

      const [cohort] = buildCohorts(
        members,
        options({ minimumCohortSize: 30 }),
      );

      expect(cohort.size).toBe(3);
      expect(cohort.belowMinimum).toBe(true);
      // Still measured. Marking is the requirement; suppressing would be the
      // same error as omitting `n`.
      expect(measureOf(cohort.measures, 'D30').percent).toBe(100);
    });
  });

  describe('import artifact', () => {
    const stampDays: StampDay[] = [
      { day: '2026-08-20', share: 0.6, n: 600, population: 1000 },
    ];

    it('suppresses the horizons of a contaminated cohort with the reason', () => {
      const stamped = Array.from({ length: 80 }, (_, i) =>
        player(premium(i), '2025-01-10', '2026-08-20'),
      );
      const organic = Array.from({ length: 20 }, (_, i) =>
        player(premium(500 + i), '2025-01-10', '2025-01-11'),
      );

      const [cohort] = buildCohorts(
        [...stamped, ...organic],
        options({ stampDays }),
      );

      expect(cohort.contamination).toEqual({
        share: 0.8,
        n: 80,
        suspect: true,
      });
      for (const measure of cohort.measures) {
        expect(measure.percent).toBeNull();
        expect(measure).toMatchObject({ reason: 'import_artifact' });
        // The base is still counted: it is a fact about the calendar and it is
        // what lets a reader judge whether the suppression was right.
        expect(measure.n).toBe(100);
      }
    });

    it('publishes the contamination share of a clean cohort too, not only of a suspect one', () => {
      const members = Array.from({ length: 100 }, (_, i) =>
        player(premium(i), '2026-01-10', i < 10 ? '2026-08-20' : '2026-01-20'),
      );

      const [cohort] = buildCohorts(members, options({ stampDays }));

      expect(cohort.contamination).toEqual({
        share: 0.1,
        n: 10,
        suspect: false,
      });
      // Ninety players stopped after ten days and ten carry the stamp, so D30 is
      // 10% — measured and published, because 10% contamination is under the
      // ceiling and suppressing it would hide a real cohort.
      expect(measureOf(cohort.measures, 'D30').percent).toBe(10);
    });

    it('never marks a cohort with no stamped player, even at a zero threshold', () => {
      // A misconfigured `contaminationMax` of 0 must not blank the whole report.
      const members = Array.from({ length: 50 }, (_, i) =>
        player(premium(i), '2025-01-10', '2025-02-01'),
      );

      const [cohort] = buildCohorts(
        members,
        options({ stampDays, contaminationMax: 0 }),
      );

      expect(cohort.contamination.suspect).toBe(false);
      expect(measureOf(cohort.measures, 'D1').percent).toBe(100);
    });
  });

  describe('segmentation', () => {
    it('splits by platform derived from the uuid, never summing them', () => {
      const members = [
        ...Array.from({ length: 10 }, (_, i) =>
          player(premium(i), '2026-01-10', '2026-03-01'),
        ),
        ...Array.from({ length: 6 }, (_, i) =>
          player(bedrock(i), '2026-01-10', '2026-01-11'),
        ),
      ];

      const cohorts = buildCohorts(members, options());

      expect(cohorts.map((c) => [c.cohort, c.platform, c.size])).toEqual([
        ['2026-01', Platform.Bedrock, 6],
        ['2026-01', Platform.JavaPremium, 10],
      ]);
    });

    it('drops a row whose registerDate cannot be bucketed instead of guessing', () => {
      const members = [
        player(premium(1), '2026-01-10', '2026-03-01'),
        { uuid: premium(2), registeredAt: Number.NaN, lastSeenAt: NOW },
      ];

      const cohorts = buildCohorts(members, options());

      expect(cohorts).toHaveLength(1);
      expect(cohorts[0].size).toBe(1);
    });
  });

  describe('a last-seen before the registration never counts as survival', () => {
    it('treats a negative interval as not survived', () => {
      const members = [
        {
          uuid: premium(1),
          registeredAt: NOW - 40 * MS_PER_DAY,
          lastSeenAt: NOW - 45 * MS_PER_DAY,
        },
      ];

      const d1 = measureOf(buildCohorts(members, options())[0].measures, 'D1');

      expect(d1).toMatchObject({ percent: 0, n: 1, survived: 0 });
    });
  });
});
