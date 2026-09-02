import {
  FunnelStep,
  FUNNEL_STEPS,
  NETWORK_STEP_UNAVAILABLE,
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
  /**
   * Always `null` today — see `NETWORK_STEP_UNAVAILABLE`.
   *
   * Kept in the shape rather than deleted because the step is still published,
   * and a caller that one day finds a proxy-side source fills this in and
   * nothing else here changes.
   */
  network: number | null;
  survival: number | null;
  /**
   * Why `survival` is `null` in **this** bucket, when it is.
   *
   * Per bucket, not per read, because the reasons differ inside one successful
   * response: the source can answer for August and cover nothing in March. A
   * single response-level reason would attach "a fonte falhou" to a bucket the
   * source simply does not reach back to.
   */
  survivalUnavailableReason?: string;
  tutorialEntered: number | null;
  /**
   * Why `tutorialEntered` is `null` in **this** bucket, when it is.
   *
   * Added for the weekly roll-up (story S9.2), and the gap it closes is a false
   * sentence rather than a missing one: without it the default read *"sem fonte
   * para este degrau no periodo"*, so a week that was merely **incomplete** —
   * six of seven days present, the ETL fine — blamed a missing source, on the
   * same line as a `6/7 dias` coverage note contradicting it.
   */
  tutorialEnteredUnavailableReason?: string;
  tutorialCompleted: number | null;
  /** Same, for the completion step. */
  tutorialCompletedUnavailableReason?: string;
}

/**
 * Build the bucket, including every conversion between consecutive steps.
 *
 * ## Why conversions skip over a missing step instead of stopping
 *
 * The `rede` step has no source, and a chain that gave up at the first gap would
 * publish nothing at all — including `survival → tutorial_entrou`, which is
 * fully measurable today and is the comparison whose collapse went unnoticed for
 * eight months.
 *
 * So each *consecutive* pair is reported, with a reason where it cannot be
 * computed. `rede → survival` is one of those pairs and comes back `null` with
 * `NETWORK_STEP_UNAVAILABLE` as its reason — which is the point of this change:
 * it used to come back near 100%, because both sides were the Survival.
 *
 * ## The `rede → tutorial_entrou` bridge was removed on 2026-08-31
 *
 * It existed to reach over a `survival` step that had no source, so the
 * tutorial's capture rate could still be seen against *something*. The two steps
 * swapped roles: `survival` now carries the numbers and is **adjacent** to
 * `tutorial_entrou`, so the bridge would only ever restate a consecutive pair —
 * and, with `rede` permanently `null`, restate it as a null. A conversion that
 * can never be computed is not caution, it is a field consumers learn to ignore.
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

  return { bucket, counts, conversions };
}

function toStepCounts(raw: RawCounts): StepCount[] {
  return [
    step(FunnelStep.Network, raw.network, NETWORK_STEP_UNAVAILABLE),
    step(FunnelStep.Survival, raw.survival, raw.survivalUnavailableReason),
    step(
      FunnelStep.TutorialEntered,
      raw.tutorialEntered,
      raw.tutorialEnteredUnavailableReason,
    ),
    step(
      FunnelStep.TutorialCompleted,
      raw.tutorialCompleted,
      raw.tutorialCompletedUnavailableReason,
    ),
  ];
}

/**
 * What a step says when nothing more specific is known.
 *
 * Exported so a consumer can tell "this is the fallback" from "somebody
 * explained this". The weekly roll-up needs the distinction: it composes its own
 * sentence about an incomplete week, and appending this one to it produced a
 * line that blamed a missing source and described an incomplete week at the same
 * time — contradicting itself, next to a coverage note contradicting both.
 */
export const STEP_REASON_FALLBACK = 'sem fonte para este degrau no periodo';

function step(
  name: FunnelStep,
  value: number | null,
  reason: string | undefined = undefined,
): StepCount {
  const explanation = reason ?? STEP_REASON_FALLBACK;
  return value === null
    ? { step: name, value: null, unavailableReason: explanation }
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
