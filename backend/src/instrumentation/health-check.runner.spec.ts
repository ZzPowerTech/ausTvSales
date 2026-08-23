import { ConfigService } from '@nestjs/config';
import type { AlertDecision } from './alert-policy';
import type { DiscordAlerter } from './discord-alerter';
import type { HealthCheck } from './health-check.contract';
import { HealthCheckRunner } from './health-check.runner';
import type {
  HealthCheckObservation,
  HealthCheckStore,
} from './health-check.store';
import {
  HealthCheckName,
  type HealthCheckRecord,
  type HealthCheckStatus,
} from './health-check.types';

/** Order in which the runner touched the store — the ordering is load-bearing. */
let calls: string[];

function observation(
  checkName: string,
  status: HealthCheckStatus = 'ok',
): HealthCheckObservation {
  return { checkName, status, detail: { summary: 'teste' } };
}

function asRecord(
  observation: HealthCheckObservation,
  id: number,
): HealthCheckRecord {
  return {
    id,
    checkName: observation.checkName,
    status: observation.status,
    checkedAt: new Date('2026-08-23T12:00:00Z'),
    detail: observation.detail,
    alertedAt: null,
  };
}

interface StoreStub {
  store: HealthCheckStore;
  latestAll: jest.Mock;
  record: jest.Mock;
  lastAlertAt: jest.Mock;
  markAlerted: jest.Mock;
}

function buildStore(previous: HealthCheckRecord[] = []): StoreStub {
  const latestAll = jest.fn(() => {
    calls.push('latestAll');
    return Promise.resolve(previous);
  });
  const record = jest.fn((observations: HealthCheckObservation[]) => {
    calls.push('record');
    return Promise.resolve(observations.map(asRecord));
  });
  const lastAlertAt = jest.fn(() => Promise.resolve(null));
  const markAlerted = jest.fn((ids: number[]) => {
    calls.push('markAlerted');
    return Promise.resolve(ids.length);
  });

  return {
    store: {
      latestAll,
      record,
      lastAlertAt,
      markAlerted,
    } as unknown as HealthCheckStore,
    latestAll,
    record,
    lastAlertAt,
    markAlerted,
  };
}

function buildAlerter(delivered: number[] = []): {
  alerter: DiscordAlerter;
  publish: jest.Mock;
} {
  const publish = jest.fn(() => {
    calls.push('publish');
    return Promise.resolve(delivered);
  });
  return { alerter: { publish } as unknown as DiscordAlerter, publish };
}

function config(values: Record<string, unknown> = {}): ConfigService {
  return {
    get: <T>(key: string): T | undefined => values[key] as T | undefined,
  } as unknown as ConfigService;
}

function fakeCheck(
  name: string,
  run: () => Promise<HealthCheckObservation[]>,
): HealthCheck {
  return { name: name as HealthCheckName, run };
}

/**
 * First argument of the first recorded call, through a declared tuple type.
 *
 * `jest.Mock` without generics types `mock.calls` as `any[]`; indexing it
 * directly would silently disable type checking on every assertion built from
 * the result.
 */
function firstArg<T>(mock: jest.Mock): T {
  return (mock.mock.calls as unknown as Array<[T]>)[0][0];
}

