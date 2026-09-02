import type { FunnelSourceState } from '../funnel/funnel.service';
import type { FunnelBucket } from '../funnel/funnel.types';
import type { InstrumentationSummaryDto } from '../health/dto/instrumentation-health.dto';
import type {
  CohortRetention,
  ContaminatedSpan,
  RetentionSourceState,
  StampDay,
} from '../retention/retention.types';

/**
 * The weekly report (story S9.2, spec §6.1/§6.2).
 *
 * ## Why this exists at all
 *
 * *"A leitura que chega sozinha, sem ninguém precisar abrir página."* Every
 * disaster this epic found was silent for months, and the common factor was that
 * seeing it required someone to go and look. A dashboard nobody opens is
 * indistinguishable from a dashboard with nothing to say.
 *
 * ## The window is the last seven **complete** days
 *
 * Not "the last seven days including today". A partial day would make the newest
 * bucket structurally smaller than the others, so week-over-week comparison
 * would read as a decline every single week — the shape of error this project
 * has already published twice.
 */
export interface WeeklyReport {
  /** First day of the window, `YYYY-MM-DD` in America/Sao_Paulo. */
  from: string;
  /** Last day of the window, inclusive. */
  to: string;
  /** When the report was assembled. ISO-8601. */
  generatedAt: string;
  funnel: FunnelSection;
  retention: RetentionSection;
  health: HealthSection;
}

/**
 * The four-step funnel, rolled up over the whole window.
 *
 * ## The roll-up refuses a partial week
 *
 * A step is summed only when **every day** in the window carries a number. One
 * missing day and the weekly total is `null` with the reason, because a sum over
 * six days published as a week is a smaller numerator against a full-week
 * denominator — the same defect that made this module publish a 4500% conversion
 * twice, and a partial month read as a whole one.
 *
 * The bucket itself is built by `buildBucket`, the same function the daily
 * endpoint uses. That is deliberate: the invariant *no percentage without its
 * base* is enforced by the `Conversion` type, and re-implementing the roll-up
 * here would be a second place where that could quietly stop being true.
 */
export interface FunnelSection {
  /** The window rolled into one bucket, keyed `from..to`. */
  bucket: FunnelBucket;
  /** How many of the window's days each step could actually be summed over. */
  coverage: StepCoverage[];
  sources: FunnelSourceState[];
}

/** Days covered versus days in the window, per step. */
export interface StepCoverage {
  step: string;
  /** Days in the window that carried a number for this step. */
  days: number;
  /** Days in the window. The base — published even when `days` equals it. */
  ofDays: number;
}

/** Cohort retention, restricted to the months worth reading weekly. */
export interface RetentionSection {
  /** What the percentages mean. Carried, never assumed — see the module. */
  semantics: string;
  /** First cohort month included. */
  from: string;
  /** Last cohort month included. */
  to: string;
  cohorts: CohortRetention[];
  /** Bulk-import stamps detected in the source population. */
  stampDays: StampDay[];
  /**
   * The span of registration months proven to carry the import artefact.
   *
   * Carried because in this population `stampDays` comes back **empty** while
   * the artefact is real: the 2026-09-02 read suppressed 21 of 45 cohorts with
   * no stamp day anywhere. Without this field the weekly report would print a
   * page of cohorts with no numbers and no reason a reader could see.
   */
  contaminatedSpan?: ContaminatedSpan;
  source: RetentionSourceState;
}

/** State of the instrumentation layer itself, as the S7.1 read model sees it. */
export interface HealthSection {
  summary: InstrumentationSummaryDto;
}

/** How a run ended. */
export const WEEKLY_REPORT_STATUSES = ['ok', 'error'] as const;

export type WeeklyReportStatus = (typeof WEEKLY_REPORT_STATUSES)[number];

/** One persisted run, as stored and as read back. */
export interface WeeklyReportRecord {
  id: number;
  generatedAt: Date;
  periodFrom: string;
  periodTo: string;
  status: WeeklyReportStatus;
  payload: WeeklyReport | null;
  rendered: string | null;
  /**
   * Whether the channel received it.
   *
   * Deliberately separate from `status`: a report can build perfectly and fail
   * to reach Discord, and folding the two would make a webhook outage look like
   * an analytics outage.
   */
  delivered: boolean;
  detail: string | null;
}
