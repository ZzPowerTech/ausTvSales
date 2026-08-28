import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { TutorialSyncScheduler } from './tutorial-sync.scheduler';
import type { TutorialSyncService } from './tutorial-sync.service';

function configWith(values: Record<string, unknown>): ConfigService {
  return {
    get: <T>(key: string): T | undefined => values[key] as T | undefined,
  } as unknown as ConfigService;
}

function syncDouble(configured = true): TutorialSyncService {
  return {
    configured,
    sync: jest.fn().mockResolvedValue({ status: 'ok' }),
  } as unknown as TutorialSyncService;
}

function build(
  values: Record<string, unknown>,
  configured = true,
): { scheduler: TutorialSyncScheduler; registry: SchedulerRegistry } {
  const registry = new SchedulerRegistry();
  return {
    scheduler: new TutorialSyncScheduler(
      syncDouble(configured),
      registry,
      configWith(values),
    ),
    registry,
  };
}

describe('TutorialSyncScheduler', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('opt-in', () => {
    it('registers no job when the switch is off', () => {
      const { scheduler, registry } = build({});

      scheduler.onModuleInit();

      expect(registry.getCronJobs().size).toBe(0);
    });

    it('warns loudly when off, rather than being silently inert', () => {
      // A job that silently does not run leaves a series that looks current and
      // is frozen — the same false confidence ADR-006 exists to destroy.
      const { scheduler } = build({});
      const warn = jest
        .spyOn(scheduler['logger'], 'warn')
        .mockImplementation(() => undefined);

      scheduler.onModuleInit();

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('TUTORIAL_SYNC_ENABLED'),
      );
    });

    it('registers no job when the source directories are unconfigured', () => {
      // Scheduling a job that can only ever record failures would fill
      // tutorial_syncs with noise and teach whoever reads it to skip the table.
      const { scheduler, registry } = build(
        { TUTORIAL_SYNC_ENABLED: true },
        false,
      );

      scheduler.onModuleInit();

      expect(registry.getCronJobs().size).toBe(0);
    });
  });

  describe('when enabled', () => {
    it('schedules at 03:00 America/Sao_Paulo by default', () => {
      const { scheduler, registry } = build({ TUTORIAL_SYNC_ENABLED: true });

      scheduler.onModuleInit();

      const job = registry.getCronJob('tutorial-sync');
      // The zone is pinned rather than inherited from the container: "03:00"
      // means 03:00 for the players, and a container in UTC would quietly move a
      // 20.000-file walk into the evening peak.
      expect(job.nextDate().toISO()).toContain('T03:00:00.000-03:00');

      void job.stop();
    });

    it('honours a configured expression', () => {
      const { scheduler, registry } = build({
        TUTORIAL_SYNC_ENABLED: true,
        TUTORIAL_SYNC_CRON: '30 4 * * *',
      });

      scheduler.onModuleInit();

      const job = registry.getCronJob('tutorial-sync');
      expect(job.nextDate().toISO()).toContain('T04:30:00.000-03:00');

      void job.stop();
    });

    it('does not run at boot', () => {
      // A walk of ~20.000 files at every container restart would turn a deploy
      // into a disk storm on the game machine's link.
      const run = jest.fn().mockResolvedValue({ status: 'ok' });
      const registry = new SchedulerRegistry();
      const scheduler = new TutorialSyncScheduler(
        { configured: true, sync: run } as unknown as TutorialSyncService,
        registry,
        configWith({ TUTORIAL_SYNC_ENABLED: true }),
      );

      scheduler.onModuleInit();

      expect(run).not.toHaveBeenCalled();
      void registry.getCronJob('tutorial-sync').stop();
    });
  });

  describe('a malformed expression', () => {
    it('is reported and leaves the job unscheduled, rather than crashing', () => {
      const { scheduler, registry } = build({
        TUTORIAL_SYNC_ENABLED: true,
        TUTORIAL_SYNC_CRON: 'nao sou cron',
      });
      const error = jest
        .spyOn(scheduler['logger'], 'error')
        .mockImplementation(() => undefined);

      expect(() => scheduler.onModuleInit()).not.toThrow();

      expect(registry.getCronJobs().size).toBe(0);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('nao sou cron'),
      );
    });

    it('does not silently fall back to the default hour', () => {
      // Someone wrote that string meaning something. Running at a different hour
      // than they intended is how a heavy job lands in peak.
      const { scheduler, registry } = build({
        TUTORIAL_SYNC_ENABLED: true,
        TUTORIAL_SYNC_CRON: '99 99 * * *',
      });
      jest
        .spyOn(scheduler['logger'], 'error')
        .mockImplementation(() => undefined);

      scheduler.onModuleInit();

      expect(registry.getCronJobs().size).toBe(0);
    });
  });
});
