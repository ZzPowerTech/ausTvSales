import { NestExpressApplication } from '@nestjs/platform-express';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import request from 'supertest';
import * as schema from '../src/db/schema';
import { suggestionAudit, suggestions } from '../src/db/schema';
import { VOTE_COUNT_MAX } from '../src/suggestions/dto/suggestion-votes.dto';
import { createApp } from './e2e-utils';

/** The key the CI workflow and `.env.example` configure for the bot principal. */
const BOT_KEY = process.env.BOT_API_KEYS?.split(',')[0].trim() ?? '';

const AUTHOR = '111111111111111111';
const MSG = '900000000000000100';
const POSTED_AT = '2026-09-01T18:30:00.000Z';

function bodyOf<T>(response: request.Response): T {
  return response.body as T;
}

/**
 * `PUT /suggestions/by-message/:discordMsgId/votes` (R4), against a real
 * PostgreSQL and the real app.
 *
 * The unit specs prove what the store *asks* the database to do. Five claims
 * here cannot be observed by a stub, and each is the shape of a defect this
 * repository has already shipped once:
 *
 *  - the route is genuinely behind `@BotAuth()` — the composition spec asserts
 *    the decorator exists, this asserts the route wears it;
 *  - a count that exceeds `integer` is refused at the door instead of reaching
 *    the driver, where it becomes a 500;
 *  - an unknown message id is a **404** and writes nothing, which is a property
 *    of the `UPDATE` matching no row;
 *  - the write lands on one card and not on the rest of the channel;
 *  - voting leaves the state, the event date and the audit trail alone (R4.6).
 */
