import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { players, sales } from '../../src/db/schema';
import type { Dataset } from './dataset';

/**
 * Database writes for the synthetic sales generator (spec S5.0 §1.2).
 *
 * Split out of the CLI so the e2e suite can drive it against the real Postgres
 * in CI — the idempotency claim is only worth anything if `ON CONFLICT` is
 * exercised by an actual unique index, not by a mock.
 *
 * Accepts either `drizzle(pool)` or `drizzle(pool, { schema })`, hence the loose
 * schema generic.
 */
export type SeedDb = NodePgDatabase<any>;

/** Rows per statement: fast enough for 50k, well under the bind-parameter cap. */
export const BATCH_SIZE = 1_000;

export interface WriteSummary {
  playersWritten: number;
  salesInserted: number;
  /** Rows already present — non-zero means this was an idempotent re-run. */
  salesSkipped: number;
}

export function chunk<T>(rows: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    batches.push(rows.slice(i, i + size));
  }
  return batches;
}

export async function insertDataset(
  db: SeedDb,
  dataset: Dataset,
): Promise<WriteSummary> {
  // Players first: `sales.player_uuid` is a foreign key, so the buyer has to
  // exist before their purchase does.
  for (const batch of chunk(dataset.players, BATCH_SIZE)) {
    await db
      .insert(players)
      .values(batch)
      .onConflictDoUpdate({
        target: players.uuid,
        set: {
          lastKnownNickname: sql`excluded.last_known_nickname`,
          updatedAt: sql`now()`,
        },
      });
  }

  let salesInserted = 0;
  for (const batch of chunk(dataset.sales, BATCH_SIZE)) {
    // The same idempotency guard the plugin's SQLite queue replay relies on:
    // re-running a seed is a no-op, not a duplicated dataset.
    const inserted = await db
      .insert(sales)
      .values(batch)
      .onConflictDoNothing({ target: sales.id })
      .returning({ id: sales.id });
    salesInserted += inserted.length;
  }

  return {
    playersWritten: dataset.players.length,
    salesInserted,
    salesSkipped: dataset.sales.length - salesInserted,
  };
}
