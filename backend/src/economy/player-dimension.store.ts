import { Inject, Injectable } from '@nestjs/common';
import { desc, eq, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../db/database.module';
import { playerDimension, playerDimensionSyncs } from '../db/schema';

/** One player as the ETL writes it. */
export interface DimensionRow {
  uuid: string;
  platform: string;
  registeredAt: Date;
  lastSeenAt: Date;
}

/** Provenance of one run, as read back. */
export interface DimensionSyncRecord {
  id: number;
  ranAt: Date;
  status: 'ok' | 'error';
  rowsRead: number | null;
  rowsWritten: number | null;
  rowsDropped: number | null;
  durationMs: number | null;
  detail: string | null;
}

/** What a successful run records. */
export interface SuccessfulDimensionSync {
  rowsRead: number;
  rowsWritten: number;
  rowsDropped: number;
  durationMs: number;
}

/** What a failed run records. */
export interface FailedDimensionSync {
  detail: string;
  rowsRead?: number;
  rowsWritten?: number;
  rowsDropped?: number;
  durationMs?: number;
}

/**
 * Rows written per statement.
 *
 * The dimension is ~5.500 rows today, so this is not about scale: a single
 * statement with 5.500 parameter groups would exceed the driver's bind-parameter
 * ceiling long before it exceeded anything else, and the failure would arrive as
 * an opaque protocol error. Chunking keeps the failure mode boring.
 */
const CHUNK_SIZE = 500;

/**
 * Persistence of the player dimension (story S9.1, ADR-008).
 *
 * ## Upsert, and never delete
 *
 * A player missing from one payload has not stopped existing, and deleting on
 * absence would let a single degraded response erase the cohort denominators.
 * `synced_at` is how a stale row is recognised instead.
 */
@Injectable()
export class PlayerDimensionStore {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  /**
   * Upsert every row, in chunks. Returns how many were written.
   *
   * Idempotent by construction: the same payload applied twice produces the same
   * table, which is criterion 2 of the story ("idempotente e re-executável").
   */
  async upsert(rows: readonly DimensionRow[]): Promise<number> {
    let written = 0;

    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      const chunk = rows.slice(i, i + CHUNK_SIZE);
      await this.db
        .insert(playerDimension)
        .values(
          chunk.map((row) => ({
            uuid: row.uuid,
            platform: row.platform,
            registeredAt: row.registeredAt,
            lastSeenAt: row.lastSeenAt,
            syncedAt: new Date(),
          })),
        )
        .onConflictDoUpdate({
          target: playerDimension.uuid,
          set: {
            platform: sql`excluded.platform`,
            registeredAt: sql`excluded.registered_at`,
            lastSeenAt: sql`excluded.last_seen_at`,
            syncedAt: sql`excluded.synced_at`,
          },
        });
      written += chunk.length;
    }

    return written;
  }

  /** Rows currently in the dimension. */
  async count(): Promise<number> {
    const result = await this.db.execute<{ total: number }>(
      sql`SELECT count(*)::int AS total FROM ${playerDimension}`,
    );
    return result.rows[0]?.total ?? 0;
  }

  async recordSuccess(run: SuccessfulDimensionSync): Promise<void> {
    await this.db.insert(playerDimensionSyncs).values({
      status: 'ok',
      rowsRead: run.rowsRead,
      rowsWritten: run.rowsWritten,
      rowsDropped: run.rowsDropped,
      durationMs: run.durationMs,
    });
  }

  async recordFailure(run: FailedDimensionSync): Promise<void> {
    await this.db.insert(playerDimensionSyncs).values({
      status: 'error',
      rowsRead: run.rowsRead ?? null,
      rowsWritten: run.rowsWritten ?? null,
      rowsDropped: run.rowsDropped ?? null,
      durationMs: run.durationMs ?? null,
      detail: run.detail,
    });
  }

  /**
   * The most recent **successful** run, or null when none exists.
   *
   * Read by every economy report before it publishes a cohort breakdown: an
   * empty dimension and a dimension nobody ever filled produce the same query
   * result, and treating the second as the first is how a collection gap becomes
   * a reported zero.
   */
  async lastSuccessfulSync(): Promise<DimensionSyncRecord | null> {
    const [row] = await this.db
      .select()
      .from(playerDimensionSyncs)
      .where(eq(playerDimensionSyncs.status, 'ok'))
      .orderBy(desc(playerDimensionSyncs.ranAt), desc(playerDimensionSyncs.id))
      .limit(1);

    return row === undefined ? null : row;
  }

  /** The most recent run of any status. */
  async lastSync(): Promise<DimensionSyncRecord | null> {
    const [row] = await this.db
      .select()
      .from(playerDimensionSyncs)
      .orderBy(desc(playerDimensionSyncs.ranAt), desc(playerDimensionSyncs.id))
      .limit(1);

    return row === undefined ? null : row;
  }
}
