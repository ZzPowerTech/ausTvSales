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

/**
 * The base in these cases is `survival`, and it used to be `network`.
 *
 * Not a rename for tidiness: `plan_users` was measured on 2026-08-31 to hold the
 * Survival, so the counts these tests feed in have always been survival counts.
 * They were being fed to the step called `rede`, which made the `rede → survival`
 * conversion Survival ÷ Survival.
 */
describe('buildBucket', () => {
  describe('no percentage ever leaves without its base', () => {
    it('publishes percent and n together', () => {
      const bucket = buildBucket(
        '2026-03-10',
        counts({ survival: 200, tutorialEntered: 50 }),
      );

      const conversion = conversionOf(
        bucket,
        FunnelStep.Survival,
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
        FunnelStep.Survival,
        FunnelStep.TutorialEntered,
      );
      expect(conversion.percent).toBeNull();
      expect(conversion.n).toBeNull();
      expect(reasonOf(conversion)).toBeDefined();
    });

    it('keeps the base when only the numerator is missing', () => {
      // The denominator is a real measurement. Withholding it would lose
      // information for no reason.
      const bucket = buildBucket('2026-03-10', counts({ survival: 200 }));

      const conversion = conversionOf(
        bucket,
        FunnelStep.Survival,
        FunnelStep.TutorialEntered,
      );
      expect(conversion.percent).toBeNull();
      expect(conversion.n).toBe(200);
    });

    it('rounds to one decimal', () => {
      const bucket = buildBucket(
        '2026-03-10',
        counts({ survival: 3, tutorialEntered: 1 }),
      );

      expect(
        conversionOf(bucket, FunnelStep.Survival, FunnelStep.TutorialEntered)
          .percent,
      ).toBe(33.3);
    });
  });

  describe('absent is not zero', () => {
    it('reports a missing step as null with a reason, never as 0', () => {
      // A collection gap read as zero is what made the tutorial's eight-month
      // outage invisible.
      const bucket = buildBucket('2026-03-10', counts({ survival: 200 }));

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
        counts({ survival: 200, tutorialEntered: 0 }),
      );

      const tutorial = bucket.counts.find(
        (c) => c.step === FunnelStep.TutorialEntered,
      );
      expect(tutorial?.value).toBe(0);
      expect(reasonOf(tutorial!)).toBeUndefined();
      // And a measured zero over a real base is a real 0%.
      expect(
        conversionOf(bucket, FunnelStep.Survival, FunnelStep.TutorialEntered)
          .percent,
      ).toBe(0);
    });

    it('refuses to divide by an empty period', () => {
      // Publishing `0%` for a day nobody arrived would invent a catastrophic
      // reading out of an empty period — the confusion between "nobody arrived"
      // and "nobody converted" that this contract exists to make impossible.
      const bucket = buildBucket(
        '2026-03-10',
        counts({ survival: 0, tutorialEntered: 0 }),
      );

      const conversion = conversionOf(
        bucket,
        FunnelStep.Survival,
        FunnelStep.TutorialEntered,
      );
      expect(conversion.percent).toBeNull();
      // The base still travels: zero arrivals IS the measurement.
      expect(conversion.n).toBe(0);
      expect(reasonOf(conversion)).toContain('base zero');
    });
  });

  describe('the network gap is stated, not hidden', () => {
    it('names why the rede step has no numbers', () => {
      const bucket = buildBucket('2026-03-10', counts({ survival: 200 }));

      const rede = bucket.counts.find((c) => c.step === FunnelStep.Network);
      expect(rede?.value).toBeNull();
      // The reason names the table and the measurement, not just "sem fonte" —
      // whoever reads it has to be able to tell that the population is in the
      // old database rather than that a query failed.
      expect(reasonOf(rede!)).toContain('plan_users');
      expect(reasonOf(rede!)).toContain('plan_user_info');
    });

    it('refuses rede -> survival rather than dividing a step by itself', () => {
      // The defect this file was rewritten for. With `plan_users` feeding the
      // `rede` step, this conversion was Survival ÷ Survival: a number near
      // 100% that could not fall with the whole network gone.
      const bucket = buildBucket('2026-03-10', counts({ survival: 200 }));

      const conversion = conversionOf(
        bucket,
        FunnelStep.Network,
        FunnelStep.Survival,
      );
      expect(conversion.percent).toBeNull();
      expect(conversion.n).toBeNull();
      expect(reasonOf(conversion)).toContain('plan_users');
    });

    it('still publishes survival -> tutorial_entrou across the gap', () => {
      // A chain that stopped at the first missing step would withhold the one
      // comparison that is fully measurable today — and it is the number whose
      // collapse went unnoticed for eight months.
      const bucket = buildBucket(
        '2026-03-10',
        counts({ survival: 200, tutorialEntered: 24 }),
      );

      const measured = conversionOf(
        bucket,
        FunnelStep.Survival,
        FunnelStep.TutorialEntered,
      );
      expect(measured.percent).toBe(12);
      expect(measured.n).toBe(200);
    });

    it('publishes the three consecutive pairs and no bridge', () => {
      const bucket = buildBucket('2026-03-10', counts({ survival: 200 }));

      // Three consecutive pairs. The `rede -> tutorial_entrou` bridge went away
      // with the relabel: `survival` is adjacent to `tutorial_entrou` now, so
      // the bridge could only restate a consecutive pair — and, with `rede`
      // permanently null, restate it as a null.
      expect(bucket.conversions).toHaveLength(3);
      expect(
        bucket.conversions.find(
          (c) =>
            c.from === FunnelStep.Network &&
            c.to === FunnelStep.TutorialEntered,
        ),
      ).toBeUndefined();

      for (const conversion of bucket.conversions) {
        // Each one either has both halves or explains itself. Never silent.
        const explained =
          conversion.percent !== null || reasonOf(conversion) !== undefined;
        expect(explained).toBe(true);
      }
    });

    it('carries the caller reason for survival when it has one', () => {
      // Per bucket, because inside one successful read "the source does not
      // reach back this far" and "the query failed" are opposite diagnoses.
      const bucket = buildBucket(
        '2026-03-10',
        counts({ survivalUnavailableReason: 'fonte comeca em 2024-06-02' }),
      );

      const survival = bucket.counts.find(
        (c) => c.step === FunnelStep.Survival,
      );
      expect(reasonOf(survival!)).toBe('fonte comeca em 2024-06-02');
    });
  });

  it('turns the april/2026 pair into the ~12% the investigation reported', () => {
    // Named for what it is. The DoD asks the funnel to *reproduce* known
    // figures, and this does not do that — it feeds two numbers in by hand and
    // checks the division.
    //
    // What has changed since this test was written is which figures it may use.
    // 360 was the `rede` column of the verified table, and the funnel cannot
    // produce it: that population is in the old database. 192 is the `survival`
    // column for the same month, which is what `plan_users` actually holds, and
    // 43/192 is the ratio this endpoint would render.
    const bucket = buildBucket(
      '2026-04',
      counts({ survival: 192, tutorialEntered: 43 }),
    );

    expect(
      conversionOf(bucket, FunnelStep.Survival, FunnelStep.TutorialEntered)
        .percent,
    ).toBeCloseTo(22.4, 1);
  });
});

describe('toMonth', () => {
  it('truncates a day to its month', () => {
    expect(toMonth('2026-03-10')).toBe('2026-03');
    expect(toMonth('2026-12-31')).toBe('2026-12');
  });
});
