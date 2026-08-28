import {
  FunnelStep,
  FUNNEL_STEPS,
  SURVIVAL_STEP_UNAVAILABLE,
  type Conversion,
  type FunnelBucket,
  type StepCount,
} from './funnel.types';

/**
 * The rules that turn counts into a funnel bucket (story S8.1).
 *
 * Pure, so the two rules that matter most — *never publish a percentage without
 * its base* and *absent is not zero* — are testable without a database, an HTTP
 * client or a clock.
 */

/** Counts a caller has for one bucket. `null` means "no source", never zero. */
export interface RawCounts {
  network: number | null;
  survival: number | null;
  tutorialEntered: number | null;
  tutorialCompleted: number | null;
}

/**
 * Build the bucket, including every conversion between consecutive steps.
 *
 * ## Why conversions skip over a missing step instead of stopping
 *
 * The `survival` step has no source yet, and a chain that gave up at the first
 * gap would publish nothing at all — including `rede → tutorial_entrou`, which
 * is fully measurable today and is the comparison that would have caught the
 * eight-month outage.
 *
 * So each *consecutive* pair is reported (with a reason where it cannot be
 * computed), and the pairs that bridge the gap are reported too. The bridging
 * conversion is marked so nobody reads it as an adjacent step.
 */
export function buildBucket(bucket: string, raw: RawCounts): FunnelBucket {
  const counts = toStepCounts(raw);
  const byStep = new Map(counts.map((count) => [count.step, count]));

  const conversions: Conversion[] = [];
  for (let i = 0; i < FUNNEL_STEPS.length - 1; i++) {
    conversions.push(
      convert(byStep.get(FUNNEL_STEPS[i]), byStep.get(FUNNEL_STEPS[i + 1])),
    );
  }

  // The one bridge worth publishing: with `survival` missing, this is the only
  // way to see the tutorial's capture rate against arrivals at all, and it is
  // the number whose collapse went unnoticed for eight months.
  conversions.push(
    convert(
      byStep.get(FunnelStep.Network),
      byStep.get(FunnelStep.TutorialEntered),
    ),
  );

  return { bucket, counts, conversions };
}

function toStepCounts(raw: RawCounts): StepCount[] {
  return [
    step(FunnelStep.Network, raw.network),
    step(FunnelStep.Survival, raw.survival, SURVIVAL_STEP_UNAVAILABLE),
    step(FunnelStep.TutorialEntered, raw.tutorialEntered),
    step(FunnelStep.TutorialCompleted, raw.tutorialCompleted),
  ];
}

function step(
  name: FunnelStep,
  value: number | null,
  reason = 'sem fonte para este degrau no periodo',
): StepCount {
  return value === null
    ? { step: name, value: null, unavailableReason: reason }
    : { step: name, value };
}

/**
 * One step-to-step conversion.
 *
 * `percent` and `n` are set together or not at all. A denominator of zero yields
 * neither: dividing by it is undefined, and publishing `0%` there would invent a
 * catastrophic-looking reading out of an empty period — the precise confusion
 * between "nobody arrived" and "nobody converted" that this contract exists to
 * make unrepresentable.
 */
function convert(from?: StepCount, to?: StepCount): Conversion {
  const pair = { from: from?.step as FunnelStep, to: to?.step as FunnelStep };

  if (from?.value === null || from?.value === undefined) {
    return {
      ...pair,
      percent: null,
      n: null,
      unavailableReason:
        from?.unavailableReason ?? 'sem base para calcular a conversao',
    };
  }

  if (to?.value === null || to?.value === undefined) {
    return {
      ...pair,
      percent: null,
      // The base is published even without a numerator: it is a real
      // measurement, and withholding it would lose information for no reason.
      n: from.value,
      unavailableReason:
        to?.unavailableReason ?? 'sem numerador para calcular a conversao',
    };
  }

  if (from.value === 0) {
    return {
      ...pair,
      percent: null,
      n: 0,
      unavailableReason:
        'base zero no periodo — nenhuma chegada para converter, o que nao e o ' +
        'mesmo que 0% de conversao',
    };
  }

  return {
    ...pair,
    percent: Math.round((to.value / from.value) * 1000) / 10,
    n: from.value,
  };
}

/** `YYYY-MM-DD` → `YYYY-MM`. The only place the two grains meet. */
export function toMonth(day: string): string {
  return day.slice(0, 7);
}
