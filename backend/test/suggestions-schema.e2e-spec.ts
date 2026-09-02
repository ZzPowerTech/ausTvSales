import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import * as schema from '../src/db/schema';
import {
  SUGGESTION_STATUSES,
  SUGGESTION_TEXT_MAX_CHARS,
  suggestions,
} from '../src/db/schema';

const MIGRATION_FILE = join(__dirname, '..', 'drizzle', '0009_suggestions.sql');
const ROLLBACK_FILE = join(
  __dirname,
  '..',
  'drizzle',
  'rollback',
  '0009_suggestions.down.sql',
);

/**
 * Integration test for the `suggestions` schema (story S10.1) against a real
 * PostgreSQL — docker-compose locally, `services.postgres` in CI.
 *
 * The checks that matter here cannot be written as unit tests: `created_at`
 * having no default, the constraints rejecting bad rows, and the rollback script
 * actually reversing the migration are all properties of the database, and a
 * mocked driver would just replay whatever the test asserted.
 */
describe('Suggestions schema (e2e)', () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  const POSTED_AT = new Date('2026-08-14T19:05:00.000Z');

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    db = drizzle(pool, { schema });

    // Migrations run from zero and are idempotent: running twice must not fail.
    await migrate(db, { migrationsFolder: './drizzle' });
    await migrate(db, { migrationsFolder: './drizzle' });
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE suggestions RESTART IDENTITY CASCADE');
  });

  afterAll(async () => {
    await pool.end();
  });

  it('creates the suggestions table with the spec §7 columns', async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'suggestions'`,
    );

    expect(rows.map((r) => r.column_name).sort()).toEqual([
      'assignee',
      'author',
      'created_at',
      'discord_msg_id',
      'id',
      'status',
      'text',
      'updated_at',
      'votes_down',
      'votes_up',
    ]);
  });

  describe('created_at is the event date, not the insert date', () => {
    it('has no database default, so a forgotten date fails instead of lying', async () => {
      // This is the whole point of the column. `Ticket-Bot`'s `message.ts:13`
      // defaults to `Date.now`, which turns a forgotten date into a plausible
      // wrong one that nothing can detect afterwards.
      const { rows } = await pool.query<{
        column_default: string | null;
        is_nullable: string;
      }>(
        `SELECT column_default, is_nullable FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'suggestions'
           AND column_name = 'created_at'`,
      );

      expect(rows[0].column_default).toBeNull();
      expect(rows[0].is_nullable).toBe('NO');
    });

    it('rejects an insert that omits it', async () => {
      await expect(
        pool.query(
          `INSERT INTO suggestions (discord_msg_id, author, text)
           VALUES ('1', '111111111111111111', 'sem data')`,
        ),
      ).rejects.toThrow(/created_at/);
    });

    it('stores the date it was given, back-dated well before the insert', async () => {
      const [row] = await db
        .insert(suggestions)
        .values({
          discordMsgId: '1',
          author: '111111111111111111',
          text: 'ideia antiga',
          createdAt: POSTED_AT,
        })
        .returning();

      expect(row.createdAt).toEqual(POSTED_AT);
      // `updated_at` is the opposite case and *does* default to the write time.
      expect(row.updatedAt.getTime()).toBeGreaterThan(POSTED_AT.getTime());
    });
  });

  describe('defaults', () => {
    it('starts a new suggestion at enviada with no votes and no assignee', async () => {
      const [row] = await db
        .insert(suggestions)
        .values({
          discordMsgId: '1',
          author: '111111111111111111',
          text: 'ideia',
          createdAt: POSTED_AT,
        })
        .returning();

      expect(row.status).toBe('enviada');
      expect(row.votesUp).toBe(0);
      expect(row.votesDown).toBe(0);
      expect(row.assignee).toBeNull();
    });
  });

  describe('constraints', () => {
    async function insertRaw(
      overrides: Partial<Record<string, unknown>> = {},
    ): Promise<void> {
      const values = {
        discord_msg_id: '1',
        author: '111111111111111111',
        text: 'ideia',
        created_at: POSTED_AT,
        ...overrides,
      };
      const columns = Object.keys(values);
      const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
      await pool.query(
        `INSERT INTO suggestions (${columns.join(', ')}) VALUES (${placeholders})`,
        Object.values(values),
      );
    }

    it('accepts every state in the spec', async () => {
      for (const [i, status] of SUGGESTION_STATUSES.entries()) {
        await insertRaw({ discord_msg_id: `msg-${i}`, status });
      }

      const { rows } = await pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM suggestions',
      );
      expect(rows[0].count).toBe(String(SUGGESTION_STATUSES.length));
    });

    it('rejects a state outside the spec', async () => {
      // Guards against the `Ticket-Bot` shape, where `status` is free text and
      // "Closed" versus "closed" is a bug nobody sees until a filter misses.
      await expect(insertRaw({ status: 'Open' })).rejects.toThrow(
        /suggestions_status_valid/,
      );
    });

    it('rejects a duplicate discord_msg_id', async () => {
      await insertRaw();
      await expect(insertRaw()).rejects.toThrow(
        /suggestions_discord_msg_id_unique/,
      );
    });

    it('rejects text that is empty or only whitespace', async () => {
      await expect(insertRaw({ text: '   \n ' })).rejects.toThrow(
        /suggestions_text_present/,
      );
    });

    it('rejects text over the length cap', async () => {
      await expect(
        insertRaw({ text: 'a'.repeat(SUGGESTION_TEXT_MAX_CHARS + 1) }),
      ).rejects.toThrow(/suggestions_text_max_length/);
    });

    it('accepts text exactly at the cap', async () => {
      await insertRaw({ text: 'a'.repeat(SUGGESTION_TEXT_MAX_CHARS) });
    });

    it('rejects negative vote counts', async () => {
      await expect(insertRaw({ votes_up: -1 })).rejects.toThrow(
        /suggestions_votes_non_negative/,
      );
    });
  });

  describe('rollback', () => {
    it('pins the hash the migrator actually recorded', async () => {
      // The rollback deletes its bookkeeping row by hash. If the migration file
      // is ever edited, that pinned hash stops matching and the DELETE becomes a
      // silent no-op — so the mismatch has to fail here instead.
      const expected = createHash('sha256')
        .update(readFileSync(MIGRATION_FILE).toString())
        .digest('hex');

      expect(readFileSync(ROLLBACK_FILE).toString()).toContain(expected);

      const { rows } = await pool.query<{ hash: string }>(
        'SELECT hash FROM drizzle.__drizzle_migrations WHERE hash = $1',
        [expected],
      );
      expect(rows).toHaveLength(1);
    });

    it('removes the table and its bookkeeping row, and re-applying restores it', async () => {
      const rollbackSql = readFileSync(ROLLBACK_FILE).toString();
      const client = await pool.connect();

      try {
        // Postgres DDL is transactional, so the real statements run and the
        // suite's database survives them.
        await client.query('BEGIN');
        await client.query(rollbackSql);

        const dropped = await client.query<{ table_ref: string | null }>(
          `SELECT to_regclass('public.suggestions') AS table_ref`,
        );
        expect(dropped.rows[0].table_ref).toBeNull();

        const bookkeeping = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations
           WHERE hash = $1`,
          [
            createHash('sha256')
              .update(readFileSync(MIGRATION_FILE).toString())
              .digest('hex'),
          ],
        );
        expect(bookkeeping.rows[0].count).toBe('0');

        // Forward again, on top of the rollback, inside the same transaction:
        // the migration has to be re-appliable, which is what makes the
        // rollback safe to use rather than merely destructive.
        await client.query(readFileSync(MIGRATION_FILE).toString());
        const recreated = await client.query<{ table_ref: string | null }>(
          `SELECT to_regclass('public.suggestions') AS table_ref`,
        );
        expect(recreated.rows[0].table_ref).not.toBeNull();

        await client.query('ROLLBACK');
      } finally {
        client.release();
      }

      // Untouched outside the transaction.
      const { rows } = await pool.query<{ table_ref: string | null }>(
        `SELECT to_regclass('public.suggestions') AS table_ref`,
      );
      expect(rows[0].table_ref).not.toBeNull();
    });
  });
});
