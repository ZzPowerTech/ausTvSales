import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import * as schema from '../src/db/schema';
import { HealthCheckStore } from '../src/instrumentation/health-check.store';
import {
  HealthCheckName,
  scopedCheckName,
} from '../src/instrumentation/health-check.types';

/**
 * Integration test for the `health_checks` table and its store (story S6.3).
 *
 * Runs the real migrations against a real PostgreSQL (docker-compose locally,
 * `services.postgres` in CI) because the properties that matter here live in the
 * database, not in TypeScript: the append-only history, the `DISTINCT ON`
 * that resolves "current state", and the check constraint that keeps a
 * collection gap from ever being stored as a healthy reading.
 */
describe('health_checks (e2e)', () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let store: HealthCheckStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: './drizzle' });
    store = new HealthCheckStore(db);
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE health_checks RESTART IDENTITY');
  });

  afterAll(async () => {
    await pool.end();
  });

  it('creates the table with the columns of spec §7', async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'health_checks'`,
    );

    expect(rows.map((r) => r.column_name).sort()).toEqual([
      'alerted_at',
      'check_name',
      'checked_at',
      'detail',
      'id',
      'status',
    ]);
  });

  it('stamps checked_at from the database and leaves alerted_at null', async () => {
    const before = new Date();
    const [record] = await store.record([
      {
        checkName: HealthCheckName.OrphanInstance,
        status: 'ok',
        detail: { summary: 'todas as instancias com dado recente' },
      },
    ]);

    expect(record.checkedAt.getTime()).toBeGreaterThanOrEqual(
      before.getTime() - 1000,
    );
    expect(record.alertedAt).toBeNull();
  });

  it('is append-only: a second run of the same check keeps the first', async () => {
    // ADR-006 exists because nobody could answer "since when has this been
    // broken?". Overwriting the previous verdict would keep it unanswerable.
    await store.record([
      {
        checkName: HealthCheckName.TutorialEntryRate,
        status: 'ok',
        detail: { summary: 'taxa saudavel', observed: 0.98, n: 120 },
      },
    ]);
    await store.record([
      {
        checkName: HealthCheckName.TutorialEntryRate,
        status: 'breached',
        detail: { summary: 'taxa abaixo do piso', observed: 0.12, n: 87 },
      },
    ]);

    const history = await store.history(HealthCheckName.TutorialEntryRate);

    expect(history).toHaveLength(2);
    expect(history[0].status).toBe('breached');
    expect(history[1].status).toBe('ok');
  });

  it('rejects a status outside the four known states', async () => {
    // The guard is in the database, not only in TypeScript: a future caller
    // bypassing the store must not be able to invent a state.
    await expect(
      pool.query(
        `INSERT INTO health_checks (check_name, status) VALUES ($1, $2)`,
        ['plan.orphan_instance', 'healthy'],
      ),
    ).rejects.toThrow(/health_checks_status_valid/);
  });

  it('stores no_data as itself, never as ok and never as a zero reading', async () => {
    const [record] = await store.record([
      {
        checkName: HealthCheckName.NetworkToSurvival,
        status: 'no_data',
        detail: { summary: 'sem coleta na janela' },
      },
    ]);

    const reread = await store.latest(HealthCheckName.NetworkToSurvival);

    expect(record.status).toBe('no_data');
    expect(reread?.status).toBe('no_data');
    // A gap must not arrive downstream as a measured zero.
    expect(reread?.detail?.observed).toBeUndefined();
  });

  it('round-trips the structured detail, keeping n next to the ratio', async () => {
    await store.record([
      {
        checkName: HealthCheckName.OfflineAccountShare,
        status: 'breached',
        detail: {
          summary: 'share de java_offline fora da faixa',
          observed: 0.71,
          threshold: 0.45,
          n: 318,
          context: { window: '30d' },
        },
      },
    ]);

    const record = await store.latest(HealthCheckName.OfflineAccountShare);

    expect(record?.detail).toEqual({
      summary: 'share de java_offline fora da faixa',
      observed: 0.71,
      threshold: 0.45,
      n: 318,
      context: { window: '30d' },
    });
  });

  describe('latestAll', () => {
    it('returns exactly one row per check, the newest', async () => {
      await store.record([
        {
          checkName: HealthCheckName.VersionDivergence,
          status: 'ok',
          detail: { summary: 'builds iguais' },
        },
        {
          checkName: HealthCheckName.OrphanInstance,
          status: 'ok',
          detail: { summary: 'ok' },
        },
      ]);
      await store.record([
        {
          checkName: HealthCheckName.VersionDivergence,
          status: 'breached',
          detail: { summary: 'b2959 x b2965' },
        },
      ]);

      const current = await store.latestAll();

      expect(current).toHaveLength(2);
      const byName = new Map(current.map((r) => [r.checkName, r]));
      expect(byName.get(HealthCheckName.VersionDivergence)?.status).toBe(
        'breached',
      );
      expect(byName.get(HealthCheckName.OrphanInstance)?.status).toBe('ok');
    });

    it('resolves ties on id when two rows share checked_at', async () => {
      // Rows written in the same batch share `now()` inside one statement, so
      // without the id tiebreak the "current" verdict would be arbitrary.
      await pool.query(
        `INSERT INTO health_checks (check_name, status, checked_at) VALUES
           ($1, 'ok',       '2026-08-22T03:00:00Z'),
           ($1, 'breached', '2026-08-22T03:00:00Z')`,
        [HealthCheckName.CollectionAlive],
      );

      const [current] = await store.latestAll();

      expect(current.status).toBe('breached');
    });

    it('keeps per-target checks apart as distinct identities', async () => {
      const survival = scopedCheckName(
        HealthCheckName.CollectionAlive,
        'survival',
      );
      const proxy = scopedCheckName(HealthCheckName.CollectionAlive, 'proxy');

      await store.record([
        { checkName: survival, status: 'ok', detail: { summary: 'coletando' } },
        {
          checkName: proxy,
          status: 'breached',
          detail: { summary: 'sem sessao nova em 6h' },
        },
      ]);

      const current = await store.latestAll();
      const byName = new Map(current.map((r) => [r.checkName, r.status]));

      expect(current).toHaveLength(2);
      expect(byName.get(survival)).toBe('ok');
      expect(byName.get(proxy)).toBe('breached');
    });
  });

  describe('alert bookkeeping', () => {
    it('marks only the given rows and reports the count', async () => {
      const records = await store.record([
        {
          checkName: HealthCheckName.VersionDivergence,
          status: 'breached',
          detail: { summary: 'divergiu' },
        },
        {
          checkName: HealthCheckName.OrphanInstance,
          status: 'ok',
          detail: { summary: 'ok' },
        },
      ]);

      const updated = await store.markAlerted([records[0].id]);

      expect(updated).toBe(1);
      expect(
        (await store.latest(HealthCheckName.VersionDivergence))?.alertedAt,
      ).not.toBeNull();
      expect(
        (await store.latest(HealthCheckName.OrphanInstance))?.alertedAt,
      ).toBeNull();
    });

    it('lastAlert ignores rows that were never announced', async () => {
      const [first] = await store.record([
        {
          checkName: HealthCheckName.CollectionAlive,
          status: 'breached',
          detail: { summary: 'primeira falha' },
        },
      ]);
      await store.markAlerted([first.id]);

      // A later failing run that was grouped away, so never announced.
      await store.record([
        {
          checkName: HealthCheckName.CollectionAlive,
          status: 'breached',
          detail: { summary: 'ainda falhando' },
        },
      ]);

      const lastAlert = await store.lastAlert(HealthCheckName.CollectionAlive);
      const latest = await store.latest(HealthCheckName.CollectionAlive);

      expect(lastAlert).not.toBeNull();
      expect(latest?.alertedAt).toBeNull();
      expect(latest?.id).not.toBe(first.id);
    });

    it('returns null for a check that has never been announced', async () => {
      await store.record([
        {
          checkName: HealthCheckName.NetworkToSurvival,
          status: 'ok',
          detail: { summary: 'ok' },
        },
      ]);

      await expect(
        store.lastAlert(HealthCheckName.NetworkToSurvival),
      ).resolves.toBeNull();
    });
  });
});
