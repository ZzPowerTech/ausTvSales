import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { SESSION_COOKIE } from '../src/auth/auth.types';
import { SessionService } from '../src/auth/session.service';
import { configureApp } from '../src/config/configure-app';
import { PlanApiClient } from '../src/instrumentation/plan-api.client';
import { PlanUnreachableError } from '../src/instrumentation/plan-api.errors';
import { createAuthenticatedApp, TEST_DISCORD_ID } from './e2e-utils';

/** Trimmed real payload of `/v1/serverOverview?server=Survival` (2026-08-23). */
const SERVER_OVERVIEW = {
  timestamp: 1787494648039,
  last_7_days: {
    new_players: 43,
    unique_players: 237,
    new_players_retention: 25,
  },
  numbers: {
    online_players: '8',
    sessions: 138965,
    total_players: 5540,
    last_peak_date: 1787427319373,
  },
};

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
      // Classified, not the raw message. The raw one names the env var and, for
      // other failures in the taxonomy, the Plan host and a slice of its
      // response body — none of which belongs in a browser.
      expect(body.freshness.reason).toBe('not_configured');
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

/**
 * The stale branch, which the suite above structurally cannot reach.
 *
 * With `PLAN_BASE_URL` unset every call throws before anything is cached, so
 * those cases only ever exercise `unavailable`. The DoD names the other half —
 * *"Plan derrubado → 503/**stale** sem excecao nao tratada"* — and it is the half
 * where `data` is non-null, so a regression that broke only it (swapping
 * `HttpException` for `ServiceUnavailableException`, say) would pass everything
 * above.
 *
 * A stubbed `PlanApiClient` answers once and then fails, which is what a real
 * outage looks like from here.
 */
describe('Metrics degraded to stale (e2e)', () => {
  let app: NestExpressApplication;
  let authCookie: string;

  beforeAll(async () => {
    const getJson = jest
      .fn()
      .mockResolvedValueOnce(SERVER_OVERVIEW)
      .mockRejectedValue(
        new PlanUnreachableError('http://198.51.100.7:25504/v1/serverOverview'),
      );

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PlanApiClient)
      .useValue({ getJson, configured: true })
      .compile();

    app = moduleFixture.createNestApplication<NestExpressApplication>();
    configureApp(app, moduleFixture.get(ConfigService));
    await app.init();

    const token = await app.get(SessionService).sign({
      discordId: TEST_DISCORD_ID,
      username: 'Test Operator',
      avatar: null,
    });
    authCookie = `${SESSION_COOKIE}=${token}`;
  }, 30_000);

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  it('serves the last value as 503 with `stale: true`, not an empty page', async () => {
    const first = await http()
      .get('/metrics/servers/Survival')
      .set('Cookie', authCookie)
      .expect(200);

    expect(
      (first.body as { data: { onlinePlayers: number } }).data.onlinePlayers,
    ).toBe(8);

    // Past the 60s TTL of `PLAN_CACHE_TTL_SERVER_SECONDS`. The refetch fails, and
    // the previous reading is what a human still needs — a usable old number
    // beats an empty page.
    //
    // `setSystemTime` moves what `new Date()` reads, which stubbing `Date.now`
    // alone does not — the cache defaults its clock to `new Date()`. Timers are
    // left real via `doNotFake`, because faking them would hang the transport's
    // own retry backoff.
    const PAST_TTL_MS = 61_000;
    jest.useFakeTimers({
      doNotFake: ['setTimeout', 'setInterval', 'setImmediate', 'nextTick'],
    });
    jest.setSystemTime(new Date(Date.now() + PAST_TTL_MS));
    try {
      const second = await http()
        .get('/metrics/servers/Survival')
        .set('Cookie', authCookie);

      expect(second.status).toBe(503);

      const body = second.body as {
        data: { onlinePlayers: number } | null;
        freshness: { stale: boolean; reason: string; ageSeconds: number };
      };

      expect(body.freshness.stale).toBe(true);
      expect(body.data?.onlinePlayers).toBe(8);
      expect(body.freshness.ageSeconds).toBeGreaterThanOrEqual(60);
      // Classified, never the raw message: that one names the Plan host.
      expect(body.freshness.reason).toBe('unreachable');
      expect(JSON.stringify(body)).not.toContain('198.51.100.7');
      // And still not wrapped in Nest's error envelope.
      expect(body).not.toHaveProperty('statusCode');
    } finally {
      jest.useRealTimers();
    }
  });
});
