import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { HealthCheckRunner } from './health-check.runner';
import { HealthCheckScheduler } from './health-check.scheduler';

function config(values: Record<string, unknown>): ConfigService {
  return {
    get: <T>(key: string): T | undefined => values[key] as T | undefined,
  } as unknown as ConfigService;
}

function buildRunner(): { runner: HealthCheckRunner; runAll: jest.Mock } {
  const runAll = jest.fn(() => Promise.resolve({}));
  return { runner: { runAll } as unknown as HealthCheckRunner, runAll };
}

function buildRegistry(): {
  registry: SchedulerRegistry;
  addInterval: jest.Mock;
} {
  const addInterval = jest.fn();
  return {
    registry: { addInterval } as unknown as SchedulerRegistry,
    addInterval,
  };
}

const ENABLED = { HEALTH_CHECK_ENABLED: true };

describe('HealthCheckScheduler', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('opt-in', () => {
    it('registers no timer when disabled', () => {
      const { runner, runAll } = buildRunner();
      const { registry, addInterval } = buildRegistry();

      new HealthCheckScheduler(runner, registry, config({})).onModuleInit();

      expect(addInterval).not.toHaveBeenCalled();
      jest.advanceTimersByTime(60 * 60_000);
      expect(runAll).not.toHaveBeenCalled();
    });

    it('warns loudly when disabled', () => {
      const { runner } = buildRunner();
      const { registry } = buildRegistry();
      const scheduler = new HealthCheckScheduler(runner, registry, config({}));
      const warn = jest
        .spyOn(scheduler['logger'], 'warn')
        .mockImplementation(() => undefined);

      scheduler.onModuleInit();

      // A health layer that silently does not run manufactures exactly the
      // confidence ADR-006 exists to destroy, so being off is announced rather
      // than inferred from an absence of alerts.
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('NAO vao rodar'),
      );
    });

    it('registers the interval when enabled', () => {
      const { runner } = buildRunner();
      const { registry, addInterval } = buildRegistry();

      new HealthCheckScheduler(
        runner,
        registry,
        config(ENABLED),
      ).onModuleInit();

      expect(addInterval).toHaveBeenCalledWith(
        'instrumentation-health',
        expect.anything(),
      );
    });
  });

  describe('cadencia', () => {
    it('does not run at boot', () => {
      const { runner, runAll } = buildRunner();
      const { registry } = buildRegistry();

      new HealthCheckScheduler(
        runner,
        registry,
        config(ENABLED),
      ).onModuleInit();

      // Running immediately would evaluate a Plan that may still be starting; a
      // simultaneous restart of both machines would breach every check at once.
      expect(runAll).not.toHaveBeenCalled();
    });

    it('runs once per configured interval', () => {
      const { runner, runAll } = buildRunner();
      const { registry } = buildRegistry();

      new HealthCheckScheduler(
        runner,
        registry,
        config({ ...ENABLED, HEALTH_CHECK_INTERVAL_MINUTES: 5 }),
      ).onModuleInit();

      jest.advanceTimersByTime(5 * 60_000);
      expect(runAll).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(10 * 60_000);
      expect(runAll).toHaveBeenCalledTimes(3);
    });

    it('defaults to 15 minutes', () => {
      const { runner, runAll } = buildRunner();
      const { registry } = buildRegistry();

      new HealthCheckScheduler(
        runner,
        registry,
        config(ENABLED),
      ).onModuleInit();

      jest.advanceTimersByTime(14 * 60_000);
      expect(runAll).not.toHaveBeenCalled();

      jest.advanceTimersByTime(1 * 60_000);
      expect(runAll).toHaveBeenCalledTimes(1);
    });
  });

  describe('resiliencia', () => {
    it('survives a cycle that rejects, and keeps scheduling', async () => {
      const runAll = jest
        .fn()
        .mockRejectedValueOnce(new Error('banco fora'))
        .mockResolvedValue({});
      const runner = { runAll } as unknown as HealthCheckRunner;
      const { registry } = buildRegistry();
      const scheduler = new HealthCheckScheduler(
        runner,
        registry,
        config({ ...ENABLED, HEALTH_CHECK_INTERVAL_MINUTES: 1 }),
      );
      jest
        .spyOn(scheduler['logger'], 'error')
        .mockImplementation(() => undefined);

      scheduler.onModuleInit();

      jest.advanceTimersByTime(60_000);
      // Let the rejected promise settle inside the timer callback.
      await Promise.resolve();
      await Promise.resolve();

      jest.advanceTimersByTime(60_000);
      // An unhandled rejection in a timer callback takes the Node process down,
      // turning a transient blip into an outage of the system meant to notice
      // outages.
      expect(runAll).toHaveBeenCalledTimes(2);
    });

    it('logs the failure instead of staying quiet', async () => {
      const runAll = jest.fn().mockRejectedValue(new Error('banco fora'));
      const runner = { runAll } as unknown as HealthCheckRunner;
      const { registry } = buildRegistry();
      const scheduler = new HealthCheckScheduler(
        runner,
        registry,
        config({ ...ENABLED, HEALTH_CHECK_INTERVAL_MINUTES: 1 }),
      );
      const error = jest
        .spyOn(scheduler['logger'], 'error')
        .mockImplementation(() => undefined);

      scheduler.onModuleInit();
      jest.advanceTimersByTime(60_000);
      await Promise.resolve();
      await Promise.resolve();

      expect(error).toHaveBeenCalledWith(expect.stringContaining('banco fora'));
    });
  });
});
