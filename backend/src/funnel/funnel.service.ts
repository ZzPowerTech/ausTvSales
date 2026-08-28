import { Injectable, Logger } from '@nestjs/common';
import { PlanDatabase } from '../instrumentation/plan-database';
import { platformOf, Platform } from '../instrumentation/platform';
import { TutorialStore } from '../tutorial/tutorial.store';
import { toSaoPauloDay } from '../tutorial/tutorial-day';
import { buildBucket, toMonth, type RawCounts } from './funnel-math';
import {
  FunnelGranularity,
  type FunnelBucket,
  type PlatformFilter,
} from './funnel.types';

const MS_PER_DAY = 86_400_000;
/**
 * Ceiling on the span a single request may ask for, in **days**.
 *
 * 366, matching the analytics endpoints of story S5.1. Not arbitrary: a caller
 * asking for ten years would stream ten years of `plan_users` rows out of the
 * game machine's MySQL to build a chart nobody can read.
 *
 * Counted in days rather than buckets, and the distinction is a bug that was
 * here: capping *buckets* meant the monthly mode allowed 366 **months** — thirty
 * years — while the daily mode allowed 366 days. One constant, two windows, and
 * the endpoint's own description claimed they were the same.
 *
 * Enforced in {@link FunnelService.clampFrom}, **before** either source is
 * queried, so the ceiling protects the game machine and not merely the response.
 */
const MAX_WINDOW_DAYS = 366;

/**
 * Why a source could not answer.
 *
 * A **closed vocabulary**, not the upstream message — the same decision story
 * S7.2 made for `MetricsFailureReason`, and for the same reason. A `mysql2`
 * error reads `Access denied for user 'plan_ro'@'172.18.0.3'` or
 * `connect ECONNREFUSED 10.0.0.5:3306`: internal topology, an account name, and
 * sometimes a table name, none of which belongs in an HTTP body. `HealthService`
 * cites CWE-209 for the same call.
 *
 * The full message goes to the log, where whoever is debugging will look.
 */
export const FUNNEL_SOURCE_FAILURES = [
  /** The source is not configured — our deploy, not an outage. */
  'not_configured',
  /** The query failed: unreachable, refused, or a schema that moved. */
  'query_failed',
  /** The tutorial ETL has never completed, so the table means nothing yet. */
  'never_synced',
] as const;

export type FunnelSourceFailure = (typeof FUNNEL_SOURCE_FAILURES)[number];

/** What a read produced, plus how fresh each source was. */
export interface FunnelSeries {
  granularity: FunnelGranularity;
  platform: PlatformFilter;
  from: string;
  to: string;
  /**
   * True when the requested window was longer than the cap and was trimmed.
   *
   * Published rather than silently applied: `from`/`to` echo what was actually
   * read, and a consumer that asked for ten years has to be able to tell that it
   * did not get ten years.
   */
  truncated: boolean;
  buckets: FunnelBucket[];
  /** Provenance, so a stale answer is visibly stale rather than silently old. */
  sources: FunnelSourceState[];
}

/** State of one underlying source at read time. */
export interface FunnelSourceState {
  name: 'plan_users' | 'tutorial_daily';
  ok: boolean;
  /** ISO-8601 of the data's own currency, where the source reports one. */
  asOf: string | null;
  /** Closed label. Set exactly when `ok` is false. Never an upstream message. */
  failure?: FunnelSourceFailure;
  /**
   * First day this source can speak for, `YYYY-MM-DD`.
   *
   * **`null` means it covers nothing**, not that it covers everything — the
   * table is empty, so every bucket is `null`. The opposite reading would be the
   * more natural one for the word "unbounded", which is exactly why it is spelt
   * out here.
   *
   * `plan_users` lost the proxy's history in the 2026-08-20 unification, so it
   * is only a few days deep. Buckets before this are `null` with a reason, never
   * a measured zero — see `PlanDatabase.earliestArrivalAt`. In monthly
   * granularity a **partially** covered month counts as uncovered: a month total
   * cannot be assembled from part of a month.
   */
  coversFrom?: string | null;
}

