import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../db/database.module';
import {
  tutorialDaily,
  tutorialPlayerPosition,
  tutorialSyncs,
} from '../db/schema';
import type { TutorialPosition } from './tutorial-position';
import type { TutorialDayRow } from './tutorial-aggregate';

/**
 * One `(day, platform)` row as it comes **back** from the database.
 *
 * Deliberately not {@link TutorialDayRow}: `platform` there is the `Platform`
 * union, and what Postgres hands back is whatever `text` happens to hold. The
 * two coincide today because this table has a single writer, but asserting the
 * union on a read would be a cast dressed as a type — and a value written by an
 * older version of this code, or by hand, would flow through typed as something
 * it is not.
 *
 * Callers that need the union narrow it themselves, and decide what to do with a
 * value outside it.
 */
export interface StoredTutorialDay {
  day: string;
  platform: string;
  entered: number;
  completed: number;
}

/** Provenance of one ETL run, as read back. */
export interface TutorialSyncRecord {
  id: number;
  ranAt: Date;
  status: 'ok' | 'error';
  filesScanned: number | null;
  filesFailed: number | null;
  playersInTutorial: number | null;
  daysWritten: number | null;
  questsInCatalogue: number | null;
  finalQuestId: string | null;
  /** Resolved step order, comma-separated. Null on runs before story S9.3. */
  stepOrder: string | null;
  /**
   * Rows written to `tutorial_player_position`.
   *
   * **Null means the switch was off**, which is not the same as zero. The
   * economy read consults exactly this: a null says the table cannot be read as
   * a measurement, while a zero would say the scan genuinely found nobody.
   */
  positionsWritten: number | null;
  detail: string | null;
}

/** What a failed run records. */
export interface FailedSync {
  detail: string;
  filesScanned?: number;
  filesFailed?: number;
  playersInTutorial?: number;
  daysWritten?: number;
  questsInCatalogue?: number;
  finalQuestId?: string;
}

/** One player's stored tutorial position, as read back. */
export interface StoredPosition {
  playerUuid: string;
  platform: string;
  questsTouched: number;
  questsCompleted: number;
  furthestQuestId: string | null;
  furthestIndex: number | null;
  completedTutorial: boolean;
}

/** What a successful run records, alongside the rows. */
export interface SuccessfulSync {
  filesScanned: number;
  filesFailed: number;
  playersInTutorial: number;
  daysWritten: number;
  questsInCatalogue: number;
  finalQuestId: string;
  /**
   * The resolved step order, comma-separated.
   *
   * Recorded because `furthest_index` is a position in it and that order is
   * inferred from quest file names, not read from the quests themselves.
   */
  stepOrder?: string;
  /** Rows written to the position table, or null when the switch is off. */
  positionsWritten?: number | null;
}

/**
 * Persistence for the tutorial funnel (story S8.0).
 *
 * ## The whole series is replaced inside one transaction
 *
 * `Quests/playerdata` is **current state, not an event log**, so a sync
 * recomputes every day from scratch. Replacing rather than upserting is what
 * makes that correct: a day whose only entrant had their playerdata deleted must
 * lose the count, and an upsert would leave the stale number behind forever.
 *
 * Delete and insert share a transaction so a reader never sees the table empty.
 * Without it, any read landing between the two statements would see zero
 * entrants across the whole history — a catastrophic-looking number produced by
 * a routine nightly job.
 */
