import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import * as schema from '../src/db/schema';
import { sanitizeSuggestionText } from '../src/suggestions/suggestion-text';
import {
  bodyBeforeCommit,
  migrationChainFrom,
  migrationFile,
  rollbackChainDownTo,
  rollbackFile,
} from './rollback-utils';
import { SuggestionsStore } from '../src/suggestions/suggestions.store';
import {
  SUGGESTION_STATUSES,
  SUGGESTION_TEXT_MAX_CHARS,
  suggestions,
} from '../src/db/schema';

const MIGRATION_FILE = migrationFile('0009');
const ROLLBACK_FILE = rollbackFile('0009');

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
      'assignee_nickname',
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
      // Regression: the first version of this constraint was `btrim(text)`,
      // which trims **spaces only**, so a value of a space and a newline
      // sailed straight through it. Only this assertion against a real
      // Postgres caught that — the unit tests exercise the sanitizer, which
      // was never the thing that was wrong.
      await expect(insertRaw({ text: '   \n ' })).rejects.toThrow(
        /suggestions_text_present/,
      );
      await expect(insertRaw({ text: '\t\r\n' })).rejects.toThrow(
        /suggestions_text_present/,
      );
    });

    it('rejects exactly the characters String.trim() strips', async () => {
      // The CHECK enumerates a whitespace set in SQL, and enumerating is only
      // defensible if the list is verified against the set JS actually strips.
      // Otherwise the two rules agree by luck and drift apart in silence.
      const trimmed = [...Array(0x11000).keys()]
        .map((cp) => String.fromCodePoint(cp))
        .filter((ch) => ch.trim() === '');

      for (const [i, ch] of trimmed.entries()) {
        await expect(
          insertRaw({ discord_msg_id: `ws-${i}`, text: ch.repeat(3) }),
        ).rejects.toThrow(/suggestions_text_present/);
        expect(() => sanitizeSuggestionText(ch.repeat(3))).toThrow();
      }
    });

    it('accepts a format-character-only string, which the sanitizer owns and the CHECK does not', async () => {
      // U+200B is invisible but it is not whitespace, so `btrim` leaves it and
      // the CHECK sees a non-empty string. Asserted rather than left implicit,
      // because it is the one place the two layers do not overlap.
      //
      // The split is on purpose. The CHECK answers 'is this blank', which SQL
      // can express exactly; the sanitizer answers 'does this carry invisible
      // payload', which needs the Unicode `Cf` category and has no POSIX-regex
      // equivalent. Approximating the second one in SQL would produce a second
      // rule that disagrees with the first in ways nobody tracks - so the
      // sanitizer stays the single owner of that question, and every write path
      // has to go through it.
      expect(() => sanitizeSuggestionText('\u200B\u200B')).toThrow();
      await insertRaw({ discord_msg_id: 'zwsp', text: '\u200B\u200B' });
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

  describe('SuggestionsStore against a real database', () => {
    // The unit spec proves the store's decisions against a chainable stub, which
    // by construction accepts any method and returns whatever the test wrote.
    // Two of its claims are properties of Postgres and not of the code -
    // `onConflictDoNothing` matching the unique index, and the first write's
    // text surviving a replay - so they are asserted here or not at all.
    let store: SuggestionsStore;

    beforeEach(() => {
      store = new SuggestionsStore(db);
    });

    it('writes a suggestion the sanitizer accepted', async () => {
      const row = await store.create({
        discordMsgId: 'store-1',
        author: '111111111111111111',
        text: '  ideia   com espaco  ',
        createdAt: POSTED_AT,
      });

      expect(row.text).toBe('ideia   com espaco');
      expect(row.createdAt).toEqual(POSTED_AT);
      expect(row.status).toBe('enviada');
    });

    it('matches the unique index on conflict instead of raising', async () => {
      // `onConflictDoNothing({ target })` needs a unique index Postgres can
      // match. If that index ever gains a `WHERE`, changes expression or is
      // renamed, this is where it surfaces - the stubbed unit test would stay
      // green while every bot replay crashed in production.
      const first = await store.create({
        discordMsgId: 'store-2',
        author: '111111111111111111',
        text: 'ideia original',
        createdAt: POSTED_AT,
      });

      const replay = await store.create({
        discordMsgId: 'store-2',
        author: '222222222222222222',
        text: 'texto reescrito depois',
        createdAt: new Date('2026-09-01T12:00:00.000Z'),
      });

      expect(replay.id).toBe(first.id);
      // What the players who voted actually read, preserved by the database.
      expect(replay.text).toBe('ideia original');
      expect(replay.author).toBe('111111111111111111');
      expect(replay.createdAt).toEqual(POSTED_AT);

      const { rows } = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM suggestions
         WHERE discord_msg_id = 'store-2'`,
      );
      expect(rows[0].count).toBe('1');
    });

    it('rejects unstorable text before reaching the database', async () => {
      await expect(
        store.create({
          discordMsgId: 'store-3',
          author: '111111111111111111',
          text: ' ​',
          createdAt: POSTED_AT,
        }),
      ).rejects.toThrow(/empty after sanitization/);

      const { rows } = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM suggestions
         WHERE discord_msg_id = 'store-3'`,
      );
      expect(rows[0].count).toBe('0');
    });

    it('moves updated_at on a Drizzle update, and leaves created_at alone', async () => {
      const created = await store.create({
        discordMsgId: 'store-4',
        author: '111111111111111111',
        text: 'ideia',
        createdAt: POSTED_AT,
      });

      const [updated] = await db
        .update(suggestions)
        .set({ status: 'aprovada' })
        .where(eq(suggestions.id, created.id))
        .returning();

      expect(updated.status).toBe('aprovada');
      expect(updated.createdAt).toEqual(POSTED_AT);
      expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(
        created.updatedAt.getTime(),
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
      const client = await pool.connect();

      try {
        // Chained down from the head, one script at a time, because that is the
        // only order the guards allow. When 0010 landed, this test failed with
        // "0009 is not the head" — the guard catching its own author, which is
        // exactly the production accident it was written to prevent.
        for (const down of rollbackChainDownTo('0009')) {
          await client.query(down);
        }

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

        // Forward again, on top of the rollback: the migrations have to be
        // re-appliable, which is what makes a rollback safe to use rather than
        // merely destructive.
        for (const up of migrationChainFrom('0009')) {
          await client.query(up);
        }
        const recreated = await client.query<{ table_ref: string | null }>(
          `SELECT to_regclass('public.suggestions') AS table_ref`,
        );
        expect(recreated.rows[0].table_ref).not.toBeNull();
      } finally {
        // In the `finally`, not after the assertions: a failed expectation
        // throws, and a connection returned to the pool mid-transaction poisons
        // whatever picks it up next.
        await client.query('ROLLBACK');
        client.release();
      }

      // Untouched outside the transaction.
      const { rows } = await pool.query<{ table_ref: string | null }>(
        `SELECT to_regclass('public.suggestions') AS table_ref`,
      );
      expect(rows[0].table_ref).not.toBeNull();
    });

    it('reverses 0011 too, chained down from the head', async () => {
      // Every `.down.sql` gets exercised, not only the first one written. The
      // S6.2b lesson: a script delivered and never run is the product of the
      // story missing its point.
      const client = await pool.connect();

      try {
        for (const down of rollbackChainDownTo('0011')) {
          await client.query(down);
        }

        const dropped = await client.query<{ column_name: string }[]>(
          `SELECT column_name FROM information_schema.columns
           WHERE table_name = 'suggestions' AND column_name = 'assignee_nickname'`,
        );
        expect(dropped.rows).toHaveLength(0);

        for (const up of migrationChainFrom('0011')) {
          await client.query(up);
        }
        const back = await client.query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_name = 'suggestions' AND column_name = 'assignee_nickname'`,
        );
        expect(back.rows).toHaveLength(1);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });

    it('refuses to roll back 0011 under a newer migration', async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
           VALUES ('pretend-newer-0012', $1)`,
          [Date.now() + 60_000],
        );

        await expect(
          client.query(bodyBeforeCommit(rollbackFile('0011'))),
        ).rejects.toThrow(/not the head/);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });

    it('refuses to run on its own, under a newer migration', async () => {
      // The failure the guard exists for: roll 0009 back under a newer
      // migration and drizzle, which decides by timestamp, would report nothing
      // pending forever while the table is gone.
      const client = await pool.connect();

      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
           VALUES ('pretend-newer', $1)`,
          [Date.now() + 60_000],
        );

        await expect(
          client.query(bodyBeforeCommit(ROLLBACK_FILE)),
        ).rejects.toThrow(/not the head/);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }

      // The real head is still 0009 and the table is still there.
      const { rows } = await pool.query<{ table_ref: string | null }>(
        `SELECT to_regclass('public.suggestions') AS table_ref`,
      );
      expect(rows[0].table_ref).not.toBeNull();
    });
  });
});
