import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createAuthenticatedApp } from './e2e-utils';

/**
 * The funnel routes end to end (story S8.1).
 *
 * What only an e2e can prove here: that the routes are actually behind the
 * session, that the DTO rejects what it says it rejects, and that the `400` on
 * an inverted period comes from the route rather than from a mock.
 *
 * The **data** paths are covered by `funnel.service.spec.ts` — this suite runs
 * against a real app whose `PLAN_DB_HOST` is unset, so the network step is
 * legitimately `not_configured`, and that is itself worth asserting: an
 * unconfigured source must degrade honestly rather than 500.
 */
describe('Funnel (e2e)', () => {
  let app: INestApplication<App>;
  let authCookie: string;

  beforeAll(async () => {
    ({ app, authCookie } = await createAuthenticatedApp());
  });

  afterAll(async () => {
    await app.close();
  });

  describe('the routes are behind the session', () => {
    it.each(['/funnel/daily', '/funnel/monthly'])(
      'answers 401 on %s without a session',
      async (path) => {
        // Deny-by-default via the global guard. Asserted rather than assumed:
        // "nothing here is @Public()" is a property of the code that a future
        // decorator could silently undo.
        await request(app.getHttpServer()).get(path).expect(401);
      },
    );
  });

  describe('with a session', () => {
    it('returns a daily series whose every bucket explains itself', async () => {
      const response = await request(app.getHttpServer())
        .get('/funnel/daily?from=2026-03-01&to=2026-03-03')
        .set('Cookie', authCookie)
        .expect(200);

      const body = response.body as {
        granularity: string;
        truncated: boolean;
        buckets: {
          bucket: string;
          counts: { step: string; value: number | null }[];
          conversions: { percent: number | null; n: number | null }[];
        }[];
        sources: { name: string; ok: boolean; failure?: string }[];
      };

      expect(body.granularity).toBe('daily');
      expect(body.truncated).toBe(false);
      expect(body.buckets.map((b) => b.bucket)).toEqual([
        '2026-03-01',
        '2026-03-02',
        '2026-03-03',
      ]);

      // The rule the whole contract exists for: never a ratio without its base.
      for (const bucket of body.buckets) {
        for (const conversion of bucket.conversions) {
          if (conversion.percent !== null) {
            expect(conversion.n).not.toBeNull();
          }
        }
      }
    });

    it('degrades honestly when a source is unconfigured, rather than 500', async () => {
      const response = await request(app.getHttpServer())
        .get('/funnel/daily?from=2026-03-01&to=2026-03-01')
        .set('Cookie', authCookie)
        .expect(200);

      const body = response.body as {
        sources: { name: string; ok: boolean; failure?: string }[];
      };
      const planUsers = body.sources.find((s) => s.name === 'plan_users');

      expect(planUsers?.ok).toBe(false);
      // A closed label, never an upstream message (CWE-209; the same call
      // story S7.2 made for `MetricsFailureReason`).
      expect(planUsers?.failure).toBe('not_configured');
      expect(JSON.stringify(body)).not.toMatch(/ECONNREFUSED|Access denied/);
    });

    it('aggregates by month on the monthly route', async () => {
      const response = await request(app.getHttpServer())
        .get('/funnel/monthly?from=2026-01-15&to=2026-03-02')
        .set('Cookie', authCookie)
        .expect(200);

      const body = response.body as { buckets: { bucket: string }[] };
      expect(body.buckets.map((b) => b.bucket)).toEqual([
        '2026-01',
        '2026-02',
        '2026-03',
      ]);
    });

    it('marks a window longer than the cap as truncated', async () => {
      const response = await request(app.getHttpServer())
        .get('/funnel/daily?from=1970-01-01&to=2026-12-31')
        .set('Cookie', authCookie)
        .expect(200);

      const body = response.body as { truncated: boolean; from: string };
      // The envelope must not claim to cover 57 years when it read one.
      expect(body.truncated).toBe(true);
      expect(body.from).not.toBe('1970-01-01');
    });

    describe('rejects malformed input at the edge', () => {
      it.each([
        ['from=nao-e-data', 'from'],
        ['to=2026-13-45x', 'to'],
        // Shape-valid but not a real date — the regex accepts it, so the route
        // has to. Left through, it reaches the driver as NaN and comes back
        // labelled as a source outage.
        ['from=2026-01-45', 'from'],
        ['to=2026-13-01', 'to'],
        ['platform=inventada', 'platform'],
      ])('answers 400 for %s', async (query) => {
        await request(app.getHttpServer())
          .get(`/funnel/daily?${query}`)
          .set('Cookie', authCookie)
          .expect(400);
      });

      it('answers 400 when the period is inverted', async () => {
        // A relation between two fields, so it cannot live in class-validator
        // without being reported against one of them — which would read as
        // "your `from` is malformed" when both are perfectly well formed.
        await request(app.getHttpServer())
          .get('/funnel/daily?from=2026-03-10&to=2026-03-01')
          .set('Cookie', authCookie)
          .expect(400);
      });

      it('accepts every documented platform', async () => {
        for (const platform of [
          'all',
          'bedrock',
          'java_offline',
          'java_premium',
          'unknown',
        ]) {
          await request(app.getHttpServer())
            .get(
              `/funnel/daily?platform=${platform}&from=2026-03-01&to=2026-03-01`,
            )
            .set('Cookie', authCookie)
            .expect(200);
        }
      });
    });
  });
});
