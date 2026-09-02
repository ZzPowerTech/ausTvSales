import { Injectable } from '@nestjs/common';
import {
  buildBucket,
  STEP_REASON_FALLBACK,
  type RawCounts,
} from '../funnel/funnel-math';
import { FunnelService } from '../funnel/funnel.service';
import { FunnelGranularity, FunnelStep } from '../funnel/funnel.types';
import type { StepCount } from '../funnel/funnel.types';
import { InstrumentationHealthService } from '../health/instrumentation-health.service';
import { RetentionService } from '../retention/retention.service';
import { toSaoPauloDay } from '../tutorial/tutorial-day';
import type {
  FunnelSection,
  HealthSection,
  RetentionSection,
  StepCoverage,
  WeeklyReport,
} from './weekly-report.types';

const MS_PER_DAY = 86_400_000;

/** Days in the reported window. */
export const WINDOW_DAYS = 7;

/**
 * Cohort months included in the weekly report.
 *
 * Three. Retention is a slow number — with dozens of arrivals a month, a
 * fourth month adds rows nobody reads and pushes the Discord message toward the
 * aggregate character budget that the alerter already learned about the hard
 * way.
 */
export const RETENTION_MONTHS = 3;

/**
 * Assembles the weekly report from the three read models (story S9.2).
 *
 * ## It owns no data and computes no metric of its own
 *
 * Funnel from `FunnelService`, cohorts from `RetentionService`, instrumentation
 * from `InstrumentationHealthService`. A weekly report that recomputed anything
 * would be a second implementation of a number the API already publishes, and
 * the two would drift — with the report being the copy nobody checks.
 *
 * The single arithmetic this class does perform is the **roll-up of the daily
 * funnel into one weekly bucket**, and it does that through `buildBucket`, the
 * same function the daily endpoint uses, so the "no percentage without its base"
 * invariant is enforced by the same type in both places.
 *
 * ## One section failing does not take the report down
 *
 * The three reads run in parallel and each already degrades honestly on its own
 * — a failed source is a named failure inside the section, not an exception. A
 * report that went blank because one of three sources blinked would be less
 * useful than one that says which two it still has.
 */
@Injectable()
export class WeeklyReportBuilder {
  constructor(
    private readonly funnel: FunnelService,
    private readonly retention: RetentionService,
    private readonly health: InstrumentationHealthService,
  ) {}

  /**
   * Build the report for the window ending on `to`.
   *
   * @param to last day of the window, inclusive, `YYYY-MM-DD`
   */
  async build(to: string): Promise<WeeklyReport> {
    const from = daysBefore(to, WINDOW_DAYS - 1);
    const cohortTo = to.slice(0, 7);
    const cohortFrom = monthsBefore(cohortTo, RETENTION_MONTHS - 1);

    const [funnel, retention, health] = await Promise.all([
      this.funnelSection(from, to),
      this.retentionSection(cohortFrom, cohortTo),
      this.healthSection(),
    ]);

    return {
      from,
      to,
      generatedAt: new Date().toISOString(),
      funnel,
      retention,
      health,
    };
  }

  private async funnelSection(
    from: string,
    to: string,
  ): Promise<FunnelSection> {
    const series = await this.funnel.series(
      FunnelGranularity.Daily,
      from,
      to,
      'all',
    );

    const totals = rollUp(series.buckets.map((bucket) => bucket.counts));

    return {
      bucket: buildBucket(`${from}..${to}`, totals.raw),
      coverage: totals.coverage,
      sources: series.sources,
    };
  }

  private async retentionSection(
    from: string,
    to: string,
  ): Promise<RetentionSection> {
    const report = await this.retention.report(from, to, 'all');

    return {
      semantics: report.semantics,
      from: report.from,
      to: report.to,
      cohorts: report.cohorts,
      stampDays: report.stampDays,
      contaminatedSpans: report.contaminatedSpans,
      source: report.source,
    };
  }

  private async healthSection(): Promise<HealthSection> {
    return { summary: await this.health.summary() };
  }
}

/**
 * Sum each step across the window's days, refusing a partial sum.
 *
 * A step whose days are not all present comes back `null`, and the coverage line
 * says how many of the seven it had. That count is the honest alternative to
 * either silently summing six days as a week (a smaller numerator against a
 * full-week denominator) or dropping the step without saying why.
 */
