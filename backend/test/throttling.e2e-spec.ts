import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { DASHBOARD_THROTTLE_LIMIT } from '../src/config/throttling';
import { createAuthenticatedApp } from './e2e-utils';

/**
 * Rate limiting on the dashboard reads (AusTV Admin S7.2, issue #111).
 *
 * ## A fresh app per case, on purpose
 *
 * The throttler stores counters in memory, keyed by client, for the lifetime of
 * the process — so a flood leaves the bucket exhausted behind it. The first
 * version of this suite gave the *suite* its own app, which stopped it poisoning
 * other suites but not itself: the flood case emptied the bucket and the case
 * after it got a 429 where it expected a 200. CI caught it; the local run could
 * not, because those cases need Postgres.
 *
 * So the app is rebuilt per case. Booting three apps costs a couple of seconds
 * and buys an isolation that no ordering convention can be relied on to provide.
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

  beforeEach(async () => {
    ({ app, authCookie } = await createAuthenticatedApp());
  });

  afterEach(async () => {
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
    // to — and the 200 below is what proves it has not inverted.
    for (let i = 0; i < 10; i++) {
      expect((await http().get(CHECKS)).status).toBe(401);
    }

    expect((await http().get(CHECKS).set('Cookie', authCookie)).status).toBe(
      200,
    );
  }, 30_000);
});