@Injectable()
export class TutorialStore {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  /**
   * Replace the whole series and record the run, atomically.
   *
   * The sync row is written in the same transaction as the rows it describes, so
   * "the data is from this run" is a fact rather than an assumption. A crash
   * between them would otherwise leave a success record pointing at the previous
   * run's numbers.
   */
  async replaceAll(
    rows: readonly TutorialDayRow[],
    sync: SuccessfulSync,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(tutorialDaily);

      if (rows.length > 0) {
        // Chunked because Postgres caps a statement at 65535 bound parameters
        // and each row binds four. At ~16k rows per statement the cap is
        // unreachable, and the whole series is a handful of statements.
        const CHUNK = 5_000;
        for (let i = 0; i < rows.length; i += CHUNK) {
          await tx.insert(tutorialDaily).values(rows.slice(i, i + CHUNK));
        }
      }

      await tx.insert(tutorialSyncs).values({ status: 'ok', ...sync });
    });
  }

  /**
   * Record a run that produced nothing.
   *
   * **The existing series is left untouched on purpose.** A failed sync means we
   * could not measure, not that the numbers became zero — wiping the table would
   * turn a missing directory into "nobody ever entered the tutorial", which is
   * indistinguishable from the disaster the seventh check looks for. Readers see
   * the old rows and, from this record, that the last attempt failed and when.
   */
  async recordFailure(failure: FailedSync): Promise<void> {
    await this.db.insert(tutorialSyncs).values({
      status: 'error',
      detail: failure.detail,
      filesScanned: failure.filesScanned ?? null,
      filesFailed: failure.filesFailed ?? null,
      playersInTutorial: failure.playersInTutorial ?? null,
      daysWritten: failure.daysWritten ?? null,
      questsInCatalogue: failure.questsInCatalogue ?? null,
      finalQuestId: failure.finalQuestId ?? null,
    });
  }

  /** The most recent run of any status, or null when none ever ran. */
  async lastSync(): Promise<TutorialSyncRecord | null> {
    const [row] = await this.db
      .select()
      .from(tutorialSyncs)
      .orderBy(desc(tutorialSyncs.ranAt), desc(tutorialSyncs.id))
      .limit(1);

    return row ?? null;
  }

  /**
   * The most recent **successful** run, or null when none ever succeeded.
   *
   * Distinct from {@link lastSync} because it answers a different question: this
   * one dates the data currently in the table, while `lastSync` dates the last
   * attempt. When they differ, the series is stale and a reader must say so
   * rather than present it as current.
   */
  async lastSuccessfulSync(): Promise<TutorialSyncRecord | null> {
    const [row] = await this.db
      .select()
      .from(tutorialSyncs)
      .where(eq(tutorialSyncs.status, 'ok'))
      .orderBy(desc(tutorialSyncs.ranAt), desc(tutorialSyncs.id))
      .limit(1);

    return row ?? null;
  }

  /**
   * Rows in a closed day range, optionally for one platform.
   *
   * Returns only the days that have rows. Filling the gaps is the caller's job,
   * and it must decide per gap whether it is a zero or a hole — which requires
   * {@link lastSuccessfulSync}, not this method.
   */
  async series(
    fromDay: string,
    toDay: string,
    platform?: string,
  ): Promise<StoredTutorialDay[]> {
    return this.db
      .select()
      .from(tutorialDaily)
      .where(
        and(
          gte(tutorialDaily.day, fromDay),
          lte(tutorialDaily.day, toDay),
          platform === undefined
            ? undefined
            : eq(tutorialDaily.platform, platform),
        ),
      )
      .orderBy(tutorialDaily.day, tutorialDaily.platform);
  }

  /**
   * Entrants in a **closed** day range, both ends inclusive.
   *
   * Serves the seventh check, whose numerator is a windowed count rather than a
   * series. Summed in Postgres instead of in the process: the check runs on a
   * schedule of minutes and has no use for the individual days.
   *
   * ## Why both ends, and not an open `>= fromDay`
   *
   * The open version silently counted **eight** calendar days for a seven-day
   * window — `fromDay` inclusive through today, with no upper bound — against a
   * denominator that really was seven. A systematic +14% on the numerator, in
   * the direction that **hides** a breach: a true 62% published as ~71% and
   * reported `ok`.
   *
   * A ratio whose two sides are counted over different spans is the composition
   * that produced three of the five errors catalogued in `HANDOFF.md`. The range
   * is closed so the caller has to name both ends and cannot drift.
   */
  async enteredBetween(fromDay: string, toDay: string): Promise<number> {
    const [row] = await this.db
      .select({
        total: sql<string>`coalesce(sum(${tutorialDaily.entered}), 0)`,
      })
      .from(tutorialDaily)
      .where(
        and(gte(tutorialDaily.day, fromDay), lte(tutorialDaily.day, toDay)),
      );

    // `sum()` comes back as a string from pg for bigint results; Number() on a
    // missing row would be NaN, so the coalesce above is load-bearing.
    return Number(row?.total ?? 0);
  }

  /**
   * Replace the per-player tutorial positions.
   *
   * ## Replaced, and inside one transaction
   *
   * Replaced because the source is current state, exactly like `tutorial_daily`:
   * a player who reset the tutorial has moved backwards, and an accumulating
   * table would keep claiming they got further than they did.
   *
   * In one transaction because the delete comes first, and a failure between the
   * two halves would leave the table empty — which the economy read would then
   * publish as "nobody entered the tutorial", the shape this whole epic exists
   * to make impossible.
   *
   * @returns rows written.
   */
  async replacePositions(
    positions: readonly TutorialPosition[],
  ): Promise<number> {
    await this.db.transaction(async (tx) => {
      await tx.delete(tutorialPlayerPosition);
      for (let i = 0; i < positions.length; i += POSITION_CHUNK_SIZE) {
        const chunk = positions.slice(i, i + POSITION_CHUNK_SIZE);
        if (chunk.length === 0) {
          continue;
        }
        await tx.insert(tutorialPlayerPosition).values(
          chunk.map((position) => ({
            playerUuid: position.uuid,
            platform: position.platform,
            questsTouched: position.questsTouched,
            questsCompleted: position.questsCompleted,
            furthestQuestId: position.furthestQuestId,
            furthestIndex: position.furthestIndex,
            completedTutorial: position.completedTutorial,
            enteredOn: position.enteredOn,
            syncedAt: new Date(),
          })),
        );
      }
    });

    return positions.length;
  }

  /** How many players currently have a stored position. */
  async positionCount(): Promise<number> {
    const result = await this.db.execute<{ total: number }>(
      sql`SELECT count(*)::int AS total FROM ${tutorialPlayerPosition}`,
    );
    return result.rows[0]?.total ?? 0;
  }
}

/**
 * Rows per insert statement.
 *
 * ~11.000 players in the 2026-08-19 baseline, and a single statement with that
 * many parameter groups would hit the driver's bind-parameter ceiling long
 * before anything else — surfacing as an opaque protocol error rather than as
 * "too big".
 */
const POSITION_CHUNK_SIZE = 500;
