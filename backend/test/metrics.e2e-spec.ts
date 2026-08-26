import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createAuthenticatedApp } from './e2e-utils';

/**
 * Metrics reads over HTTP (story S7.2, issue #111).
 *
 * ## What the CI environment makes this suite able to prove
 *
 * `PLAN_BASE_URL` is unset in CI, so `PlanApiClient` throws
 * `PlanNotConfiguredError` on every call. That is not a limitation here — it is
 * precisely the "Plan unreachable, nothing cached" branch the story's third
 * criterion is about, and it lets the degraded path be asserted end to end
 * without a fake Plan.
 *
 * The healthy path is covered by the unit spec against the real observed
 * payloads; what only a real request can settle is the status code, the
 * envelope shape, and that the guard runs first.
 */
describe('Metrics (e2e)', () => {
  let app: NestExpressApplication;
  let authCookie: string;

  const SERVERS = '/metrics/servers';

  beforeAll(async () => {
    ({ app, authCookie } = await createAuthenticatedApp());
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  describe('without a session', () => {
    it('refuses every route with 401', async () => {
      // Sequential: each supertest call binds its own ephemeral listener on the
      // same http.Server, and concurrent binds answer ECONNRESET.
      const paths = [
        SERVERS,
        `${SERVERS}/Survival`,
        `${SERVERS}/Survival/activity`,
      ];

      for (const path of paths) {
        expect([path, (await http().get(path)).status]).toEqual([path, 401]);
      }
    });
  });

  describe('validation', () => {
    it('rejects a server name outside the allowed charset', async () => {
      const response = await http()
        .get(`${SERVERS}/${encodeURIComponent("Survival'; DROP--")}`)
        .set('Cookie', authCookie);

      expect(response.status).toBe(400);
    });

    it('answers 404 for a name that is not in PLAN_SERVERS', async () => {
      // Distinct from 400 on purpose: the name is well formed, it is simply not
      // one of ours — and no request leaves the process for it.
      const response = await http()
        .get(`${SERVERS}/NaoExiste`)
        .set('Cookie', authCookie);

      expect(response.status).toBe(404);
    });
  });

  describe('with a session', () => {
    it('lists the configured servers with the proxy flag', async () => {
      const response = await http()
        .get(SERVERS)
        .set('Cookie', authCookie)
        .expect(200);

      const body = response.body as {
        servers: Array<{ name: string; proxy: boolean }>;
      };

      // Matches the CI/.env.example configuration: `PLAN_SERVERS=AusTv,Survival`
      // with `PLAN_PROXY_SERVER=AusTv`.
      expect(body.servers).toEqual([
        { name: 'AusTv', proxy: true },
        { name: 'Survival', proxy: false },
      ]);
    });

    it('answers 503 with an explicit body when Plan cannot be reached', async () => {
      // The story's third criterion. Never a 200 with zeros, and never an empty
      // 503 either — the body says what happened.
      const response = await http()
        .get(`${SERVERS}/Survival`)
        .set('Cookie', authCookie);

      expect(response.status).toBe(503);

      const body = response.body as {
        data: unknown;
        freshness: {
          stale: boolean;
          fetchedAt: string | null;
          ageSeconds: number | null;
          reason: string | null;
        };
      };

      expect(body.data).toBeNull();
      // Nothing was served, so there is nothing to be stale about. `data: null`
      // is the whole message.
      expect(body.freshness.stale).toBe(false);
      expect(body.freshness.fetchedAt).toBeNull();
      expect(body.freshness.reason).toContain('PLAN_BASE_URL');
    });

    it('keeps the same envelope shape on the degraded activity route', async () => {
      // A degraded response that changed shape would force a consumer to parse
      // two contracts, and would tempt it to throw away a usable stale value.
      const response = await http()
        .get(`${SERVERS}/Survival/activity`)
        .set('Cookie', authCookie);

      expect(response.status).toBe(503);
      expect(Object.keys(response.body as object).sort()).toEqual([
        'data',
        'freshness',
      ]);
    });

    it('does not wrap the degraded body in Nest’s error envelope', async () => {
      // `ServiceUnavailableException` would produce `{statusCode, message}` and
      // bury the payload. The 503 has to carry the very same body a 200 does.
      const response = await http()
        .get(`${SERVERS}/Survival`)
        .set('Cookie', authCookie);

      expect(response.body).not.toHaveProperty('statusCode');
      expect(response.body).not.toHaveProperty('message');
    });

    it('never caches a metrics answer', async () => {
      const response = await http().get(SERVERS).set('Cookie', authCookie);

      expect(response.headers['cache-control']).toBe('no-store');
    });

    it('is rate limited under the dashboard profile', async () => {
      // Proves `@DashboardThrottle()` reached these routes: 120/min, not
      // ingest's 10/s, and not unlimited.
      const response = await http().get(SERVERS).set('Cookie', authCookie);

      expect(response.headers['x-ratelimit-limit']).toBe('120');
    });
  });
});
