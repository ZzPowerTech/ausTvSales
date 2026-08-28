import { buildBucket, toMonth, type RawCounts } from './funnel-math';
import { FunnelStep } from './funnel.types';

function counts(over: Partial<RawCounts> = {}): RawCounts {
  return {
    network: null,
    survival: null,
    tutorialEntered: null,
    tutorialCompleted: null,
    ...over,
  };
}

function conversionOf(
  bucket: ReturnType<typeof buildBucket>,
  from: FunnelStep,
  to: FunnelStep,
) {
  const found = bucket.conversions.find((c) => c.from === from && c.to === to);
  if (found === undefined) {
    throw new Error(`conversion ${from}->${to} missing from the bucket`);
  }
  return found;
}

describe('buildBucket', () => {
  describe('no percentage ever leaves without its base', () => {
    it('publishes percent and n together', () => {
      const bucket = buildBucket(
        '2026-03-10',
        counts({ network: 200, tutorialEntered: 50 }),
      );

      const conversion = conversionOf(
        bucket,
        FunnelStep.Network,
        FunnelStep.TutorialEntered,
      );
      expect(conversion.percent).toBe(25);
      expect(conversion.n).toBe(200);
    });

    it('nulls percent and n together when the base is missing', () => {
      // A shape where `percent` could be set while `n` was null would
      // reintroduce exactly what the rule forbids — the investigation published
      // "queda de 96%" over a base nobody could check.
      const bucket = buildBucket('2026-03-10', counts({ tutorialEntered: 50 }));

      const conversion = conversionOf(
        bucket,
        FunnelStep.Network,
        FunnelStep.TutorialEntered,
      );
      expect(conversion.percent).toBeNull();
      expect(conversion.n).toBeNull();
      expect(conversion.unavailableReason).toBeDefined();
    });

    it('keeps the base when only the numerator is missing', () => {
      // The denominator is a real measurement. Withholding it would lose
      // information for no reason.
      const bucket = buildBucket('2026-03-10', counts({ network: 200 }));

      const conversion = conversionOf(
        bucket,
        FunnelStep.Network,
        FunnelStep.Survival,
      );
      expect(conversion.percent).toBeNull();
      expect(conversion.n).toBe(200);
    });

    it('rounds to one decimal', () => {
      const bucket = buildBucket(
        '2026-03-10',
        counts({ network: 3, tutorialEntered: 1 }),
      );

      expect(
        conversionOf(bucket, FunnelStep.Network, FunnelStep.TutorialEntered)
          .percent,
      ).toBe(33.3);
    });
  });

  describe('absent is not zero', () => {
    it('reports a missing step as null with a reason, never as 0', () => {
      // A collection gap read as zero is what made the tutorial's eight-month
      // outage invisible.
      const bucket = buildBucket('2026-03-10', counts({ network: 200 }));

      const tutorial = bucket.counts.find(
        (c) => c.step === FunnelStep.TutorialEntered,
      );
      expect(tutorial?.value).toBeNull();
      expect(tutorial?.value).not.toBe(0);
      expect(tutorial?.unavailableReason).toBeDefined();
    });

    it('keeps a real zero as a zero', () => {
      // Measured-and-nobody-came is a fact, and must survive the round trip.
      const bucket = buildBucket(
        '2026-03-10',
        counts({ network: 200, tutorialEntered: 0 }),
      );

      const tutorial = bucket.counts.find(
        (c) => c.step === FunnelStep.TutorialEntered,
      );
      expect(tutorial?.value).toBe(0);
      expect(tutorial?.unavailableReason).toBeUndefined();
      // And a measured zero over a real base is a real 0%.
      expect(
        conversionOf(bucket, FunnelStep.Network, FunnelStep.TutorialEntered)
          .percent,
      ).toBe(0);
    });

    it('refuses to divide by an empty period', () => {
      // Publishing `0%` for a day nobody arrived would invent a catastrophic
      // reading out of an empty period — the confusion between "nobody arrived"
      // and "nobody converted" that this contract exists to make impossible.
      const bucket = buildBucket(
        '2026-03-10',
        counts({ network: 0, tutorialEntered: 0 }),
      );

      const conversion = conversionOf(
        bucket,
        FunnelStep.Network,
        FunnelStep.TutorialEntered,
      );
      expect(conversion.percent).toBeNull();
      // The base still travels: zero arrivals IS the measurement.
      expect(conversion.n).toBe(0);
      expect(conversion.unavailableReason).toContain('base zero');
    });
  });

  describe('the survival gap is stated, not hidden', () => {
    it('names why the survival step has no numbers', () => {
      const bucket = buildBucket('2026-03-10', counts({ network: 200 }));

      const survival = bucket.counts.find(
        (c) => c.step === FunnelStep.Survival,
      );
      expect(survival?.value).toBeNull();
      expect(survival?.unavailableReason).toContain('graph');
      expect(survival?.unavailableReason).toContain('plan_user_info');
      // And points at where the signal DOES exist today.
      expect(survival?.unavailableReason).toContain(
        'funnel.network_to_survival',
      );
    });

    it('still publishes rede -> tutorial_entrou across the gap', () => {
      // A chain that stopped at the first missing step would withhold the one
      // comparison that is fully measurable today — and it is the number whose
      // collapse went unnoticed for eight months.
      const bucket = buildBucket(
        '2026-03-10',
        counts({ network: 200, tutorialEntered: 24 }),
      );

      const bridge = conversionOf(
        bucket,
        FunnelStep.Network,
        FunnelStep.TutorialEntered,
      );
      expect(bridge.percent).toBe(12);
      expect(bridge.n).toBe(200);
    });

    it('reports every consecutive pair even when one side is missing', () => {
      const bucket = buildBucket('2026-03-10', counts({ network: 200 }));

      // Three consecutive pairs plus the bridge.
      expect(bucket.conversions).toHaveLength(4);
      for (const conversion of bucket.conversions) {
        // Each one either has both halves or explains itself. Never silent.
        const explained =
          conversion.percent !== null ||
          conversion.unavailableReason !== undefined;
        expect(explained).toBe(true);
      }
    });
  });

  it('reproduces the known ~12% tutorial entry rate of april/2026', () => {
    // The DoD asks the funnel to reproduce known figures. This is the one the
    // investigation established: entry had fallen to 12% by april.
    const bucket = buildBucket(
      '2026-04',
      counts({ network: 360, tutorialEntered: 43 }),
    );

    expect(
      conversionOf(bucket, FunnelStep.Network, FunnelStep.TutorialEntered)
        .percent,
    ).toBeCloseTo(11.9, 1);
  });
});

describe('toMonth', () => {
  it('truncates a day to its month', () => {
    expect(toMonth('2026-03-10')).toBe('2026-03');
    expect(toMonth('2026-12-31')).toBe('2026-12');
  });
});