describe('Suggestion votes (e2e)', () => {
  let app: NestExpressApplication;
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  const http = () => request(app.getHttpServer());
  const asBot = <T extends request.Test>(req: T): T =>
    req.set('X-Api-Key', BOT_KEY);

  const votesUrl = (msgId: string) => `/suggestions/by-message/${msgId}/votes`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: './drizzle' });
    app = await createApp();
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE suggestion_audit, suggestions RESTART IDENTITY CASCADE',
    );
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  async function seed(
    discordMsgId = MSG,
    status: schema.SuggestionStatus = 'enviada',
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
      await seed();
      await http()
        .put(votesUrl(MSG))
        .send({ votes_up: 1, votes_down: 0 })
        .expect(401);
    });

    it('refuses the ingest key', async () => {
      await seed();
      const ingestKey = process.env.INGEST_API_KEYS?.split(',')[0].trim() ?? '';
      expect(ingestKey).not.toBe(BOT_KEY);

      await http()
        .put(votesUrl(MSG))
        .set('X-Api-Key', ingestKey)
        .send({ votes_up: 1, votes_down: 0 })
        .expect(401);
    });

    it('refuses a source outside the allowlist, key and all', async () => {
      // 403, not 401: the caller is not allowed here whatever credential it
      // holds. This is what fails if `BotIpAllowlistGuard` is ever dropped.
      await seed();
      await asBot(
        http()
          .put(votesUrl(MSG))
          .set('X-Forwarded-For', '203.0.113.7')
          .send({ votes_up: 1, votes_down: 0 }),
      ).expect(403);
    });

    it('answers 401, never 404, for an unauthenticated probe', async () => {
      // Otherwise the status alone tells an anonymous caller which messages in
      // the channel are suggestion cards.
      await seed();
      await http()
        .put(votesUrl(MSG))
        .send({ votes_up: 1, votes_down: 0 })
        .expect(401);
      await http()
        .put(votesUrl('900000000000000999'))
        .send({ votes_up: 1, votes_down: 0 })
        .expect(401);
    });
  });

  describe('writing the tally', () => {
    it('stores both counts and returns the updated suggestion', async () => {
      const seeded = await seed();

      const response = await asBot(
        http().put(votesUrl(MSG)).send({ votes_up: 7, votes_down: 2 }),
      ).expect(200);

      expect(bodyOf<schema.Suggestion>(response)).toMatchObject({
        id: seeded.id,
        votesUp: 7,
        votesDown: 2,
      });

      const [stored] = await db
        .select()
        .from(suggestions)
        .where(eq(suggestions.id, seeded.id));
      expect(stored.votesUp).toBe(7);
      expect(stored.votesDown).toBe(2);
    });

    it('overwrites rather than accumulating', async () => {
      // D2, and the reason this is a PUT. Two writes of 3 leave 3, not 6 — if
      // it ever reads as an increment, a missed gateway event becomes a
      // permanent and invisible drift.
      await seed();

      await asBot(
        http().put(votesUrl(MSG)).send({ votes_up: 3, votes_down: 0 }),
      ).expect(200);
      const response = await asBot(
        http().put(votesUrl(MSG)).send({ votes_up: 3, votes_down: 0 }),
      ).expect(200);

      expect(bodyOf<schema.Suggestion>(response).votesUp).toBe(3);
    });

    it('goes back down when the last voter removes their reaction', async () => {
      await seed();
      await asBot(
        http().put(votesUrl(MSG)).send({ votes_up: 5, votes_down: 1 }),
      ).expect(200);

      const response = await asBot(
        http().put(votesUrl(MSG)).send({ votes_up: 0, votes_down: 0 }),
      ).expect(200);

      const body = bodyOf<schema.Suggestion>(response);
      expect(body.votesUp).toBe(0);
      expect(body.votesDown).toBe(0);
    });

    it('leaves the state, the author and the event date untouched', async () => {
      const seeded = await seed(MSG, 'aprovada');

      await asBot(
        http().put(votesUrl(MSG)).send({ votes_up: 4, votes_down: 4 }),
      ).expect(200);

      const [stored] = await db
        .select()
        .from(suggestions)
        .where(eq(suggestions.id, seeded.id));
      expect(stored.status).toBe('aprovada');
      expect(stored.author).toBe(AUTHOR);
      expect(stored.createdAt.toISOString()).toBe(POSTED_AT);
      expect(stored.text).toBe(seeded.text);
    });

    it('writes no audit row for a vote', async () => {
      // R4.6. The trail answers "who decided what"; a row per player click
      // would bury the decisions under what the tally already sums up.
      const seeded = await seed();

      await asBot(
        http().put(votesUrl(MSG)).send({ votes_up: 9, votes_down: 1 }),
      ).expect(200);

      const trail = await db
        .select()
        .from(suggestionAudit)
        .where(eq(suggestionAudit.suggestionId, seeded.id));
      expect(trail).toHaveLength(0);
    });

    it('votes on one card only', async () => {
      // The `WHERE` really is on this message. Without it — or with a filter
      // that matched loosely — every card in the channel would take the tally.
      await seed('900000000000000101');
      const second = await seed('900000000000000102');

      await asBot(
        http()
          .put(votesUrl('900000000000000101'))
          .send({ votes_up: 6, votes_down: 0 }),
      ).expect(200);

      const [other] = await db
        .select()
        .from(suggestions)
        .where(eq(suggestions.id, second.id));
      expect(other.votesUp).toBe(0);
    });
  });

  describe('rejections', () => {
    it('answers 404 for a message that is not a suggestion', async () => {
      // The ordinary case: someone reacts to any other message in the channel.
      await seed();
      await asBot(
        http()
          .put(votesUrl('900000000000000777'))
          .send({ votes_up: 1, votes_down: 0 }),
      ).expect(404);
    });

    it('writes nothing on the 404 path', async () => {
      const seeded = await seed();

      await asBot(
        http()
          .put(votesUrl('900000000000000777'))
          .send({ votes_up: 50, votes_down: 50 }),
      ).expect(404);

      const [stored] = await db
        .select()
        .from(suggestions)
        .where(eq(suggestions.id, seeded.id));
      expect(stored.votesUp).toBe(0);
      expect(stored.votesDown).toBe(0);
    });

    it('refuses a negative count', async () => {
      // 400 and not 500: the CHECK would also stop it, but a constraint
      // violation is not an answer anyone can read (R4.5).
      await seed();
      await asBot(
        http().put(votesUrl(MSG)).send({ votes_up: -1, votes_down: 0 }),
      ).expect(400);
      await asBot(
        http().put(votesUrl(MSG)).send({ votes_up: 0, votes_down: -1 }),
      ).expect(400);
    });

    it('refuses a count that would overflow the column, on either side', async () => {
      // `@IsInt()` alone passes this: it is `Number.isInteger`, and
      // `Number.isInteger(1e21)` is `true`. Unbounded, the value reaches
      // Postgres as `integer out of range` — a 500 for a malformed request,
      // the same defect `clampOffset` was written to close.
      //
      // Both fields, because the first version of this file only ever sent the
      // bad value in `votes_up`: deleting `@Max` from `votes_down` alone left
      // the entire suite green with the 500 reachable in production.
      await seed();
      await asBot(
        http()
          .put(votesUrl(MSG))
          .send({ votes_up: VOTE_COUNT_MAX + 1, votes_down: 0 }),
      ).expect(400);
      await asBot(
        http()
          .put(votesUrl(MSG))
          .send({ votes_up: 0, votes_down: VOTE_COUNT_MAX + 1 }),
      ).expect(400);
      await asBot(
        http().put(votesUrl(MSG)).send({ votes_up: 1e21, votes_down: 0 }),
      ).expect(400);
      await asBot(
        http().put(votesUrl(MSG)).send({ votes_up: 0, votes_down: 1e21 }),
      ).expect(400);
    });

    it('accepts the largest count the column can hold', async () => {
      // The other half of the bound. Without this, the test above would pass
      // just as well with the maximum set to zero.
      await seed();
      await asBot(
        http()
          .put(votesUrl(MSG))
          .send({ votes_up: VOTE_COUNT_MAX, votes_down: 0 }),
      ).expect(200);
    });

    it('refuses a fractional count, on either side', async () => {
      await seed();
      await asBot(
        http().put(votesUrl(MSG)).send({ votes_up: 1.5, votes_down: 0 }),
      ).expect(400);
      await asBot(
        http().put(votesUrl(MSG)).send({ votes_up: 0, votes_down: 1.5 }),
      ).expect(400);
    });

    it('refuses a count sent as a string, on either side', async () => {
      await seed();
      await asBot(
        http().put(votesUrl(MSG)).send({ votes_up: '3', votes_down: 0 }),
      ).expect(400);
      await asBot(
        http().put(votesUrl(MSG)).send({ votes_up: 0, votes_down: '3' }),
      ).expect(400);
    });

    it('refuses a body missing a count', async () => {
      // Not "treat the absent one as zero": a partial payload means the bot
      // computed one side and lost the other, and writing a zero it never
      // measured would be inventing a number.
      await seed();
      await asBot(http().put(votesUrl(MSG)).send({ votes_up: 3 })).expect(400);
      await asBot(http().put(votesUrl(MSG)).send({})).expect(400);
    });

    it('refuses a field nobody declared', async () => {
      // `forbidNonWhitelisted`. A `status` smuggled into a vote payload must
      // not be quietly dropped — silently ignoring it is how a caller comes to
      // believe it works.
      await seed();
      await asBot(
        http()
          .put(votesUrl(MSG))
          .send({ votes_up: 1, votes_down: 0, status: 'aprovada' }),
      ).expect(400);
    });

    it('refuses a message id that is not a snowflake, before deciding 404', async () => {
      // 400 and not 404, so the 404 keeps exactly one meaning: "no suggestion
      // came from that message" (R4.4).
      await seed();
      await asBot(
        http()
          .put(votesUrl('nao-e-um-id'))
          .send({ votes_up: 1, votes_down: 0 }),
      ).expect(400);
      await asBot(
        http().put(votesUrl('123')).send({ votes_up: 1, votes_down: 0 }),
      ).expect(400);
    });
  });
});
