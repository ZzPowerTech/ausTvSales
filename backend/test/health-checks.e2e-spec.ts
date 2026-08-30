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

  describe('alertsInWindow', () => {
    const DAY_MS = 86_400_000;

    it('conta so o que foi entregue, nao o que foi apenas medido', async () => {
      const check = scopedCheckName(HealthCheckName.OrphanInstance, 'budget');
      const rows = await store.record([
        { checkName: check, status: 'breached', detail: { summary: 'um' } },
        { checkName: check, status: 'breached', detail: { summary: 'dois' } },
        { checkName: check, status: 'breached', detail: { summary: 'tres' } },
      ]);
      await store.markAlerted([rows[0].id, rows[1].id]);

      // Tres vereditos, duas mensagens. O orcamento e gasto pelo que o canal
      // ouviu, nao pelo que a tabela guardou.
      await expect(store.alertsInWindow(check, DAY_MS)).resolves.toBe(2);
    });

    it('nao conta a mensagem de outro check', async () => {
      const mine = scopedCheckName(HealthCheckName.OrphanInstance, 'mine');
      const other = scopedCheckName(HealthCheckName.OrphanInstance, 'other');
      const rows = await store.record([
        { checkName: mine, status: 'breached', detail: { summary: 'meu' } },
        { checkName: other, status: 'breached', detail: { summary: 'dele' } },
      ]);
      await store.markAlerted(rows.map((row) => row.id));

      await expect(store.alertsInWindow(mine, DAY_MS)).resolves.toBe(1);
    });

    it('ignora o que caiu fora da janela', async () => {
      const check = scopedCheckName(HealthCheckName.OrphanInstance, 'expired');
      const [row] = await store.record([
        { checkName: check, status: 'breached', detail: { summary: 'velho' } },
      ]);
      await store.markAlerted([row.id]);

      // Janela de um milissegundo: a mensagem acabou de sair e ja esta fora.
      await expect(store.alertsInWindow(check, 1)).resolves.toBe(0);
    });

    it('devolve zero para um check que nunca falou', async () => {
      const check = scopedCheckName(HealthCheckName.OrphanInstance, 'quiet');
      await store.record([
        { checkName: check, status: 'ok', detail: { summary: 'ok' } },
      ]);

      await expect(store.alertsInWindow(check, DAY_MS)).resolves.toBe(0);
    });
  });

  describe('healthyStreak', () => {
    // A unica cobertura que executa a query de janela de verdade. O unit spec
    // dela mocka o `db.execute` e monta as linhas ja ordenadas, entao valida o
    // laco em JS, nao o SQL — um erro no PARTITION BY ou no `rn <= window` nao
    // seria pego por nada sem este teste.

    /** Grava vereditos em sequencia, um por chamada, do mais antigo ao mais novo. */
    async function sequence(
      checkName: string,
      statuses: ReadonlyArray<'ok' | 'breached' | 'no_data' | 'error'>,
    ): Promise<void> {
      for (const status of statuses) {
        await store.record([
          { checkName, status, detail: { summary: `verdito ${status}` } },
        ]);
      }
    }

    it('conta os ok consecutivos e para no primeiro veredito ruim', async () => {
      const check = scopedCheckName(HealthCheckName.CollectionAlive, 'streak');
      await sequence(check, ['ok', 'breached', 'ok', 'ok']);

      const streaks = await store.healthyStreak();

      expect(streaks.get(check)).toBe(2);
    });

    it('trata no_data como quebra de sequencia, nao como ok', async () => {
      const check = scopedCheckName(HealthCheckName.CollectionAlive, 'gap');
      await sequence(check, ['ok', 'no_data', 'ok']);

      expect((await store.healthyStreak()).get(check)).toBe(1);
    });

    it('omite o check cujo veredito mais recente nao e ok', async () => {
      const check = scopedCheckName(HealthCheckName.CollectionAlive, 'down');
      await sequence(check, ['ok', 'ok', 'breached']);

      expect((await store.healthyStreak()).has(check)).toBe(false);
    });

    it('satura na janela pedida e mantem os checks independentes', async () => {
      const capped = scopedCheckName(HealthCheckName.OrphanInstance, 'capped');
      const other = scopedCheckName(HealthCheckName.OrphanInstance, 'other');
      await sequence(capped, ['ok', 'ok', 'ok', 'ok']);
      await sequence(other, ['error']);

      const streaks = await store.healthyStreak(2);

      // A saturacao e o motivo de o runner passar o proprio limiar como janela:
      // uma janela menor que o limiar jamais o satisfaria.
      expect(streaks.get(capped)).toBe(2);
      expect(streaks.has(other)).toBe(false);
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
