import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { createAuthenticatedApp } from './e2e-utils';

/**
 * The cohort-retention route end to end (story S8.2).
 *
 * What only an e2e can prove: that the route is genuinely behind the session,
 * that the DTO rejects what it claims to reject, and that an unset
 * `PLAN_BASE_URL` degrades to a named failure instead of a 500 or — far worse —
 * a report full of zeroes.
 *
 * The arithmetic lives in `retention-math.spec.ts` and the parsing in
 * `plan-retention.spec.ts`; this suite is about the edges of the HTTP contract.
 */
describe('Retention (e2e)', () => {
  let app: INestApplication<App>;
  let authCookie: string;

  beforeAll(async () => {
    ({ app, authCookie } = await createAuthenticatedApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers 401 without a session', async () => {
    // Deny-by-default via the global guard. Asserted rather than assumed: this
    // route publishes business numbers, and "nothing here is @Public()" is a
    // property of the code that a future decorator could silently undo.
    await request(app.getHttpServer()).get('/retention/cohorts').expect(401);
  });

  describe('with a session', () => {
    it('degrades honestly when Plan is unconfigured, never with zeroes', async () => {
      const response = await request(app.getHttpServer())
        .get('/retention/cohorts?from=2026-01&to=2026-03')
        .set('Cookie', authCookie)
        .expect(200);

      const body = response.body as {
        semantics: string;
        from: string;
        to: string;
        cohorts: unknown[];
        source: {
          ok: boolean;
          failure?: string;
          dataThrough: string | null;
          parsed: number | null;
          dropped: number | null;
        };
      };

      expect(body.source.ok).toBe(false);
      expect(body.source.failure).toBe('not_configured');
      // The parse accounting is null rather than zero when nothing was read:
      // "we parsed zero rows" and "we never got a payload" are different facts.
      expect(body.source.parsed).toBeNull();
      expect(body.source.dropped).toBeNull();
      // An empty array next to a failed source is the contract. It must never be
      // read as "no cohorts exist" — that confusion is the whole reason for the
      // epic.
      expect(body.cohorts).toEqual([]);
      expect(body.from).toBe('2026-01');
      expect(body.to).toBe('2026-03');
    });

    it('never ships an upstream table name in the body', async () => {
      // The label is required; the schema identifier is not. It shipped in every
      // response, including the degraded one, until this test existed — spec §8
      // and CWE-209 both name internal identifiers explicitly.
      const response = await request(app.getHttpServer())
        .get('/retention/cohorts')
        .set('Cookie', authCookie)
        .expect(200);

      const body = JSON.stringify(response.body);
      for (const identifier of ['plan_sessions', 'plan_user_info']) {
        expect(body).not.toContain(identifier);
      }
    });

    it('carries the survival-interval label in every response', async () => {
      // The label is part of the contract, not a docblock: "D30" here means
      // "still seen 30 days later", not "came back on day 30".
      const response = await request(app.getHttpServer())
        .get('/retention/cohorts')
        .set('Cookie', authCookie)
        .expect(200);

      expect((response.body as { semantics: string }).semantics).toContain(
        'nao retorno no dia N',
      );
    });

    it('rejects a month that is not a month', async () => {
      await request(app.getHttpServer())
        .get('/retention/cohorts?from=2026-13')
        .set('Cookie', authCookie)
        .expect(400);
    });

    it('rejects a day where a month is expected', async () => {
      // Accepting `2026-01-15` would force a choice between widening the window
      // and returning half a cohort as if it were a whole one.
      await request(app.getHttpServer())
        .get('/retention/cohorts?from=2026-01-15')
        .set('Cookie', authCookie)
        .expect(400);
    });

    it('rejects an inverted window instead of returning an empty report', async () => {
      await request(app.getHttpServer())
        .get('/retention/cohorts?from=2026-08&to=2026-01')
        .set('Cookie', authCookie)
        .expect(400);
    });

    it('rejects an unknown platform rather than filtering to nobody', async () => {
      await request(app.getHttpServer())
        .get('/retention/cohorts?platform=nintendo')
        .set('Cookie', authCookie)
        .expect(400);
    });

    it('never sets a cacheable header on a business number', async () => {
      const response = await request(app.getHttpServer())
        .get('/retention/cohorts')
        .set('Cookie', authCookie)
        .expect(200);

      expect(response.headers['cache-control']).toBe('no-store');
    });
  });
});
