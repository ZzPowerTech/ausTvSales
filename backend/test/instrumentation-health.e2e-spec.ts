import { NestExpressApplication } from '@nestjs/platform-express';
import { Pool } from 'pg';
import request from 'supertest';
import { HealthCheckName } from '../src/instrumentation/health-check.types';
import { createAuthenticatedApp } from './e2e-utils';

/**
 * Instrumentation-health reads over HTTP (story S7.1, issue #110).
 *
 * The unit spec covers how a verdict becomes a status; this covers the two
 * things only a real request can settle — that the routes are behind the global
 * guard, and that the numbers survive the round trip through Postgres and JSON
 * with `detail.n` still sitting next to its ratio.
 */
describe('Instrumentation health (e2e)', () => {
  let app: NestExpressApplication;
  let authCookie: string;
  let pool: Pool;

  const SUMMARY = '/health/instrumentation';
  const CHECKS = '/health/instrumentation/checks';

  beforeAll(async () => {
    ({ app, authCookie } = await createAuthenticatedApp());
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  describe('without a session', () => {
    it('refuses every route with 401', async () => {
      // Sequential: each supertest call binds its own ephemeral listener on the
      // same http.Server, and concurrent binds produce ECONNRESET.
      const paths = [SUMMARY, CHECKS, `${CHECKS}/plan.orphan_instance/history`];

      for (const path of paths) {
        expect([path, (await http().get(path)).status]).toEqual([path, 401]);
      }
    });
  });

  describe('validation', () => {
    it('rejects a limit outside the allowed range before touching the store', async () => {
      const response = await http()
        .get(`${CHECKS}/plan.orphan_instance/history?limit=5000`)
        .set('Cookie', authCookie);

      expect(response.status).toBe(400);
    });

    it('rejects a limit that is not a number', async () => {
      const response = await http()
        .get(`${CHECKS}/plan.orphan_instance/history?limit=todos`)
        .set('Cookie', authCookie);

      expect(response.status).toBe(400);
    });

    it('rejects an unknown query parameter', async () => {
      // `forbidNonWhitelisted` is global; asserted here because a silently
      // ignored parameter is how a caller comes to believe in a filter that
      // never existed.
      const response = await http()
        .get(`${CHECKS}/plan.orphan_instance/history?offset=10`)
        .set('Cookie', authCookie);

      expect(response.status).toBe(400);
    });

    it('rejects a check name outside the persisted charset', async () => {
      const response = await http()
        .get(`${CHECKS}/${encodeURIComponent('nome com espaço')}/history`)
        .set('Cookie', authCookie);

      expect(response.status).toBe(400);
    });
  });

  describe('with a session', () => {
    beforeEach(async () => {
      await pool.query('TRUNCATE health_checks RESTART IDENTITY');
    });

    it('answers `unknown` before anything has ever been measured', async () => {
      const response = await http()
        .get(SUMMARY)
        .set('Cookie', authCookie)
        .expect(200);

      const body = response.body as {
        status: string;
        stale: boolean;
        total: number;
        lastCheckedAt: string | null;
      };

      // Not `ok`. An empty table means nobody has looked at the game network,
      // and answering `ok` to that is the false confidence ADR-006 targets.
      expect(body.status).toBe('unknown');
      expect(body.stale).toBe(true);
      expect(body.total).toBe(0);
      expect(body.lastCheckedAt).toBeNull();
    });

    it('never caches a health answer', async () => {
      const response = await http().get(SUMMARY).set('Cookie', authCookie);

      expect(response.headers['cache-control']).toBe('no-store');
    });

    it('reports `down` with the scheduler off, however fresh the rows', async () => {
      // `HEALTH_CHECK_ENABLED` is unset in CI, so the cycle is not running.
      // Whatever is stored is a photograph, and how recent it is does not make
      // the layer alive.
      await pool.query(
        `INSERT INTO health_checks (check_name, status, detail) VALUES ($1, 'ok', $2)`,
        [HealthCheckName.OrphanInstance, JSON.stringify({ summary: 'ok' })],
      );

      const response = await http()
        .get(SUMMARY)
        .set('Cookie', authCookie)
        .expect(200);

      const body = response.body as {
        status: string;
        stale: boolean;
        schedule: { enabled: boolean };
        counts: Record<string, number>;
      };

      expect(body.status).toBe('down');
      expect(body.stale).toBe(true);
      expect(body.schedule.enabled).toBe(false);
      expect(body.counts).toEqual({ ok: 1, breached: 0, no_data: 0, error: 0 });
    });

    it('keeps `n` next to the ratio all the way through JSON', async () => {
      // The project rule is that no percentage is published without its base.
      // A serialisation that drops `n` would publish one.
      await pool.query(
        `INSERT INTO health_checks (check_name, status, detail) VALUES ($1, 'breached', $2)`,
        [
          'platform.offline_account_share:AusTv',
          JSON.stringify({
            summary: 'share de java_offline fora da faixa',
            observed: 0.71,
            threshold: 0.45,
            n: 318,
            context: { window: '7d' },
          }),
        ],
      );

      const response = await http()
        .get(CHECKS)
        .set('Cookie', authCookie)
        .expect(200);

      const body = response.body as {
        count: number;
        checks: Array<{
          name: string;
          check: string;
          target: string | null;
          status: string;
          checkedAt: string;
          alertedAt: string | null;
          detail: { observed: number; n: number } | null;
        }>;
      };

      expect(body.count).toBe(1);
      expect(body.checks[0]).toMatchObject({
        name: 'platform.offline_account_share:AusTv',
        check: 'platform.offline_account_share',
        target: 'AusTv',
        status: 'breached',
        alertedAt: null,
      });
      expect(body.checks[0].detail).toMatchObject({ observed: 0.71, n: 318 });
      // The database id means something only inside Postgres.
      expect(body.checks[0]).not.toHaveProperty('id');
      expect(typeof body.checks[0].checkedAt).toBe('string');
    });

    it('returns the history newest first, capped by the limit', async () => {
      // Append-only is the whole point: ADR-006 exists because nobody could
      // answer "since when has this been broken?".
      for (const status of ['ok', 'breached', 'error']) {
        await pool.query(
          `INSERT INTO health_checks (check_name, status, detail) VALUES ($1, $2, $3)`,
          [
            HealthCheckName.CollectionAlive,
            status,
            JSON.stringify({ summary: status }),
          ],
        );
      }

      const response = await http()
        .get(`${CHECKS}/${HealthCheckName.CollectionAlive}/history?limit=2`)
        .set('Cookie', authCookie)
        .expect(200);

      const body = response.body as {
        name: string;
        limit: number;
        count: number;
        entries: Array<{ status: string }>;
      };

      expect(body).toMatchObject({
        name: HealthCheckName.CollectionAlive,
        limit: 2,
        count: 2,
      });
      expect(body.entries.map((entry) => entry.status)).toEqual([
        'error',
        'breached',
      ]);
    });

    it('answers an empty history for a check that never ran, not a 404', async () => {
      // "Never measured" is a real answer and it is not an error. A 404 here
      // would make an unmeasured check indistinguishable from a typo.
      const response = await http()
        .get(`${CHECKS}/funnel.tutorial_entry_rate/history`)
        .set('Cookie', authCookie)
        .expect(200);

      expect(response.body).toMatchObject({
        name: 'funnel.tutorial_entry_rate',
        count: 0,
        entries: [],
      });
    });
  });
});