/**
 * The four-step funnel (story S8.1, spec §6.2).
 *
 * ## Two sources, read independently, failing independently
 *
 * The network step comes from `plan_users` over the game's MySQL (ADR-002
 * exception 2); both tutorial steps come from `tutorial_daily`, which the S8.0
 * ETL rebuilds nightly. They are read in parallel and **one failing does not
 * take the other down** — a funnel that goes blank because one of two databases
 * blinked would be less useful than one that says which half it still has.
 *
 * The `survival` step has no daily source yet; the reason travels in the
 * payload. See `SURVIVAL_STEP_UNAVAILABLE`.
 *
 * ## Bucketing happens here, in America/Sao_Paulo
 *
 * Not in SQL. `plan_users.registered` is an epoch on someone else's database,
 * and `platform` comes from ADR-003's UUID rule, which is TypeScript. Pushing
 * either into MySQL would hardcode a timezone into a schema we do not own, or
 * write the platform rule a second time in a second language where the two
 * spellings would drift apart.
 *
 * ## Where the "heavy aggregation off-peak" of criterion 5 went
 *
 * The criterion assumes a job. Measured, this is not heavy: `plan_users` held
 * **5.566 rows in total** on 2026-08-23, and every read here is windowed on top
 * of that. A nightly ETL for a few thousand rows would be ceremony, and it would
 * add a staleness of its own to a number that is currently live.
 *
 * The criterion has two halves, and only one is delivered here:
 *
 * - *"never make the game machine pay for a dashboard refresh"* — **delivered**:
 *   the window is clamped to `MAX_WINDOW_DAYS` **before** either source is
 *   queried, so no request can widen the scan.
 * - *"falha mantém último resultado válido, datado"* — **not delivered.** A
 *   failed source returns `null` with a closed label, not the last good value.
 *   That is honest degradation, which is a different thing. The repo already has
 *   the missing capability in `PlanCache` (`outcome: 'stale'` plus the age it
 *   actually has), built in story S7.2 for exactly this; wiring the funnel
 *   through it is the obvious next step and is not in this slice.
 *
 * If `plan_users` ever grows by orders of magnitude, this comment is the place
 * that should stop being true, and the ETL is the answer then.
 */
@Injectable()
export class FunnelService {
  private readonly logger = new Logger(FunnelService.name);

  constructor(
    private readonly planDb: PlanDatabase,
    private readonly tutorial: TutorialStore,
  ) {}

  /**
   * Build a series between two calendar days, inclusive.
   *
   * @param platform `'all'` sums every platform; anything else filters to it.
   */
  async series(
    granularity: FunnelGranularity,
    requestedFrom: string,
    toDay: string,
    platform: PlatformFilter = 'all',
  ): Promise<FunnelSeries> {
    // Clamped BEFORE the sources are asked, not after. The first version capped
    // only the output array, so a request for 1970..2026 still ran
    // `SELECT ... FROM plan_users` across the whole table and then threw the
    // rows away — the cap protected the response and not the game machine,
    // which is the thing it exists for.
    const fromDay = this.clampFrom(requestedFrom, toDay);
    const truncated = fromDay !== requestedFrom;

    const bucketKeys = this.bucketKeys(granularity, fromDay, toDay);

    const [network, tutorial] = await Promise.all([
      this.networkByBucket(granularity, fromDay, toDay, platform),
      this.tutorialByBucket(granularity, fromDay, toDay, platform),
    ]);

    const buckets = bucketKeys.map(
      (key) =>
        buildBucket(key, {
          network: network.countFor(key),
          // No daily source; the reason is attached by `buildBucket`.
          survival: null,
          tutorialEntered:
            tutorial.enteredByBucket.get(key) ?? tutorial.missing,
          tutorialCompleted:
            tutorial.completedByBucket.get(key) ?? tutorial.missing,
        } satisfies RawCounts),
      // `network.countFor` decides per bucket, because coverage is per bucket:
      // the source can answer for this week and know nothing about March.
    );

    return {
      granularity,
      platform,
      from: fromDay,
      to: toDay,
      truncated,
      buckets,
      sources: [network.state, tutorial.state],
    };
  }

