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
 * Ceiling on the span a single request may ask for.
 *
 * 366 buckets, matching the analytics endpoints of story S5.1. Not arbitrary: a
 * caller asking for ten years would stream ten years of `plan_users` rows out of
 * the game machine's MySQL to build a chart nobody can read.
 */
const MAX_BUCKETS = 366;

/** What a read produced, plus how fresh each source was. */
export interface FunnelSeries {
  granularity: FunnelGranularity;
  platform: PlatformFilter;
  from: string;
  to: string;
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
  /** Why `ok` is false. */
  detail?: string;
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
 * What the criterion is actually protecting — *never make the game machine pay
 * for a dashboard refresh, and keep the last good answer when a source fails* —
 * is delivered by the read path itself: the window is capped, and a source that
 * fails degrades to `ok: false` with its reason while the other half still
 * answers. If `plan_users` ever grows by orders of magnitude, this comment is
 * the place that should stop being true, and the ETL is the answer then.
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
    fromDay: string,
    toDay: string,
    platform: PlatformFilter = 'all',
  ): Promise<FunnelSeries> {
    const bucketKeys = this.bucketKeys(granularity, fromDay, toDay);

    const [network, tutorial] = await Promise.all([
      this.networkByBucket(granularity, fromDay, toDay, platform),
      this.tutorialByBucket(granularity, fromDay, toDay, platform),
    ]);

    const buckets = bucketKeys.map((key) =>
      buildBucket(key, {
        network: network.byBucket.get(key) ?? network.missing,
        // No daily source; the reason is attached by `buildBucket`.
        survival: null,
        tutorialEntered: tutorial.enteredByBucket.get(key) ?? tutorial.missing,
        tutorialCompleted:
          tutorial.completedByBucket.get(key) ?? tutorial.missing,
      } satisfies RawCounts),
    );

    return {
      granularity,
      platform,
      from: fromDay,
      to: toDay,
      buckets,
      sources: [network.state, tutorial.state],
    };
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
  ): Promise<BucketedCounts> {
    const byBucket = new Map<string, number>();

    if (!this.planDb.configured) {
      return {
        byBucket,
        missing: null,
        state: {
          name: 'plan_users',
          ok: false,
          asOf: null,
          detail:
            'PLAN_DB_HOST nao configurado — o degrau de rede fica sem fonte',
        },
      };
    }

    try {
      const arrivals = await this.planDb.networkArrivalsBetween(
        Date.parse(`${fromDay}T00:00:00-03:00`),
        Date.parse(`${toDay}T23:59:59.999-03:00`),
      );

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

      return {
        byBucket,
        // The source answered, so an empty bucket is a measured zero.
        missing: 0,
        state: { name: 'plan_users', ok: true, asOf: new Date().toISOString() },
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Degrau de rede indisponivel: ${detail}`);
      return {
        byBucket,
        missing: null,
        state: { name: 'plan_users', ok: false, asOf: null, detail },
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
      const detail = error instanceof Error ? error.message : String(error);
      return {
        enteredByBucket,
        completedByBucket,
        missing: null,
        state: { name: 'tutorial_daily', ok: false, asOf: null, detail },
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
          detail:
            'o ETL do tutorial nunca rodou com sucesso — os degraus de tutorial ' +
            'ficam sem fonte, o que NAO e o mesmo que ninguem ter entrado',
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
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Degraus de tutorial indisponiveis: ${detail}`);
      return {
        enteredByBucket,
        completedByBucket,
        missing: null,
        state: { name: 'tutorial_daily', ok: false, asOf: null, detail },
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
    let cursor = Date.parse(`${fromDay}T12:00:00-03:00`);
    const end = Date.parse(`${toDay}T12:00:00-03:00`);

    // Midday anchors so a DST transition, if Brazil ever restores one, cannot
    // skip or duplicate a day by moving the cursor across a boundary.
    while (cursor <= end && keys.length < MAX_BUCKETS) {
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

interface BucketedCounts {
  byBucket: Map<string, number>;
  /** What an absent bucket means: `0` when the source answered, `null` if not. */
  missing: number | null;
  state: FunnelSourceState;
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
