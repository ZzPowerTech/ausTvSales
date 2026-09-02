import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createAuthenticatedApp } from './e2e-utils';

/**
 * The weekly report end to end (story S9.2).
 *
 * This suite runs against a real Postgres and an app whose `PLAN_BASE_URL`,
 * `PLAN_DB_HOST` and `DISCORD_REPORT_WEBHOOK_URL` are all unset — which is the
 * most valuable configuration to test, not the least: it exercises the path
 * where **every** upstream is missing and asserts that the run still produces a
 * stored report that says so, rather than a 500 or a page of zeroes.
 *
 * It also proves the persistence half of criterion 4 against the real schema,
 * which a unit test with a mocked store cannot.
 */
describe('Weekly report (e2e)', () => {
  let app: INestApplication<App>;
  let authCookie: string;

  beforeAll(async () => {
    ({ app, authCookie } = await createAuthenticatedApp());
  });

  afterAll(async () => {
    await app.close();
  });

  describe('the routes are behind the session', () => {
    it.each([
      ['get', '/reports/weekly'],
      ['get', '/reports/weekly/latest'],
      ['get', '/reports/weekly/1'],
      ['post', '/reports/weekly/run'],
    ])('answers 401 on %s %s without a session', async (method, path) => {
      // The POST is the one that matters most: it causes an outbound Discord
      // message, so an unauthenticated caller who could fire it would own the
      // channel's noise floor.
      const agent = request(app.getHttpServer());
      await (method === 'post' ? agent.post(path) : agent.get(path)).expect(
        401,
      );
    });
  });

  describe('the manual run is actually rate limited', () => {
    it('carries the rate-limit headers, so the guard is really applied', async () => {
      // `@Throttle` alone is metadata; `ThrottlerGuard` is deliberately not an
      // APP_GUARD in this app. The first version of this route had the
      // decorator without the guard — it compiled, it documented itself as
      // limited to six an hour, and it enforced nothing, on the one route that
      // reaches the game machine and posts to Discord.
      //
      // The headers are the observable proof the guard ran, which is the same
      // shape `throttling.e2e-spec.ts` already uses.
      const response = await request(app.getHttpServer())
        .post('/reports/weekly/run')
        .set('Cookie', authCookie)
        .expect(201);

      expect(response.headers['x-ratelimit-limit']).toBe('6');
    });
  });

  describe('the manual run is actually rate limited', () => {
    it('carries the rate-limit headers, so the guard is really applied', async () => {
      // `@Throttle` alone is metadata; `ThrottlerGuard` is deliberately not an
      // APP_GUARD in this app. The first version of this route had the
      // decorator without the guard — it compiled, it documented itself as
      // limited to six an hour, and it enforced nothing, on the one route that
      // reaches the game machine and posts to Discord.
      //
      // The headers are the observable proof the guard ran, which is the same
      // shape `throttling.e2e-spec.ts` already uses.
      const response = await request(app.getHttpServer())
        .post('/reports/weekly/run')
        .set('Cookie', authCookie)
        .expect(201);

      expect(response.headers['x-ratelimit-limit']).toBe('6');
    });
  });

  describe('generating a report by hand', () => {
    let reportId: number;

    it('persists a run even with every upstream missing', async () => {
      const response = await request(app.getHttpServer())
        .post('/reports/weekly/run')
        .set('Cookie', authCookie)
        .expect(201);

      const body = response.body as {
        id: number;
        status: string;
        periodFrom: string;
        periodTo: string;
        delivered: boolean;
        rendered: string;
        payload: {
          funnel: { sources: { ok: boolean; failure?: string }[] };
          retention: { source: { ok: boolean; failure?: string } };
        };
      };

      reportId = body.id;

      // `ok`, not `error`: the sources being unreachable is content, not a job
      // failure. Confusing the two would make every outage look like a broken
      // report and vice versa.
      expect(body.status).toBe('ok');
      // Seven days ending yesterday.
      expect(body.periodFrom < body.periodTo).toBe(true);
      // No webhook configured, so nothing was delivered — and the report was
      // stored anyway, which is the point of persisting before publishing.
      expect(body.delivered).toBe(false);
      expect(body.rendered).toContain('Relatorio semanal');

      // Every source names its failure instead of reporting zeroes.
      expect(body.payload.retention.source.ok).toBe(false);
      expect(body.payload.retention.source.failure).toBe('not_configured');
      for (const source of body.payload.funnel.sources) {
        expect(source.ok).toBe(false);
        expect(source.failure).toBeDefined();
      }
    });

    it('reads the stored run back by id', async () => {
      const response = await request(app.getHttpServer())
        .get(`/reports/weekly/${reportId}`)
        .set('Cookie', authCookie)
        .expect(200);

      expect((response.body as { id: number }).id).toBe(reportId);
    });

    it('reads it back as the latest', async () => {
      const response = await request(app.getHttpServer())
        .get('/reports/weekly/latest')
        .set('Cookie', authCookie)
        .expect(200);

      expect((response.body as { id: number }).id).toBe(reportId);
    });

    it('lists recent runs, newest first', async () => {
      const response = await request(app.getHttpServer())
        .get('/reports/weekly?limit=5')
        .set('Cookie', authCookie)
        .expect(200);

      const body = response.body as { id: number }[];
      expect(body.length).toBeGreaterThanOrEqual(1);
      expect(body[0].id).toBe(reportId);
    });

    it('never leaks internal topology into the rendered text', async () => {
      const response = await request(app.getHttpServer())
        .get(`/reports/weekly/${reportId}`)
        .set('Cookie', authCookie)
        .expect(200);

      const rendered = (response.body as { rendered: string }).rendered;
      expect(rendered).not.toMatch(/postgres(ql)?:\/\//);
      expect(rendered).not.toContain('ECONNREFUSED');
    });
  });

  describe('input validation', () => {
    it('rejects a non-numeric id', async () => {
      await request(app.getHttpServer())
        .get('/reports/weekly/abc')
        .set('Cookie', authCookie)
        .expect(400);
    });

    it('rejects a limit above the ceiling', async () => {
      await request(app.getHttpServer())
        .get('/reports/weekly?limit=9999')
        .set('Cookie', authCookie)
        .expect(400);
    });

    it('answers 404 for a report that does not exist', async () => {
      await request(app.getHttpServer())
        .get('/reports/weekly/999999')
        .set('Cookie', authCookie)
        .expect(404);
    });
  });
});
