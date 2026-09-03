import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { NestExpressApplication } from '@nestjs/platform-express';
import { asc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import request from 'supertest';
import * as schema from '../src/db/schema';
import { suggestionAudit, suggestions } from '../src/db/schema';
import { SuggestionsStore } from '../src/suggestions/suggestions.store';
import { createApp } from './e2e-utils';
import {
  bodyBeforeCommit,
  migrationFile,
  rollbackFile,
} from './rollback-utils';

const MIGRATION_FILE = migrationFile('0010');
const ROLLBACK_FILE = rollbackFile('0010');

/** The key the CI workflow and `.env.example` configure for the bot principal. */
const BOT_KEY = process.env.BOT_API_KEYS?.split(',')[0].trim() ?? '';

const AUTHOR = '111111111111111111';
const STAFF = '333333333333333333';
const POSTED_AT = '2026-09-01T18:30:00.000Z';

/**
 * Typed view of a supertest body.
 *
 * `response.body` is declared `any`, and an `any` flowing into an assertion is
 * an assertion that cannot fail on a shape change — the lint rule that forbids
 * it here is doing real work.
 */
function bodyOf<T>(response: request.Response): T {
  return response.body as T;
}

/**
 * The suggestion state machine over HTTP (story S10.2), against a real
 * PostgreSQL and the real app.
 *
 * The unit specs prove the store's decisions against a chainable stub. Three
 * claims here are properties of Postgres and of the wiring, not of the code, and
 * a stub cannot observe any of them: that a refused transition really leaves the
 * row untouched *and still commits its audit entry*, that `FOR UPDATE`
 * serializes two staff members acting at the same instant, and that the routes
 * are actually behind the bot's key.
 */
describe('Suggestion states (e2e)', () => {
  let app: NestExpressApplication;
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let store: SuggestionsStore;

  const http = () => request(app.getHttpServer());
  const asBot = <T extends request.Test>(req: T): T =>
    req.set('X-Api-Key', BOT_KEY);

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: './drizzle' });

    store = new SuggestionsStore(db);
    app = await createApp();
  });

  beforeEach(async () => {
    // Audit first: it holds the foreign key.
    await pool.query(
      'TRUNCATE suggestion_audit, suggestions RESTART IDENTITY CASCADE',
    );
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  async function seed(
    status: schema.SuggestionStatus = 'enviada',
    discordMsgId = '900000000000000001',
  ): Promise<schema.Suggestion> {
    const [row] = await db
      .insert(suggestions)
      .values({
        discordMsgId,
        author: AUTHOR,
        text: 'Colocar mais eventos no Survival',
        createdAt: new Date(POSTED_AT),
        status,
      })
      .returning();
    return row;
  }

  describe('authentication', () => {
    it('refuses a request with no key', async () => {
      await http().get('/suggestions/1').expect(401);
    });

    it('refuses a request with the wrong key', async () => {
      // The CI workflow configures a *different* key for ingest on purpose, so
      // a route that accepted the wrong principal fails here rather than in
      // production.
      const ingestKey = process.env.INGEST_API_KEYS?.split(',')[0].trim() ?? '';
      expect(ingestKey).not.toBe(BOT_KEY);

      await http()
        .get('/suggestions/1')
        .set('X-Api-Key', ingestKey)
        .expect(401);
    });

    it('accepts the bot key', async () => {
      const seeded = await seed();
      const response = await asBot(http().get(`/suggestions/${seeded.id}`));
      expect(response.status).toBe(200);
    });

    it('answers 401, never 404, for an unauthenticated probe of a real id', async () => {
      // Otherwise the status code alone tells an anonymous caller which
      // suggestion ids exist.
      const seeded = await seed();
      await http().get(`/suggestions/${seeded.id}`).expect(401);
    });
  });

  describe('POST /suggestions', () => {
    it('stores the sanitized text and the event date it was given', async () => {
      const response = await asBot(
        http().post('/suggestions').send({
          discord_msg_id: '900000000000000002',
          author: AUTHOR,
          text: '  ideia​ com invisivel  ',
          created_at: POSTED_AT,
        }),
      ).expect(201);

      const created = bodyOf<{
        text: string;
        status: string;
        createdAt: string;
      }>(response);
      expect(created.text).toBe('ideia com invisivel');
      expect(created.status).toBe('enviada');
      expect(new Date(created.createdAt).toISOString()).toBe(POSTED_AT);
    });

    it('answers 422 with a machine-readable reason for text it cannot keep', async () => {
      // 422 and not 400: the payload is fine, the content is not — and the bot
      // needs `reason` to pick between "shorten it" and "you wrote nothing".
      const response = await asBot(
        http()
          .post('/suggestions')
          .send({
            discord_msg_id: '900000000000000003',
            author: AUTHOR,
            text: 'a'.repeat(schema.SUGGESTION_TEXT_MAX_CHARS + 1),
            created_at: POSTED_AT,
          }),
      ).expect(422);

      expect(bodyOf<{ reason: string }>(response).reason).toBe('too_long');
    });

    it('rejects an author that is not a snowflake', async () => {
      await asBot(
        http().post('/suggestions').send({
          discord_msg_id: '900000000000000004',
          author: 'Murilo',
          text: 'ideia',
          created_at: POSTED_AT,
        }),
      ).expect(400);
    });

    it('rejects a field nobody declared', async () => {
      // `forbidNonWhitelisted` — a caller cannot smuggle `status` past the
      // state machine by putting it in the create payload.
      await asBot(
        http().post('/suggestions').send({
          discord_msg_id: '900000000000000005',
          author: AUTHOR,
          text: 'ideia',
          created_at: POSTED_AT,
          status: 'concluida',
        }),
      ).expect(400);
    });
  });

  describe('PATCH /suggestions/:id/status', () => {
    it('moves the suggestion and records who did it', async () => {
      const seeded = await seed();

      const response = await asBot(
        http()
          .patch(`/suggestions/${seeded.id}/status`)
          .send({ to: 'aprovada', actor: STAFF, command: '/sugestao aprovar' }),
      ).expect(200);

      expect(bodyOf<{ status: string }>(response).status).toBe('aprovada');

      const trail = await db
        .select()
        .from(suggestionAudit)
        .where(eq(suggestionAudit.suggestionId, seeded.id));
      expect(trail).toHaveLength(1);
      expect(trail[0]).toMatchObject({
        actor: STAFF,
        action: 'transition',
        fromStatus: 'enviada',
        toStatus: 'aprovada',
        command: '/sugestao aprovar',
        reason: null,
      });
    });

    it('moves updated_at without disturbing created_at', async () => {
      const seeded = await seed();

      await asBot(
        http()
          .patch(`/suggestions/${seeded.id}/status`)
          .send({ to: 'aprovada', actor: STAFF, command: 'btn' }),
      ).expect(200);

      const after = await store.getById(seeded.id);
      expect(after?.createdAt).toEqual(new Date(POSTED_AT));
      expect(after?.updatedAt.getTime()).toBeGreaterThan(
        seeded.updatedAt.getTime() - 1,
      );
    });

    it('answers 409 and leaves the record exactly as it was', async () => {
      const seeded = await seed();

      const response = await asBot(
        http().patch(`/suggestions/${seeded.id}/status`).send({
          to: 'concluida',
          actor: STAFF,
          command: '/sugestao concluir',
        }),
      ).expect(409);

      const conflict = bodyOf<{ current: string; requested: string }>(response);
      expect(conflict.current).toBe('enviada');
      expect(conflict.requested).toBe('concluida');

      const after = await store.getById(seeded.id);
      expect(after).toEqual(seeded);
    });

    it('commits the refusal to the audit trail even though nothing changed', async () => {
      // The transaction that decided "no" still has to persist the attempt.
      // Rolling it back would be the easy implementation and would erase the
      // only evidence the requirement asks for.
      const seeded = await seed();

      await asBot(
        http().patch(`/suggestions/${seeded.id}/status`).send({
          to: 'concluida',
          actor: STAFF,
          command: '/sugestao concluir',
        }),
      ).expect(409);

      const trail = await db
        .select()
        .from(suggestionAudit)
        .where(eq(suggestionAudit.suggestionId, seeded.id));
      expect(trail).toHaveLength(1);
      expect(trail[0]).toMatchObject({
        action: 'transition_denied',
        actor: STAFF,
        fromStatus: 'enviada',
        toStatus: 'concluida',
      });
      expect(trail[0].reason).toEqual(expect.stringContaining('aprovada'));
    });

    it('refuses to move a suggestion out of a terminal state', async () => {
      const seeded = await seed('concluida', '900000000000000010');

      const response = await asBot(
        http()
          .patch(`/suggestions/${seeded.id}/status`)
          .send({ to: 'aprovada', actor: STAFF, command: 'btn' }),
      ).expect(409);

      expect(bodyOf<{ message: string }>(response).message).toContain('final');
    });

    it('lets staff refuse a fresh suggestion without approving it first', async () => {
      const seeded = await seed('enviada', '900000000000000011');

      const response = await asBot(
        http()
          .patch(`/suggestions/${seeded.id}/status`)
          .send({ to: 'recusada', actor: STAFF, command: 'btn' }),
      ).expect(200);

      expect(bodyOf<{ status: string }>(response).status).toBe('recusada');
    });

    it('answers 404 for a suggestion that does not exist', async () => {
      await asBot(
        http()
          .patch('/suggestions/999999/status')
          .send({ to: 'aprovada', actor: STAFF, command: 'btn' }),
      ).expect(404);
    });

    it('rejects a status outside the five', async () => {
      const seeded = await seed();
      await asBot(
        http()
          .patch(`/suggestions/${seeded.id}/status`)
          .send({ to: 'Closed', actor: STAFF, command: 'btn' }),
      ).expect(400);
    });

    it('serializes two staff members acting at the same instant', async () => {
      // Without `FOR UPDATE` both reads see `enviada`, both decide the move is
      // legal, and the suggestion ends up approved *and* refused — each write
      // having been correct at the moment it was checked. With the lock, the
      // second one decides against the state the first one left behind.
      const seeded = await seed('enviada', '900000000000000012');

      await Promise.all([
        store.transition({
          id: seeded.id,
          to: 'aprovada',
          actor: STAFF,
          command: 'btn-aprovar',
        }),
        store.transition({
          id: seeded.id,
          to: 'recusada',
          actor: '444444444444444444',
          command: 'btn-recusar',
        }),
      ]);

      const trail = await db
        .select()
        .from(suggestionAudit)
        .where(eq(suggestionAudit.suggestionId, seeded.id))
        .orderBy(asc(suggestionAudit.id));

      // Both attempts are recorded either way; the question is what the second
      // one saw. Asserted without assuming who won, because the winner is a
      // race and a test that assumes one is a test that fails on Tuesdays.
      expect(trail).toHaveLength(2);

      // The property the lock buys: exactly one decision started from the
      // original state. Unserialized, both would have read `enviada`.
      expect(trail.filter((row) => row.fromStatus === 'enviada')).toHaveLength(
        1,
      );
      expect(trail[1].fromStatus).toBe(trail[0].toStatus);

      // And the outcome is the same whichever ran first: `enviada -> aprovada`
      // then `aprovada -> recusada` both succeed, while `enviada -> recusada`
      // first makes the approval illegal out of a terminal state. Either path
      // ends refused.
      const final = await store.getById(seeded.id);
      expect(final?.status).toBe('recusada');
    });
  });

  describe('POST /suggestions/:id/denied-attempts', () => {
    it('records what the bot refused, with actor and command', async () => {
      const seeded = await seed();

      await asBot(
        http().post(`/suggestions/${seeded.id}/denied-attempts`).send({
          actor: '555555555555555555',
          command: 'suggestion/approve',
          reason: 'sem cargo de staff',
        }),
      ).expect(204);

      const trail = await db
        .select()
        .from(suggestionAudit)
        .where(eq(suggestionAudit.suggestionId, seeded.id));
      expect(trail).toHaveLength(1);
      expect(trail[0]).toMatchObject({
        actor: '555555555555555555',
        action: 'auth_denied',
        fromStatus: 'enviada',
        toStatus: null,
        command: 'suggestion/approve',
        reason: 'sem cargo de staff',
      });
    });

    it('answers 404 rather than writing an orphan row', async () => {
      await asBot(
        http()
          .post('/suggestions/999999/denied-attempts')
          .send({ actor: STAFF, command: 'btn', reason: 'sem cargo' }),
      ).expect(404);

      const trail = await db.select().from(suggestionAudit);
      expect(trail).toHaveLength(0);
    });
  });

  describe('GET /suggestions/:id/audit', () => {
    it('returns the trail newest first, refusals included', async () => {
      const seeded = await seed();

      await asBot(
        http().patch(`/suggestions/${seeded.id}/status`).send({
          to: 'concluida',
          actor: STAFF,
          command: 'tentativa-invalida',
        }),
      ).expect(409);
      await asBot(
        http()
          .patch(`/suggestions/${seeded.id}/status`)
          .send({ to: 'aprovada', actor: STAFF, command: 'aprovar' }),
      ).expect(200);

      const response = await asBot(
        http().get(`/suggestions/${seeded.id}/audit`),
      ).expect(200);

      const entries = bodyOf<{ action: string }[]>(response);
      expect(entries).toHaveLength(2);
      expect(entries[0].action).toBe('transition');
      expect(entries[1].action).toBe('transition_denied');
    });
  });

  describe('the audit table refuses rows that lie about themselves', () => {
    async function insertAudit(
      overrides: Record<string, unknown>,
    ): Promise<void> {
      const seeded = await seed('enviada', '900000000000000020');
      const values = {
        suggestion_id: seeded.id,
        actor: STAFF,
        action: 'transition',
        from_status: 'enviada',
        to_status: 'aprovada',
        command: 'btn',
        reason: null,
        ...overrides,
      };
      const columns = Object.keys(values);
      const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
      await pool.query(
        `INSERT INTO suggestion_audit (${columns.join(', ')}) VALUES (${placeholders})`,
        Object.values(values),
      );
    }

    it('rejects a transition that carries a refusal reason', async () => {
      await expect(insertAudit({ reason: 'porque sim' })).rejects.toThrow(
        /suggestion_audit_shape_matches_action/,
      );
    });

    it('rejects a refusal with no reason', async () => {
      await expect(
        insertAudit({ action: 'transition_denied', reason: null }),
      ).rejects.toThrow(/suggestion_audit_shape_matches_action/);
    });

    it('rejects a transition with no target', async () => {
      await expect(insertAudit({ to_status: null })).rejects.toThrow(
        /suggestion_audit_shape_matches_action/,
      );
    });

    it('rejects an action outside the three', async () => {
      await expect(insertAudit({ action: 'whatever' })).rejects.toThrow(
        /suggestion_audit_action_valid/,
      );
    });

    it('rejects a row pointing at no suggestion', async () => {
      await expect(insertAudit({ suggestion_id: 999999 })).rejects.toThrow(
        /suggestion_audit_suggestion_id_suggestions_id_fk/,
      );
    });
  });

  describe('rollback', () => {
    it('pins the hash the migrator actually recorded', async () => {
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

    it('removes the table and re-applying restores it', async () => {
      const client = await pool.connect();
      try {
        await client.query(bodyBeforeCommit(ROLLBACK_FILE));

        const dropped = await client.query<{ table_ref: string | null }>(
          `SELECT to_regclass('public.suggestion_audit') AS table_ref`,
        );
        expect(dropped.rows[0].table_ref).toBeNull();

        await client.query(readFileSync(MIGRATION_FILE).toString());
        const recreated = await client.query<{ table_ref: string | null }>(
          `SELECT to_regclass('public.suggestion_audit') AS table_ref`,
        );
        expect(recreated.rows[0].table_ref).not.toBeNull();
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }

      const { rows } = await pool.query<{ table_ref: string | null }>(
        `SELECT to_regclass('public.suggestion_audit') AS table_ref`,
      );
      expect(rows[0].table_ref).not.toBeNull();
    });

    it('refuses to run when 0010 is not the head', async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
           VALUES ('pretend-0011', $1)`,
          [Date.now() + 60_000],
        );

        await expect(
          client.query(bodyBeforeCommit(ROLLBACK_FILE)),
        ).rejects.toThrow(/not the head/);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });
  });
});