function rollUp(days: readonly StepCount[][]): {
  raw: RawCounts;
  coverage: StepCoverage[];
} {
  const sums = new Map<string, number>();
  const covered = new Map<string, number>();
  const reasons = new Map<string, string>();

  for (const counts of days) {
    for (const count of counts) {
      if (count.value === null) {
        // First reason wins: they are the same sentence on every uncovered day
        // in practice, and quoting seven identical ones would only crowd the
        // message.
        //
        // The generic fallback is deliberately NOT collected. It carries no
        // information the roll-up does not already have, and appending it to the
        // roll-up's own sentence produced a line that blamed a missing source
        // and described an incomplete week at once.
        if (
          !reasons.has(count.step) &&
          count.unavailableReason !== STEP_REASON_FALLBACK
        ) {
          reasons.set(count.step, count.unavailableReason);
        }
        continue;
      }
      sums.set(count.step, (sums.get(count.step) ?? 0) + count.value);
      covered.set(count.step, (covered.get(count.step) ?? 0) + 1);
    }
  }

  const ofDays = days.length;
  const total = (step: FunnelStep): number | null =>
    covered.get(step) === ofDays && ofDays > 0 ? (sums.get(step) ?? 0) : null;

  /** The reason for a step that has no weekly total, or `undefined` when it has. */
  const reasonFor = (step: FunnelStep): string | undefined =>
    total(step) === null
      ? partialReason(reasons.get(step), covered.get(step) ?? 0, ofDays)
      : undefined;

  return {
    raw: {
      // No source for the proxy's population; `buildBucket` attaches the reason.
      network: null,
      survival: total(FunnelStep.Survival),
      survivalUnavailableReason: reasonFor(FunnelStep.Survival),
      tutorialEntered: total(FunnelStep.TutorialEntered),
      // Computed per step and not only for `survival`: the tutorial steps used
      // to fall through to the generic "sem fonte para este degrau", which
      // blames a healthy ETL for an incomplete week — and says so on the same
      // line as the coverage note contradicting it.
      tutorialEnteredUnavailableReason: reasonFor(FunnelStep.TutorialEntered),
      tutorialCompleted: total(FunnelStep.TutorialCompleted),
      tutorialCompletedUnavailableReason: reasonFor(
        FunnelStep.TutorialCompleted,
      ),
    },
    coverage: [
      FunnelStep.Network,
      FunnelStep.Survival,
      FunnelStep.TutorialEntered,
      FunnelStep.TutorialCompleted,
    ].map((step) => ({
      step,
      days: covered.get(step) ?? 0,
      ofDays,
    })),
  };
}

/**
 * The reason a step has no weekly total.
 *
 * Two different situations wear the same `null`, and the message separates them:
 * no day had a number (the source is out), or some days did (the week is
 * incomplete, and summing it would understate the total).
 */
function partialReason(
  dayReason: string | undefined,
  days: number,
  ofDays: number,
): string {
  if (days === 0) {
    return (
      dayReason ??
      'nenhum dia da janela trouxe numero para este degrau, entao nao ha ' +
        'total semanal'
    );
  }
  return (
    `so ${days} dos ${ofDays} dias da janela trouxeram numero para este ` +
    'degrau. Somar uma semana incompleta produziria um numerador menor contra ' +
    'um denominador de semana inteira, que e a forma de erro que este modulo ja ' +
    'publicou duas vezes. ' +
    (dayReason ?? '')
  ).trim();
}

/** Midday anchor, matching the funnel service's own convention. */
function atMidday(day: string): string {
  return `${day}T12:00:00-03:00`;
}

export function daysBefore(day: string, days: number): string {
  return toSaoPauloDay(Date.parse(atMidday(day)) - days * MS_PER_DAY) ?? day;
}

/** `YYYY-MM` arithmetic that never goes through a day that could roll over. */
export function monthsBefore(month: string, months: number): string {
  const [year, monthIndex] = month.split('-').map(Number);
  const zeroBased = year * 12 + (monthIndex - 1) - months;
  const targetYear = Math.floor(zeroBased / 12);
  const targetMonth = zeroBased - targetYear * 12 + 1;
  return `${String(targetYear).padStart(4, '0')}-${String(targetMonth).padStart(2, '0')}`;
}
