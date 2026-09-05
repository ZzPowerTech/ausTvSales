import { NestExpressApplication } from '@nestjs/platform-express';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import request from 'supertest';
import { SESSION_COOKIE } from '../src/auth/auth.types';
import { SessionService } from '../src/auth/session.service';
import * as schema from '../src/db/schema';
import { suggestionAudit, suggestions } from '../src/db/schema';
import { DASHBOARD_AUDIT_COMMAND } from '../src/suggestions/suggestions-admin.controller';
import { createAuthenticatedApp, TEST_DISCORD_ID } from './e2e-utils';

const AUTHOR = '444444444444444444';
const POSTED_AT = '2026-09-01T18:30:00.000Z';

/** The second id on the CI allowlist — signed in, and not the test operator. */
const OTHER_ALLOWED_ID = '222222222222222222';

function bodyOf<T>(response: request.Response): T {
  return response.body as T;
}

/**
 * The staff-authenticated surface (story S11.1, criterion 3), against a real
 * PostgreSQL and the real app.
 *
 * The unit specs prove the controller's decisions against stubs. Three things
 * are properties of the running app and cannot be observed from one: that the
 * routes are actually behind the session guard, that `forbidNonWhitelisted`
 * really refuses an `actor` in the body (that is the `ValidationPipe` from
 * `configureApp`, not the controller), and that the audit row Postgres ends up
 * holding names the session's owner.
 */
