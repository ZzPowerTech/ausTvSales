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

/**
 * Reason on the unmeasured variant, or `undefined` on the measured one.
 *
 * The union makes `unavailableReason` reachable only after narrowing — which is
 * the point of it — so the tests narrow here once instead of at every assertion.
 */
function reasonOf(
  value: { percent: number | null } | { value: number | null },
): string | undefined {
  const measured =
    'percent' in value ? value.percent !== null : value.value !== null;
  if (measured) {
    return undefined;
  }
  return (value as unknown as { unavailableReason: string }).unavailableReason;
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
      expect(reasonOf(conversion)).toBeDefined();
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
      expect(reasonOf(tutorial!)).toBeDefined();
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
      expect(reasonOf(tutorial!)).toBeUndefined();
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
      expect(reasonOf(conversion)).toContain('base zero');
    });
  });

  describe('the survival gap is stated, not hidden', () => {
    it('names why the survival step has no numbers', () => {
      const bucket = buildBucket('2026-03-10', counts({ network: 200 }));

      const survival = bucket.counts.find(
        (c) => c.step === FunnelStep.Survival,
      );
      expect(survival?.value).toBeNull();
      expect(reasonOf(survival!)).toContain('graph');
      expect(reasonOf(survival!)).toContain('plan_user_info');
      // And points at where the signal DOES exist today.
      expect(reasonOf(survival!)).toContain('funnel.network_to_survival');
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
          conversion.percent !== null || reasonOf(conversion) !== undefined;
        expect(explained).toBe(true);
      }
    });
  });

  it('turns the april/2026 pair into the ~12% the investigation reported', () => {
    // Named for what it is. The DoD asks the funnel to *reproduce* known
    // figures, and this does not do that — it feeds two numbers in by hand and
    // checks the division. Reproducing would mean running against the real
    // sources, and the network side cannot: `plan_users` lost the proxy's
    // history in the 2026-08-20 unification, so april/2026 has no denominator.
    //
    // What it does pin is that 360 arrivals and 43 entries render as 11,9% and
    // not as something else — which is the arithmetic the report depends on.
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
