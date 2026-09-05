import { NestExpressApplication } from '@nestjs/platform-express';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import request from 'supertest';
import * as schema from '../src/db/schema';
import { suggestions } from '../src/db/schema';
import {
  PUBLIC_SUGGESTION_PAGE_DEFAULT,
  PUBLIC_SUGGESTION_STATUSES,
} from '../src/suggestions/dto/list-public-suggestions.dto';
import type { PublicSuggestionDto } from '../src/suggestions/dto/public-suggestion.dto';
import { SUGGESTION_PAGE_MAX } from '../src/suggestions/suggestions.store';
import { createApp } from './e2e-utils';

const AUTHOR = '111111111111111111';
const STAFF_ID = '333333333333333333';
const POSTED_AT = '2026-09-01T18:30:00.000Z';

interface Page {
  items: PublicSuggestionDto[];
  total: number;
  limit: number;
  offset: number;
}

function bodyOf<T>(response: request.Response): T {
  return response.body as T;
}

/**
 * The anonymous read surface (story S11.1), against a real PostgreSQL.
 *
 * The unit specs prove the projection and the composition. Three claims are
 * properties of the running app and of Postgres, and a stub cannot observe any
 * of them: that the route really answers **without a credential** (the global
 * guard is deny-by-default, so `@Public()` failing would be a 401 nobody
 * notices until the shop is dark), that the ordering Postgres applies is the one
 * the sort names, and that the tie-break is total when both the score and the
 * timestamp collide — which is the ordinary case for a fresh backlog, not an
 * exotic one.
 */