describe('Suggestions admin surface (e2e)', () => {
  let app: NestExpressApplication;
  let authCookie: string;
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: './drizzle' });

    ({ app, authCookie } = await createAuthenticatedApp());
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
    status: schema.SuggestionStatus = 'enviada',
  ): Promise<schema.Suggestion> {
    const [row] = await db
      .insert(suggestions)
      .values({
        discordMsgId: '900000000000000001',
        author: AUTHOR,
        text: 'Colocar mais eventos no Survival',
        createdAt: new Date(POSTED_AT),
        status,
      })
      .returning();
    return row;
  }

  describe('authentication', () => {
    it('refuses every route without a session', async () => {
      // The global guard denies by default, and these routes carry no
      // `@Public()`. Asserted per route because the decorator is per route.
      await http().get('/admin/suggestions').expect(401);
      await http().get('/admin/suggestions/1').expect(401);
      await http().get('/admin/suggestions/1/audit').expect(401);
      await http()
        .patch('/admin/suggestions/1/status')
        .send({ to: 'aprovada' })
        .expect(401);
    });

    it('refuses the bot key here, as the bot routes refuse a cookie', async () => {
      // Two principals, two surfaces. A key that worked here would give the bot
      // the ability to act as an unnamed dashboard operator.
      const botKey = process.env.BOT_API_KEYS?.split(',')[0].trim() ?? '';
      expect(botKey).not.toBe('');

      await http()
        .get('/admin/suggestions')
        .set('X-Api-Key', botKey)
        .expect(401);
    });
  });

  describe('reads', () => {
    it('returns internal fields the public projection strips', async () => {
      await seed();

      const response = await http()
        .get('/admin/suggestions')
        .set('Cookie', authCookie)
        .expect(200);

      expect(response.text).toContain(AUTHOR);
      expect(response.text).toContain('900000000000000001');
    });

    it('lists a state the public route hides', async () => {
      await seed('enviada');

      const page = bodyOf<{ total: number; items: schema.Suggestion[] }>(
        await http()
          .get('/admin/suggestions')
          .set('Cookie', authCookie)
          .expect(200),
      );

      expect(page.total).toBe(1);
      expect(page.items[0].status).toBe('enviada');
    });
  });

  describe('transition', () => {
    it('records the session owner as the actor', async () => {
      const seeded = await seed('enviada');

      await http()
        .patch(`/admin/suggestions/${seeded.id}/status`)
        .set('Cookie', authCookie)
        .send({ to: 'aprovada' })
        .expect(200);

      const [row] = await db
        .select()
        .from(suggestions)
        .where(eq(suggestions.id, seeded.id));
      const trail = await db
        .select()
        .from(suggestionAudit)
        .where(eq(suggestionAudit.suggestionId, seeded.id));

      expect(row.status).toBe('aprovada');
      expect(row.assignee).toBe(TEST_DISCORD_ID);
      expect(trail).toHaveLength(1);
      expect(trail[0].actor).toBe(TEST_DISCORD_ID);
      expect(trail[0].command).toBe(DASHBOARD_AUDIT_COMMAND);
    });

    it('refuses an actor supplied in the body instead of ignoring it', async () => {
      // 400 and not a silent drop, because a silent drop is indistinguishable
      // from success for the caller who tried it. `forbidNonWhitelisted` is
      // what makes an impersonation attempt an error rather than a no-op.
      const seeded = await seed('enviada');

      await http()
        .patch(`/admin/suggestions/${seeded.id}/status`)
        .set('Cookie', authCookie)
        .send({ to: 'aprovada', actor: OTHER_ALLOWED_ID })
        .expect(400);

      const [row] = await db
        .select()
        .from(suggestions)
        .where(eq(suggestions.id, seeded.id));
      expect(row.status).toBe('enviada');
    });

    it('cannot be talked into crediting somebody else', async () => {
      // The same attempt through the other two fields the bot's DTO accepts.
      const seeded = await seed('enviada');

      for (const body of [
        { to: 'aprovada', actor_nickname: 'OutraPessoa' },
        { to: 'aprovada', command: 'nao-foi-o-dashboard' },
      ]) {
        await http()
          .patch(`/admin/suggestions/${seeded.id}/status`)
          .set('Cookie', authCookie)
          .send(body)
          .expect(400);
      }
    });

    it('answers 409 without touching the record, and records the attempt', async () => {
      const seeded = await seed('concluida');

      await http()
        .patch(`/admin/suggestions/${seeded.id}/status`)
        .set('Cookie', authCookie)
        .send({ to: 'aprovada' })
        .expect(409);

      const [row] = await db
        .select()
        .from(suggestions)
        .where(eq(suggestions.id, seeded.id));
      const trail = await db
        .select()
        .from(suggestionAudit)
        .where(eq(suggestionAudit.suggestionId, seeded.id));

      expect(row.status).toBe('concluida');
      expect(trail).toHaveLength(1);
      expect(trail[0].action).toBe('transition_denied');
      expect(trail[0].actor).toBe(TEST_DISCORD_ID);
    });
  });

  describe('staff scope', () => {
    it('refuses a signed-in user who is outside the scope, with 403', async () => {
      // CI sets `STAFF_DISCORD_IDS` to the first allowlisted id only, so this
      // case is deterministic — and the variable exists in the workflow
      // precisely so that it is. With the scope falling back to the whole
      // allowlist, this request would be a 200 and the suite would pass
      // identically with the guard deleted from the composition: the defect the
      // S10.2 review found in `@BotAuth()`, where the allowlist was off in CI.
      const token = await app.get(SessionService).sign({
        discordId: OTHER_ALLOWED_ID,
        username: 'Segundo Operador',
        avatar: null,
      });
      const seeded = await seed('enviada');

      const response = await http()
        .patch(`/admin/suggestions/${seeded.id}/status`)
        .set('Cookie', `${SESSION_COOKIE}=${token}`)
        .send({ to: 'aprovada' })
        .expect(403);

      // 403 and not 401: the person is signed in. A 401 would send them to log
      // in again, forever, for a permission they do not have.
      expect(bodyOf<{ message: string }>(response).message).toContain('staff');

      const [row] = await db
        .select()
        .from(suggestions)
        .where(eq(suggestions.id, seeded.id));
      expect(row.status).toBe('enviada');
    });

    it('still lets a non-staff signed-in user READ', async () => {
      // The scope is on the write route only, and that is a decision rather
      // than an oversight — asserted so that narrowing reads later is also a
      // decision.
      const token = await app.get(SessionService).sign({
        discordId: OTHER_ALLOWED_ID,
        username: 'Segundo Operador',
        avatar: null,
      });

      await http()
        .get('/admin/suggestions')
        .set('Cookie', `${SESSION_COOKIE}=${token}`)
        .expect(200);
    });
  });
});
