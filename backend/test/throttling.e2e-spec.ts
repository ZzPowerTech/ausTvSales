import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { DASHBOARD_THROTTLE_LIMIT } from '../src/config/throttling';
import { createAuthenticatedApp } from './e2e-utils';

/**
 * Rate limiting on the dashboard reads (AusTV Admin S7.2, issue #111).
 *
 * ## Its own app instance, on purpose
 *
 * The throttler stores counters in memory, keyed by client, for the lifetime of
 * the process. A flood test sharing an app with other suites would leave the
 * bucket exhausted behind it and turn an unrelated assertion red — and worse, it
 * would do so intermittently, depending on execution order. A private app makes
 * this suite unable to affect anything else.
 *
 * ## Sequential, not parallel
 *
 * Every `request()` binds its own ephemeral listener on the same `http.Server`,
 * and concurrent binds answer `ECONNRESET` rather than a status code — which
 * would look like a rate limit and prove nothing.
 */
describe('Dashboard throttling (e2e)', () => {
  let app: NestExpressApplication;
  let authCookie: string;

  const CHECKS = '/health/instrumentation/checks';

  beforeAll(async () => {
    ({ app, authCookie } = await createAuthenticatedApp());
  });

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  it('answers 429 once the dashboard profile is exhausted', async () => {
    const statuses: number[] = [];

    // One past the limit: the last request is the one that must be refused, and
    // asking for exactly the limit would pass even if the guard were absent.
    for (let i = 0; i <= DASHBOARD_THROTTLE_LIMIT; i++) {
      const response = await http().get(CHECKS).set('Cookie', authCookie);
      statuses.push(response.status);
    }

    expect(statuses.slice(0, DASHBOARD_THROTTLE_LIMIT)).not.toContain(429);
    expect(statuses[DASHBOARD_THROTTLE_LIMIT]).toBe(429);
  }, 60_000);

  it('leaves the liveness probe unthrottled', async () => {
    // `/health` is what Nginx and the container poll. A 429 there reads as an
    // outage of a process that is perfectly healthy, so it is deliberately
    // outside the throttled controller even though it shares the prefix.
    for (let i = 0; i < 20; i++) {
      expect((await http().get('/health')).status).toBe(200);
    }
  }, 30_000);

  it('rejects an unauthenticated request before spending the bucket', async () => {
    // Guard order matters: the session guard is global and runs before the
    // route-scoped ThrottlerGuard, so anonymous traffic cannot consume an
    // operator's allowance. If this ever inverts, a flood of anonymous requests
    // would lock the real operator out during the incident they are responding
    // to.
    for (let i = 0; i < 10; i++) {
      expect((await http().get(CHECKS)).status).toBe(401);
    }

    expect((await http().get(CHECKS).set('Cookie', authCookie)).status).toBe(
      200,
    );
  }, 30_000);
});
