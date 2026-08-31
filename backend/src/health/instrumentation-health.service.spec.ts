import type { HealthCheck } from '../instrumentation/health-check.contract';
import { HealthCheckScheduler } from '../instrumentation/health-check.scheduler';
import { HealthCheckStore } from '../instrumentation/health-check.store';
import {
  HealthCheckName,
  type HealthCheckRecord,
  type HealthCheckStatus,
} from '../instrumentation/health-check.types';
import { InstrumentationHealthService } from './instrumentation-health.service';

const NOW = new Date('2026-08-25T12:00:00.000Z');

/** Minutes past `NOW`'s reference, as a timestamp in the past. */
function minutesAgo(minutes: number): Date {
  return new Date(NOW.getTime() - minutes * 60_000);
}

function record(
  checkName: string,
  status: HealthCheckStatus,
  checkedAt: Date = NOW,
  overrides: Partial<HealthCheckRecord> = {},
): HealthCheckRecord {
  return {
    id: 1,
    checkName,
    status,
    checkedAt,
    detail: { summary: `veredito de ${checkName}` },
    alertedAt: null,
    ...overrides,
  };
}

/** A registry entry for a base check name. `run` is never called here. */
function registered(name: string): HealthCheck {
  return { name, run: jest.fn() } as unknown as HealthCheck;
}

/**
 * Registry that exactly matches the fixtures, unless a case says otherwise.
 *
 * The service compares the registry against what the store holds and publishes
 * the difference as `missing`, so a default of "everything in the fixture is
 * registered" keeps each case testing the one thing it is about. The cases that
 * are about `missing` pass their own registry explicitly.
 */
function registryFor(records: readonly HealthCheckRecord[]): HealthCheck[] {
  const names = new Set(
    records.map((record) => record.checkName.split(':')[0]),
  );
  return [...names].map(registered);
}

function build(
  records: HealthCheckRecord[],
  schedule = { enabled: true, intervalMinutes: 15 },
  registry: readonly HealthCheck[] = registryFor(records),
): InstrumentationHealthService {
  // `Pick` rather than a bare cast: the service only touches these two members,
  // and pinning them keeps a signature change failing here instead of compiling
  // into a fake that no longer resembles the real store.
  const store = {
    latestAll: jest.fn().mockResolvedValue(records),
    history: jest.fn().mockResolvedValue(records),
  } satisfies Pick<HealthCheckStore, 'latestAll' | 'history'>;

  const scheduler = { schedule } satisfies Pick<
    HealthCheckScheduler,
    'schedule'
  >;

  return new InstrumentationHealthService(
    store as unknown as HealthCheckStore,
    scheduler as unknown as HealthCheckScheduler,
    registry,
  );
}