describe('Public suggestions (e2e)', () => {
  let app: NestExpressApplication;
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  const http = () => request(app.getHttpServer());

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

  async function seed(row: {
    discordMsgId: string;
    text?: string;
    votesUp?: number;
    votesDown?: number;
    status?: schema.SuggestionStatus;
    createdAt?: string;
    assignee?: string | null;
    assigneeNickname?: string | null;
  }): Promise<schema.Suggestion> {
    const [inserted] = await db
      .insert(suggestions)
      .values({
        discordMsgId: row.discordMsgId,
        author: AUTHOR,
        text: row.text ?? 'Colocar mais eventos no Survival',
        votesUp: row.votesUp ?? 0,
        votesDown: row.votesDown ?? 0,
        status: row.status ?? 'aprovada',
        createdAt: new Date(row.createdAt ?? POSTED_AT),
        assignee: row.assignee ?? null,
        assigneeNickname: row.assigneeNickname ?? null,
      })
      .returning();
    return inserted;
  }

  describe('reachability', () => {
    it('answers with no credential at all', async () => {
      // The global session guard denies by default. A route that lost its
      // `@Public()` would answer 401 to every anonymous reader, and nothing in
      // this repository other than this assertion would notice.
      await seed({ discordMsgId: '900000000000000001' });

      const page = bodyOf<Page>(
        await http().get('/public/suggestions').expect(200),
      );

      expect(page.items).toHaveLength(1);
    });

    it('answers the same to a caller presenting the bot key', async () => {
      // A regression canary, and named as one rather than as proof: nothing in
      // this controller's path reads `X-Api-Key` (the key guard is applied per
      // route by `@BotAuth()`, which this class does not use), so today the
      // header cannot change the answer. What the test would catch is a future
      // shared middleware that decided to be helpful about credentials.
      //
      // The key is asserted non-empty first, because `?? ''` degrades in
      // silence and a canary that stops carrying a credential stops being one.
      const botKey = process.env.BOT_API_KEYS?.split(',')[0].trim() ?? '';
      expect(botKey).not.toBe('');
      await seed({ discordMsgId: '900000000000000001' });

      const page = bodyOf<Page>(
        await http()
          .get('/public/suggestions')
          .set('X-Api-Key', botKey)
          .expect(200),
      );

      expect(page.items[0]).not.toHaveProperty('author');
    });
  });

  describe('projection', () => {
    it('publishes no player identity and no internal field', async () => {
      await seed({
        discordMsgId: '900000000000000001',
        status: 'aprovada',
        assignee: STAFF_ID,
        assigneeNickname: 'Shinigami',
        votesUp: 12,
        votesDown: 5,
      });

      const response = await http().get('/public/suggestions').expect(200);
      const page = bodyOf<Page>(response);

      // Against the serialized body, so a field that survived the projection
      // via some interceptor is still caught.
      expect(response.text).not.toContain(AUTHOR);
      expect(response.text).not.toContain(STAFF_ID);
      expect(response.text).not.toContain('900000000000000001');
      // The key set, not just the values: a column added to `suggestions` and
      // spread through by a later edit fails here rather than appearing on a
      // public page.
      const [item] = page.items;
      expect(Object.keys(item).sort()).toEqual([
        'approved_by',
        'created_at',
        'id',
        'score',
        'status',
        'text',
        'votes_down',
        'votes_up',
      ]);
      expect(item.text).toBe('Colocar mais eventos no Survival');
      expect(item.status).toBe('aprovada');
      expect(item.votes_up).toBe(12);
      expect(item.votes_down).toBe(5);
      expect(item.score).toBe(7);
      expect(item.created_at).toBe(POSTED_AT);
      expect(item.approved_by).toBe('Shinigami');
    });

    it('serves one suggestion by id in the same projection', async () => {
      const seeded = await seed({
        discordMsgId: '900000000000000001',
        assignee: STAFF_ID,
      });

      const found = bodyOf<PublicSuggestionDto>(
        await http().get(`/public/suggestions/${seeded.id}`).expect(200),
      );

      expect(found.id).toBe(seeded.id);
      expect(found).not.toHaveProperty('assignee');
      expect(found.approved_by).toBeNull();
    });

    it('answers 404 for an unknown id', async () => {
      await http().get('/public/suggestions/424242').expect(404);
    });
  });

  describe('only what the staff has read is public', () => {
    it('leaves an unread suggestion out of the listing entirely', async () => {
      // The failure this closes: a player writes a phishing link or somebody's
      // address, the bot records it as `enviada`, and the next anonymous read
      // republishes it on the server's own domain before any human sees it.
      await seed({
        discordMsgId: '900000000000000001',
        status: 'enviada',
        text: 'texto que ninguem da staff leu ainda',
      });
      await seed({ discordMsgId: '900000000000000002', status: 'aprovada' });

      const response = await http().get('/public/suggestions').expect(200);
      const page = bodyOf<Page>(response);

      expect(page.total).toBe(1);
      expect(page.items).toHaveLength(1);
      expect(page.items[0].status).toBe('aprovada');
      expect(response.text).not.toContain('ninguem da staff leu');
    });

    it('leaves a refused suggestion out too, permanently', async () => {
      // `recusada` is terminal with no re-open, so publishing it would keep a
      // rejected suggestion on the shop forever.
      await seed({ discordMsgId: '900000000000000001', status: 'recusada' });

      const page = bodyOf<Page>(
        await http().get('/public/suggestions').expect(200),
      );

      expect(page.total).toBe(0);
    });

    it('counts only publishable rows in `total`', async () => {
      // `total` is computed by a second query, so it can disagree with the
      // filter — and a total that counts hidden rows tells the reader there are
      // pages that do not exist.
      for (const status of ['enviada', 'recusada', 'concluida'] as const) {
        await seed({
          discordMsgId: `9000000000000000${status.length}0`,
          status,
        });
      }
      await seed({ discordMsgId: '900000000000000099', status: 'aprovada' });

      const page = bodyOf<Page>(
        await http().get('/public/suggestions').expect(200),
      );

      expect(page.total).toBe(1);
    });

    it('refuses a filter for a state that is not public', async () => {
      // 400 rather than an empty page: "that state is not public" and "there
      // are none like that" are different answers, and only one of them is
      // true.
      await http().get('/public/suggestions?status=enviada').expect(400);
      await http().get('/public/suggestions?status=recusada').expect(400);
    });

    it('serves each publishable state when asked for it explicitly', async () => {
      for (const status of PUBLIC_SUGGESTION_STATUSES) {
        await http().get(`/public/suggestions?status=${status}`).expect(200);
      }
    });

    it('hides an unpublished suggestion behind the same 404 on the by-id route', async () => {
      // Without this the detail route is an oracle: walk the ids and every 200
      // is a suggestion the listing refuses to show.
      const hidden = await seed({
        discordMsgId: '900000000000000001',
        status: 'enviada',
      });

      await http().get(`/public/suggestions/${hidden.id}`).expect(404);
    });

    it('answers 404 rather than 500 for an id outside the int4 range', async () => {
      // `ParseIntPipe` accepts it; the `integer` column does not, and the round
      // trip used to end in `value out of range for type integer` — a 500 an
      // anonymous caller could mint at will.
      await http().get('/public/suggestions/3000000000').expect(404);
    });
  });

  describe('pagination is mandatory', () => {
    it('applies a default page size to an unqualified request', async () => {
      for (let i = 0; i < PUBLIC_SUGGESTION_PAGE_DEFAULT + 3; i++) {
        await seed({ discordMsgId: `90000000000000${1000 + i}` });
      }

      const page = bodyOf<Page>(
        await http().get('/public/suggestions').expect(200),
      );

      expect(page.limit).toBe(PUBLIC_SUGGESTION_PAGE_DEFAULT);
      expect(page.items).toHaveLength(PUBLIC_SUGGESTION_PAGE_DEFAULT);
      expect(page.total).toBe(PUBLIC_SUGGESTION_PAGE_DEFAULT + 3);
    });

    it('refuses a page larger than the ceiling instead of trimming silently', async () => {
      // 400, not "here are 25". A consumer that asked for 5.000 and received 25
      // without being told has no way to know it is missing rows.
      await http()
        .get(`/public/suggestions?limit=${SUGGESTION_PAGE_MAX + 1}`)
        .expect(400);
    });

    it('refuses an offset that survives @IsInt but not Postgres', async () => {
      // `Number.isInteger(1e21)` is true. The S10.3 review found this reaching
      // the database on the bot's listing; the public route inherits both the
      // DTO cap and the store's clamp.
      await http().get('/public/suggestions?offset=1e21').expect(400);
    });

    it('refuses an unknown sort rather than falling back to a default', async () => {
      await http().get('/public/suggestions?sort=updated_at').expect(400);
    });

    it('reports the total of the filtered set, not of the page', async () => {
      await seed({ discordMsgId: '900000000000000001', status: 'aprovada' });
      await seed({ discordMsgId: '900000000000000002', status: 'aprovada' });
      await seed({
        discordMsgId: '900000000000000003',
        status: 'em_andamento',
      });

      const page = bodyOf<Page>(
        await http()
          .get('/public/suggestions?status=aprovada&limit=1')
          .expect(200),
      );

      expect(page.items).toHaveLength(1);
      expect(page.total).toBe(2);
    });
  });

  describe('ordering', () => {
    it('sorts by net score, and a contested card does not outrank a quiet one', async () => {
      const contested = await seed({
        discordMsgId: '900000000000000001',
        votesUp: 40,
        votesDown: 38,
      });
      const quiet = await seed({
        discordMsgId: '900000000000000002',
        votesUp: 12,
        votesDown: 0,
      });

      const page = bodyOf<Page>(
        await http().get('/public/suggestions?sort=votes').expect(200),
      );

      expect(page.items.map((item) => item.id)).toEqual([
        quiet.id,
        contested.id,
      ]);

      // The published `score` and the SQL the ordering uses are the same
      // arithmetic written twice, in two languages. Nothing proved they agreed
      // until this line: assert the published numbers are non-increasing in the
      // order Postgres returned them.
      const scores = page.items.map((item) => item.score);
      expect(scores).toEqual([...scores].sort((a, b) => b - a));
      expect(scores).toEqual([12, 2]);
    });

    it('keeps the order total when the score and the date both tie', async () => {
      // The ordinary case on a fresh backlog: everything is 0/0, and a burst or
      // a backfill shares a timestamp. Without `id DESC` Postgres may break the
      // tie differently per query, and the two pages below would then overlap
      // or skip a row.
      const first = await seed({ discordMsgId: '900000000000000001' });
      const second = await seed({ discordMsgId: '900000000000000002' });
      const third = await seed({ discordMsgId: '900000000000000003' });

      const pageOne = bodyOf<Page>(
        await http().get('/public/suggestions?sort=votes&limit=2').expect(200),
      );
      const pageTwo = bodyOf<Page>(
        await http()
          .get('/public/suggestions?sort=votes&limit=2&offset=2')
          .expect(200),
      );

      // Deliberately crossing the page boundary: the tie-break only proves
      // anything if one of the tied rows has to land on the far side of it.
      expect(pageOne.items.map((item) => item.id)).toEqual([
        third.id,
        second.id,
      ]);
      expect(pageTwo.items.map((item) => item.id)).toEqual([first.id]);
    });

    it('sorts by date by default, newest first', async () => {
      const older = await seed({
        discordMsgId: '900000000000000001',
        createdAt: '2026-08-01T00:00:00.000Z',
        votesUp: 99,
      });
      const newer = await seed({
        discordMsgId: '900000000000000002',
        createdAt: '2026-09-01T00:00:00.000Z',
      });

      const page = bodyOf<Page>(
        await http().get('/public/suggestions').expect(200),
      );

      // The high-vote row is the older one on purpose: if the default silently
      // became `votes`, the assertion flips.
      expect(page.items.map((item) => item.id)).toEqual([newer.id, older.id]);
    });
  });
});