  /**
   * Pull `from` forward so the window never exceeds {@link MAX_WINDOW_DAYS}.
   *
   * Trims the **old** end rather than the recent one: a caller asking for too
   * much almost always wants the latest data, and silently returning 1970 would
   * be the least useful possible answer.
   */
  private clampFrom(requestedFrom: string, toDay: string): string {
    // `- 1` because both ends are inclusive: `to` minus 365 days, through `to`,
    // is 366 days. Subtracting the full 366 would allow 367 — the same
    // inclusive-range slip the tutorial check shipped once.
    const earliestAllowed =
      Date.parse(atMidday(toDay)) - (MAX_WINDOW_DAYS - 1) * MS_PER_DAY;
    const requested = Date.parse(atMidday(requestedFrom));

    if (Number.isNaN(requested) || requested >= earliestAllowed) {
      return requestedFrom;
    }
    return toSaoPauloDay(earliestAllowed) ?? requestedFrom;
  }

  /**
   * Network arrivals per bucket, from `plan_users`.
   *
   * `missing` is what an *absent* bucket maps to, and it is the load-bearing
   * detail: when the source answered, a bucket with no arrivals is a measured
   * **0**; when the source failed, it is **null**. Collapsing the two would
   * publish "nobody connected all month" for a database outage.
   */
  private async networkByBucket(
    granularity: FunnelGranularity,
    fromDay: string,
    toDay: string,
    platform: PlatformFilter,
  ): Promise<NetworkCounts> {
    const byBucket = new Map<string, number>();

    if (!this.planDb.configured) {
      return {
        countFor: () => null,
        state: {
          name: 'plan_users',
          ok: false,
          asOf: null,
          failure: 'not_configured',
        },
      };
    }

    try {
      // `earliestArrivalAt` first, and it is not an optimisation: without it a
      // successful query over a period the table does not cover reads as a
      // measured zero. See the method's own doc.
      const [earliest, arrivals] = await Promise.all([
        this.planDb.earliestArrivalAt(),
        this.planDb.networkArrivalsBetween(
          Date.parse(startOfDay(fromDay)),
          Date.parse(endOfDay(toDay)),
        ),
      ]);

      for (const arrival of arrivals) {
        if (platform !== 'all' && platformOf(arrival.uuid) !== platform) {
          continue;
        }
        const day = toSaoPauloDay(arrival.registeredAt);
        if (day === null) {
          // An unusable `registered` cannot be filed under a day. Dropped rather
          // than guessed — the same rule the ETL applies to `started-date`.
          continue;
        }
        const key =
          granularity === FunnelGranularity.Monthly ? toMonth(day) : day;
        byBucket.set(key, (byBucket.get(key) ?? 0) + 1);
      }

      // The first **whole** day, then the first whole month derived from it.
      // Both grains read `MIN(registered)` the same way — as the point the old
      // database was truncated at, which is what `earliestArrivalAt` documents —
      // so neither publishes a partial bucket as a total.
      const coversFrom =
        earliest === null ? null : firstFullyCoveredDay(earliest);
      const coversFromKey =
        coversFrom === null
          ? null
          : granularity === FunnelGranularity.Monthly
            ? firstFullyCoveredMonth(coversFrom)
            : coversFrom;

      return {
        countFor: (key) => {
          // Coverage is checked FIRST, before any count is returned — and the
          // order is the fix, not a detail. Returning a counted bucket early
          // meant a partially covered month still published its partial total
          // as if it were a month, which is a smaller denominator against a
          // whole-month numerator: the 4500% conversion, on the one bucket in
          // `/funnel/monthly`'s default window that has a number at all.
          //
          // The proxy's history stayed in the old database at the 2026-08-20
          // unification, so `plan_users` is only days deep and this is the
          // common case, not the edge.
          if (coversFromKey === null || key < coversFromKey) {
            return null;
          }
          // Covered. An absent bucket is now a genuine measured zero.
          return byBucket.get(key) ?? 0;
        },
        state: {
          name: 'plan_users',
          ok: true,
          asOf: new Date().toISOString(),
          coversFrom,
        },
      };
    } catch (error) {
      // The message names the host, the account and sometimes the table. It goes
      // to the log; the body gets a closed label (CWE-209, and the decision
      // story S7.2 already made for `MetricsFailureReason`).
      this.logger.warn(
        `Degrau de rede indisponivel: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return {
        countFor: () => null,
        state: {
          name: 'plan_users',
          ok: false,
          asOf: null,
          failure: 'query_failed',
        },
      };
    }
  }

  /** Both tutorial steps per bucket, from `tutorial_daily`. */
  private async tutorialByBucket(
    granularity: FunnelGranularity,
    fromDay: string,
    toDay: string,
    platform: PlatformFilter,
  ): Promise<TutorialBucketedCounts> {
    const enteredByBucket = new Map<string, number>();
    const completedByBucket = new Map<string, number>();

    let lastSync;
    try {
      lastSync = await this.tutorial.lastSuccessfulSync();
    } catch (error) {
      this.logger.warn(
        `Procedencia do tutorial ilegivel: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return {
        enteredByBucket,
        completedByBucket,
        missing: null,
        state: {
          name: 'tutorial_daily',
          ok: false,
          asOf: null,
          failure: 'query_failed',
        },
      };
    }

    if (lastSync === null) {
      // Never synced. The table is empty, and reading that as "nobody entered
      // the tutorial" is the disaster the seventh check looks for.
      return {
        enteredByBucket,
        completedByBucket,
        missing: null,
        state: {
          name: 'tutorial_daily',
          ok: false,
          asOf: null,
          failure: 'never_synced',
        },
      };
    }

    try {
      const rows = await this.tutorial.series(
        fromDay,
        toDay,
        platform === 'all' ? undefined : platform,
      );

      for (const row of rows) {
        const key =
          granularity === FunnelGranularity.Monthly
            ? toMonth(row.day)
            : row.day;
        enteredByBucket.set(key, (enteredByBucket.get(key) ?? 0) + row.entered);
        completedByBucket.set(
          key,
          (completedByBucket.get(key) ?? 0) + row.completed,
        );
      }

      return {
        enteredByBucket,
        completedByBucket,
        missing: 0,
        state: {
          name: 'tutorial_daily',
          ok: true,
          // The ETL's own currency, not the moment of this request: the series
          // is only as fresh as the last successful rebuild, and saying "now"
          // would claim a freshness the data does not have.
          asOf: lastSync.ranAt.toISOString(),
        },
      };
    } catch (error) {
      this.logger.warn(
        `Degraus de tutorial indisponiveis: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return {
        enteredByBucket,
        completedByBucket,
        missing: null,
        state: {
          name: 'tutorial_daily',
          ok: false,
          asOf: null,
          failure: 'query_failed',
        },
      };
    }
  }

  /**
   * Every bucket key in the range, including the empty ones.
   *
   * Generated from the range rather than derived from the rows, so a period with
   * no data still produces buckets that say so. Deriving them from what came
   * back would make a collection gap invisible — the day would simply not be in
   * the chart, and a missing day reads as a day that did not happen.
   */
  private bucketKeys(
    granularity: FunnelGranularity,
    fromDay: string,
    toDay: string,
  ): string[] {
    const keys: string[] = [];
    const seen = new Set<string>();
    let cursor = Date.parse(atMidday(fromDay));
    const end = Date.parse(atMidday(toDay));
    // The window is already clamped to MAX_WINDOW_DAYS, so this bounds the loop
    // rather than the answer. `+ 1` because both ends are inclusive.
    let remaining = MAX_WINDOW_DAYS + 1;

    // Midday anchors so a DST transition, if Brazil ever restores one, cannot
    // skip or duplicate a day by moving the cursor across a boundary.
    while (cursor <= end && remaining-- > 0) {
      const day = toSaoPauloDay(cursor);
      if (day !== null) {
        const key =
          granularity === FunnelGranularity.Monthly ? toMonth(day) : day;
        if (!seen.has(key)) {
          seen.add(key);
          keys.push(key);
        }
      }
      cursor += MS_PER_DAY;
    }

    return keys;
  }
}

interface NetworkCounts {
  /**
   * The count for one bucket, or null when the source cannot speak for it.
   *
   * A function rather than a map plus a fallback, because "what does an empty
   * bucket mean" is **per bucket**, not per read: the same successful query
   * knows this week and knows nothing about March.
   */
  countFor(bucketKey: string): number | null;
  state: FunnelSourceState;
}

/**
 * First **whole** day the source can speak for, given the instant it starts.
 *
 * ## Why `MIN(registered)` is a truncation point, not a first event
 *
 * The two readings lead to opposite code, and mixing them is how this shipped
 * broken twice. `PlanDatabase.earliestArrivalAt` settles it: the proxy's records
 * *did not come across* in the 2026-08-20 unification, so the oldest row is
 * where the old database was cut off — **not** the moment the first player ever
 * arrived. Everything before it existed and is missing.
 *
 * So if the cut lands at 15:00, that day is nine hours of a twenty-four hour
 * bucket, and counting it whole is a partial denominator against a whole-day
 * numerator. That is the same defect as the monthly one below — it produced the
 * identical **4500%** reading, one grain down — and it survived the first fix
 * because the fix was applied only to months.
 */
function firstFullyCoveredDay(earliest: number): string | null {
  const day = toSaoPauloDay(earliest);
  if (day === null) {
    return null;
  }
  // Midnight São Paulo of that day. If the cut is later, the day is partial.
  return earliest <= Date.parse(startOfDay(day))
    ? day
    : toSaoPauloDay(earliest + MS_PER_DAY);
}

/**
 * First month the source can speak for **in full**, given the first whole day.
 *
 * A monthly total cannot be assembled from partial coverage, so a month whose
 * first day the source does not have is **not covered**: the answer is `null`
 * with a reason, not a smaller number that looks like a collapse.
 *
 * Comparing month keys directly (`'2026-08' >= toMonth('2026-08-20')`) treated a
 * month as covered when the source only knew twelve of its thirty-one days, and
 * rendered conversions like **4500%** on the *only* bucket with a number in
 * `/funnel/monthly`'s default window.
 */
function firstFullyCoveredMonth(coversFrom: string): string {
  if (coversFrom.endsWith('-01')) {
    return toMonth(coversFrom);
  }
  const [year, month] = toMonth(coversFrom).split('-').map(Number);
  return month === 12
    ? `${year + 1}-01`
    : `${year}-${String(month + 1).padStart(2, '0')}`;
}

/** Offsets are fixed at -03:00 — see the note on `atMidday`. */
function startOfDay(day: string): string {
  return `${day}T00:00:00-03:00`;
}

function endOfDay(day: string): string {
  return `${day}T23:59:59.999-03:00`;
}

/**
 * Midday anchor for day arithmetic.
 *
 * ⚠️ These three helpers hardcode `-03:00` rather than resolving the zone.
 * Correct today — Brazil has had no DST since 2019 — and it is the same dormant
 * edge recorded in `tutorial-entry-rate.check.ts`: if DST returns, the midday
 * anchor survives a transition but these boundaries drift by an hour and shift
 * arrivals across days at the window's edges. The fix then is `Intl` on both
 * ends, the way `toSaoPauloDay` already does.
 */
function atMidday(day: string): string {
  return `${day}T12:00:00-03:00`;
}

interface TutorialBucketedCounts {
  enteredByBucket: Map<string, number>;
  completedByBucket: Map<string, number>;
  missing: number | null;
  state: FunnelSourceState;
}

/** Re-exported so the controller can validate a query value against it. */
export const PLATFORM_FILTERS: readonly PlatformFilter[] = [
  'all',
  Platform.Bedrock,
  Platform.JavaOffline,
  Platform.JavaPremium,
  Platform.Unknown,
];