describe('InstrumentationHealthService', () => {
  describe('ponto cego aceito', () => {
    /**
     * `funnel.network_to_survival` returns `no_data` every cycle and can never
     * return `ok`: the source for its denominator does not exist anywhere this
     * system reaches. Counted as an ordinary `no_data`, it pinned the aggregate
     * at `degraded` permanently — and a status that cannot move has stopped
     * carrying information, which is this epic's founding disaster wearing a
     * yellow light instead of a green one.
     */
    const BLIND = `${HealthCheckName.NetworkToSurvival}:Survival`;

    it('nao impede o agregado de voltar a `ok`', async () => {
      const service = build([
        record(BLIND, 'no_data'),
        record(HealthCheckName.CollectionAlive, 'ok'),
        record(HealthCheckName.OrphanInstance, 'ok'),
      ]);

      const summary = await service.summary(NOW);

      expect(summary.status).toBe('ok');
    });

    it('nao entra em `counts` nem em `failing`', async () => {
      const service = build([
        record(BLIND, 'no_data'),
        record(HealthCheckName.CollectionAlive, 'ok'),
      ]);

      const summary = await service.summary(NOW);

      expect(summary.counts.no_data).toBe(0);
      expect(summary.failing).toEqual([]);
    });

    it('e publicado por nome em `blindSpots`, nunca omitido', async () => {
      // Dropping it from the payload would be the "absence reads as fine"
      // mistake the whole layer exists to prevent: a reader would see a clean
      // summary and conclude the network degrau is monitored.
      const service = build([
        record(BLIND, 'no_data'),
        record(HealthCheckName.CollectionAlive, 'ok'),
      ]);

      const summary = await service.summary(NOW);

      expect(summary.blindSpots).toEqual([BLIND]);
    });

    it('continua contado em `total` — esta registrado e escrevendo', async () => {
      const service = build([
        record(BLIND, 'no_data'),
        record(HealthCheckName.CollectionAlive, 'ok'),
      ]);

      const summary = await service.summary(NOW);

      expect(summary.total).toBe(2);
    });

    it('nao esconde a degradacao de OUTRO check', async () => {
      // The property that matters most: excluding the blind spot must not turn
      // the aggregate deaf. If it did, this change would have swapped a stuck
      // yellow for a false green, which is strictly worse.
      const service = build([
        record(BLIND, 'no_data'),
        record(HealthCheckName.CollectionAlive, 'no_data'),
      ]);

      const summary = await service.summary(NOW);

      expect(summary.status).toBe('degraded');
      expect(summary.counts.no_data).toBe(1);
    });

    it('ainda envelhece: se parar de escrever, entra em `staleChecks`', async () => {
      // Excluded from the verdict, NOT from the freshness window. A blind spot
      // that stops writing rows has stopped running, which is a different
      // problem and still has to surface.
      const service = build([
        record(BLIND, 'no_data', minutesAgo(120)),
        record(HealthCheckName.CollectionAlive, 'ok'),
      ]);

      const summary = await service.summary(NOW);

      expect(summary.staleChecks).toEqual([BLIND]);
      expect(summary.stale).toBe(true);
    });
  });

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
      // Any check that is NOT an accepted blind spot: those are excluded from
      // `counts` and `failing` on purpose, so one cannot stand in for a generic
      // check here any more.
      const summary = await build([
        record('plan.collection_alive:Survival', 'ok'),
        record('funnel.tutorial_entry_rate', 'breached'),
      ]).summary(NOW);

      expect(summary.status).toBe('degraded');
      expect(summary.failing).toEqual(['funnel.tutorial_entry_rate']);
    });

    it('treats `no_data` as degraded, never as ok', async () => {
      // A collection gap is not a healthy reading. Folding it into `ok` is the
      // exact mistake that kept the tutorial collapse invisible for 8 months.
      //
      // This is the rule the blind-spot exclusion is carved out of, so it is
      // pinned on a check that still obeys it — see the `ponto cego aceito`
      // block for the carve-out, including the case proving it did not turn the
      // aggregate deaf to a second check.
      const summary = await build([
        record('funnel.tutorial_entry_rate', 'no_data'),
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

    it('does NOT let a fresh check mask a silent sibling', async () => {
      // The bug this replaced: staleness came from the newest row across the
      // whole set, so a check that stopped emitting kept its last `ok` forever
      // and any sibling still writing hid it. That is the founding disaster of
      // this epic one level up — the proxy died while everything else kept
      // working.
      const summary = await build([
        record('plan.collection_alive:Survival', 'ok', minutesAgo(90)),
        record('plan.version_divergence', 'ok', NOW),
      ]).summary(NOW);

      expect(summary.status).toBe('down');
      expect(summary.stale).toBe(true);
      expect(summary.staleChecks).toEqual(['plan.collection_alive:Survival']);
      // Both ends published, so the spread is visible instead of collapsed.
      expect(summary.lastCheckedAt).toBe(NOW.toISOString());
      expect(summary.oldestCheckedAt).toBe(minutesAgo(90).toISOString());
    });

    it('reports a registered check that never wrote a verdict', async () => {
      // It cannot appear in `total` or in `counts`, because there is no row —
      // and absence reads as fine. This is the only place it becomes visible.
      const summary = await build(
        [record('plan.collection_alive:Survival', 'ok')],
        { enabled: true, intervalMinutes: 15 },
        [
          registered(HealthCheckName.CollectionAlive),
          registered(HealthCheckName.VersionDivergence),
        ],
      ).summary(NOW);

      expect(summary.missing).toEqual([HealthCheckName.VersionDivergence]);
      expect(summary.status).toBe('degraded');
      // Not folded into `failing`: "never measured" and "measured and bad" are
      // different problems with different fixes.
      expect(summary.failing).toEqual([]);
    });

    it('escalates to `down` once more of the registry is silent than reporting', async () => {
      // The asymmetry this corrects: a check that ran once and went quiet makes
      // the layer `down`, while one that NEVER ran was only `degraded` — even
      // though it is strictly worse, being blind since day one with no baseline.
      // The line is a strict majority so an unconfigured staging box does not
      // sit permanently red.
      const summary = await build(
        [record('plan.collection_alive:Survival', 'ok')],
        { enabled: true, intervalMinutes: 15 },
        [
          registered(HealthCheckName.CollectionAlive),
          registered(HealthCheckName.VersionDivergence),
          registered(HealthCheckName.OrphanInstance),
        ],
      ).summary(NOW);

      expect(summary.missing).toHaveLength(2);
      expect(summary.status).toBe('down');
      // Still not a failure of measurement — the one check that runs is fine.
      expect(summary.stale).toBe(false);
      expect(summary.failing).toEqual([]);
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

    it('marks the individual check that went silent', async () => {
      // The summary says the layer is stale; this says WHICH one, which is the
      // difference between an alert and an investigation.
      const { checks } = await build([
        record('plan.collection_alive:Survival', 'ok', minutesAgo(90)),
        record('plan.version_divergence', 'ok', NOW),
      ]).checks(NOW);

      const byName = new Map(checks.map((check) => [check.name, check.stale]));

      expect(byName.get('plan.collection_alive:Survival')).toBe(true);
      expect(byName.get('plan.version_divergence')).toBe(false);
    });

    it('round-trips an announced verdict and a null detail', async () => {
      // `alertedAt` non-null and `detail` null are the two nullable branches of
      // the mapping, and both are contract fields.
      const alertedAt = minutesAgo(3);
      const { checks } = await build([
        record('plan.version_divergence', 'breached', NOW, {
          alertedAt,
          detail: null,
        }),
      ]).checks(NOW);

      expect(checks[0].alertedAt).toBe(alertedAt.toISOString());
      expect(checks[0].detail).toBeNull();
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
