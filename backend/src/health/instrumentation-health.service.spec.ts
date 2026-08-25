import { HealthCheckScheduler } from '../instrumentation/health-check.scheduler';
import { HealthCheckStore } from '../instrumentation/health-check.store';
import type {
  HealthCheckRecord,
  HealthCheckStatus,
} from '../instrumentation/health-check.types';
import { InstrumentationHealthService } from './instrumentation-health.service';

const NOW = new Date('2026-08-25T12:00:00.000Z');

function record(
  checkName: string,
  status: HealthCheckStatus,
  checkedAt: Date = NOW,
): HealthCheckRecord {
  return {
    id: 1,
    checkName,
    status,
    checkedAt,
    detail: { summary: `veredito de ${checkName}` },
    alertedAt: null,
  };
}

function build(
  records: HealthCheckRecord[],
  schedule = { enabled: true, intervalMinutes: 15 },
): InstrumentationHealthService {
  const store = {
    latestAll: jest.fn().mockResolvedValue(records),
    history: jest.fn().mockResolvedValue(records),
  } as unknown as HealthCheckStore;

  const scheduler = { schedule } as unknown as HealthCheckScheduler;

  return new InstrumentationHealthService(store, scheduler);
}

describe('InstrumentationHealthService', () => {
  describe('summary', () => {
    it('answers `unknown` when no check has ever run', async () => {
      // The whole point of the four-value status. `ok` here would be an
      // assertion about a game network nobody has looked at.
      const summary = await build([]).summary(NOW);

      expect(summary.status).toBe('unknown');
      expect(summary.stale).toBe(true);
      expect(summary.lastCheckedAt).toBeNull();
      expect(summary.total).toBe(0);
    });

    it('answers `ok` when the cycle is alive and every check passes', async () => {
      const summary = await build([
        record('plan.collection_alive:Survival', 'ok'),
        record('plan.version_divergence', 'ok'),
      ]).summary(NOW);

      expect(summary.status).toBe('ok');
      expect(summary.stale).toBe(false);
      expect(summary.failing).toEqual([]);
      expect(summary.counts).toEqual({
        ok: 2,
        breached: 0,
        no_data: 0,
        error: 0,
      });
    });

    it('answers `degraded` for a breached check, naming it', async () => {
      const summary = await build([
        record('plan.collection_alive:Survival', 'ok'),
        record('funnel.network_to_survival', 'breached'),
      ]).summary(NOW);

      expect(summary.status).toBe('degraded');
      expect(summary.failing).toEqual(['funnel.network_to_survival']);
    });

    it('treats `no_data` as degraded, never as ok', async () => {
      // A collection gap is not a healthy reading. Folding it into `ok` is the
      // exact mistake that kept the tutorial collapse invisible for 8 months.
      const summary = await build([
        record('funnel.network_to_survival', 'no_data'),
      ]).summary(NOW);

      expect(summary.status).toBe('degraded');
    });

    it('answers `down` when a check could not reach its source', async () => {
      // `error` outranks `breached`: "we cannot measure" is worse than "we
      // measured something bad", because the second is still information.
      const summary = await build([
        record('plan.collection_alive:Survival', 'error'),
        record('funnel.network_to_survival', 'breached'),
      ]).summary(NOW);

      expect(summary.status).toBe('down');
    });

    it('answers `down` when the newest verdict is older than the tolerance', async () => {
      const stale = new Date(NOW.getTime() - 31 * 60_000); // 31 min, interval 15

      const summary = await build([
        record('plan.collection_alive:Survival', 'ok', stale),
      ]).summary(NOW);

      expect(summary.status).toBe('down');
      expect(summary.stale).toBe(true);
      expect(summary.schedule.staleAfterMinutes).toBe(30);
    });

    it('tolerates one missed cycle', async () => {
      // A single skipped tick is normal — the runner stands down while a slow
      // Plan is still answering the previous cycle. Alerting on that trains the
      // operator to ignore this endpoint.
      const oneMissed = new Date(NOW.getTime() - 20 * 60_000);

      const summary = await build([
        record('plan.collection_alive:Survival', 'ok', oneMissed),
      ]).summary(NOW);

      expect(summary.status).toBe('ok');
      expect(summary.stale).toBe(false);
    });

    it('answers `down` when the scheduler is switched off, however fresh the rows', async () => {
      // Nothing is running, so what is stored is a photograph of the past. How
      // recent the photograph is does not make the layer alive.
      const summary = await build(
        [record('plan.collection_alive:Survival', 'ok')],
        {
          enabled: false,
          intervalMinutes: 15,
        },
      ).summary(NOW);

      expect(summary.status).toBe('down');
      expect(summary.stale).toBe(true);
      expect(summary.schedule.enabled).toBe(false);
    });

    it('reports the newest timestamp across checks, not the first row', async () => {
      const older = new Date(NOW.getTime() - 5 * 60_000);

      const summary = await build([
        record('a', 'ok', older),
        record('b', 'ok', NOW),
      ]).summary(NOW);

      expect(summary.lastCheckedAt).toBe(NOW.toISOString());
    });
  });

  describe('checks', () => {
    it('splits a scoped name into check and target', async () => {
      const { checks } = await build([
        record('plan.collection_alive:Survival', 'ok'),
      ]).checks();

      expect(checks[0]).toMatchObject({
        name: 'plan.collection_alive:Survival',
        check: 'plan.collection_alive',
        target: 'Survival',
      });
    });

    it('leaves target null for a global check', async () => {
      const { checks } = await build([
        record('plan.version_divergence', 'ok'),
      ]).checks();

      expect(checks[0].target).toBeNull();
    });

    it('orders by name so a diff between polls means a change of state', async () => {
      const { checks, count } = await build([
        record('z.check', 'ok'),
        record('a.check', 'ok'),
      ]).checks();

      expect(count).toBe(2);
      expect(checks.map((check) => check.name)).toEqual(['a.check', 'z.check']);
    });

    it('publishes no Date object — the contract is ISO strings', async () => {
      const { checks } = await build([record('a.check', 'ok')]).checks();

      expect(typeof checks[0].checkedAt).toBe('string');
      expect(checks[0].checkedAt).toBe(NOW.toISOString());
      expect(checks[0].alertedAt).toBeNull();
      // A row id means something only inside Postgres and must not leak.
      expect(checks[0]).not.toHaveProperty('id');
    });
  });

  describe('history', () => {
    it('echoes the check and the applied limit back', async () => {
      const history = await build([record('a.check', 'ok')]).history(
        'a.check',
        10,
      );

      expect(history).toMatchObject({ name: 'a.check', limit: 10, count: 1 });
    });
  });
});