describe('HealthCheckRunner', () => {
  beforeEach(() => {
    calls = [];
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('ordering', () => {
    it('reads the previous state BEFORE persisting the new verdicts', async () => {
      const store = buildStore();
      const { alerter } = buildAlerter();
      const check = fakeCheck(HealthCheckName.OrphanInstance, () =>
        Promise.resolve([observation('plan.orphan_instance', 'breached')]),
      );

      await new HealthCheckRunner(store.store, alerter, config(), [
        check,
      ]).runAll();

      // If the snapshot were taken after the insert, `latestAll` would return the
      // rows this cycle just wrote, every check would look unchanged, no
      // transition would ever fire, and the system would go silent while
      // appearing healthy.
      expect(calls.indexOf('latestAll')).toBeLessThan(calls.indexOf('record'));
    });

    it('stamps alerted_at only after the alerter reports delivery', async () => {
      const store = buildStore();
      const { alerter } = buildAlerter([1]);
      const check = fakeCheck(HealthCheckName.OrphanInstance, () =>
        Promise.resolve([observation('plan.orphan_instance', 'breached')]),
      );

      await new HealthCheckRunner(store.store, alerter, config(), [
        check,
      ]).runAll();

      // Stamping before the webhook succeeds would suppress the retry and lose
      // the alert permanently.
      expect(calls.indexOf('publish')).toBeLessThan(
        calls.indexOf('markAlerted'),
      );
    });

    it('passes exactly the delivered ids to markAlerted', async () => {
      const store = buildStore();
      const { alerter } = buildAlerter([2]);
      const check = fakeCheck(HealthCheckName.OrphanInstance, () =>
        Promise.resolve([
          observation('a', 'breached'),
          observation('b', 'breached'),
        ]),
      );

      await new HealthCheckRunner(store.store, alerter, config(), [
        check,
      ]).runAll();

      expect(store.markAlerted).toHaveBeenCalledWith([2]);
    });
  });

  describe('isolamento de falha de check', () => {
    it('turns a thrown check into an error observation', async () => {
      const store = buildStore();
      const { alerter } = buildAlerter();
      const boom = fakeCheck(HealthCheckName.CollectionAlive, () =>
        Promise.reject(new Error('Plan inalcancavel')),
      );

      const summary = await new HealthCheckRunner(
        store.store,
        alerter,
        config(),
        [boom],
      ).runAll();

      expect(summary.byStatus.error).toBe(1);
      const recorded = firstArg<HealthCheckObservation[]>(store.record);
      expect(recorded[0].status).toBe('error');
      expect(recorded[0].detail.summary).toContain('Plan inalcancavel');
    });

    it('keeps running the other checks after one throws', async () => {
      const store = buildStore();
      const { alerter } = buildAlerter();
      const boom = fakeCheck(HealthCheckName.CollectionAlive, () =>
        Promise.reject(new Error('falhou')),
      );
      const fine = fakeCheck(HealthCheckName.OrphanInstance, () =>
        Promise.resolve([observation('plan.orphan_instance', 'ok')]),
      );

      // One broken check must never silence the other six — that would be the
      // blindness this epic exists to remove.
      const summary = await new HealthCheckRunner(
        store.store,
        alerter,
        config(),
        [boom, fine],
      ).runAll();

      expect(summary.observations).toBe(2);
      expect(summary.byStatus.error).toBe(1);
      expect(summary.byStatus.ok).toBe(1);
    });

    it('records a check that returns no observations without inventing a row', async () => {
      const store = buildStore();
      const { alerter } = buildAlerter();
      const empty = fakeCheck(HealthCheckName.OrphanInstance, () =>
        Promise.resolve([]),
      );

      const summary = await new HealthCheckRunner(
        store.store,
        alerter,
        config(),
        [empty],
      ).runAll();

      // "Nothing to evaluate" is not a verdict. Manufacturing an `ok` here would
      // be exactly the invented measurement the contract forbids.
      expect(summary.observations).toBe(0);
      expect(store.record).not.toHaveBeenCalled();
    });
  });

  describe('guarda de ciclo sobreposto', () => {
    it('stands down when a previous cycle is still running', async () => {
      const store = buildStore();
      const { alerter } = buildAlerter();
      let release!: () => void;
      const slow = fakeCheck(
        HealthCheckName.CollectionAlive,
        () =>
          new Promise((resolve) => {
            release = () => resolve([observation('slow', 'ok')]);
          }),
      );
      const runner = new HealthCheckRunner(store.store, alerter, config(), [
        slow,
      ]);

      const first = runner.runAll();
      const second = await runner.runAll();

      expect(second.ran).toBe(false);
      expect(second.observations).toBe(0);

      release();
      await first;
    });

    it('releases the guard even when the cycle throws', async () => {
      const store = buildStore();
      store.latestAll.mockRejectedValueOnce(new Error('banco fora'));
      const { alerter } = buildAlerter();
      const check = fakeCheck(HealthCheckName.OrphanInstance, () =>
        Promise.resolve([observation('x', 'ok')]),
      );
      const runner = new HealthCheckRunner(store.store, alerter, config(), [
        check,
      ]);

      await expect(runner.runAll()).rejects.toThrow('banco fora');

      // A stuck flag would silence every future cycle — the worst possible
      // outcome for a system whose job is to notice silence.
      const after = await runner.runAll();
      expect(after.ran).toBe(true);
    });
  });

  describe('resumo', () => {
    it('tallies every status and reports what was delivered', async () => {
      const previous: HealthCheckRecord[] = [];
      const store = buildStore(previous);
      const { alerter, publish } = buildAlerter([1, 2]);
      const check = fakeCheck(HealthCheckName.CollectionAlive, () =>
        Promise.resolve([
          observation('a', 'breached'),
          observation('b', 'error'),
          observation('c', 'no_data'),
          observation('d', 'ok'),
        ]),
      );

      const summary = await new HealthCheckRunner(
        store.store,
        alerter,
        config(),
        [check],
      ).runAll();

      expect(summary.ran).toBe(true);
      expect(summary.observations).toBe(4);
      expect(summary.byStatus).toEqual({
        ok: 1,
        breached: 1,
        no_data: 1,
        error: 1,
      });
      expect(summary.alerted).toBe(2);

      const decision = firstArg<AlertDecision>(publish);
      // breached and error both notify; ok and no_data do not.
      expect(decision.announce).toHaveLength(2);
    });
  });

  describe('configuracao de re-alerta', () => {
    it('converts HEALTH_ALERT_REALERT_HOURS into the policy window', async () => {
      const store = buildStore();
      const { alerter, publish } = buildAlerter();
      const check = fakeCheck(HealthCheckName.OrphanInstance, () =>
        Promise.resolve([observation('a', 'breached')]),
      );

      await new HealthCheckRunner(
        store.store,
        alerter,
        config({ HEALTH_ALERT_REALERT_HOURS: 3 }),
        [check],
      ).runAll();

      expect(publish).toHaveBeenCalled();
    });
  });
});
