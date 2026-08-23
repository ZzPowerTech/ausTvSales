import { Test, TestingModule } from '@nestjs/testing';
import { DRIZZLE } from '../db/database.module';
import { HealthCheckStore } from './health-check.store';
import { HealthCheckName } from './health-check.types';

/**
 * Builds a chainable stub for Drizzle's fluent builders: every method returns
 * the same object, and the terminal call resolves to `result`.
 */
type StubMock = jest.Mock<unknown, unknown[]>;

function chain(result: unknown) {
  const target: Record<string, StubMock> = {};
  const proxy: unknown = new Proxy(target, {
    get(_, property: string) {
      if (property === 'then') {
        // Awaiting the builder resolves to the configured rows.
        return (resolve: (value: unknown) => unknown) => resolve(result);
      }
      target[property] ??= jest.fn((): unknown => proxy);
      return target[property];
    },
  });
  return {
    proxy: proxy as never,
    calls: target,
    /** First argument handed to `method`, or undefined if it was never called. */
    firstArgOf: (method: string): unknown => target[method]?.mock.calls[0]?.[0],
  };
}

const ROW = {
  id: 1,
  checkName: HealthCheckName.VersionDivergence,
  status: 'breached' as const,
  checkedAt: new Date('2026-08-22T03:00:00.000Z'),
  detail: { summary: 'builds divergentes' },
  alertedAt: null,
};

describe('HealthCheckStore', () => {
  let db: {
    insert: jest.Mock;
    select: jest.Mock;
    update: jest.Mock;
    execute: jest.Mock;
  };
  let store: HealthCheckStore;

  beforeEach(async () => {
    db = {
      insert: jest.fn(),
      select: jest.fn(),
      update: jest.fn(),
      execute: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [HealthCheckStore, { provide: DRIZZLE, useValue: db }],
    }).compile();

    store = module.get(HealthCheckStore);
  });

  describe('record', () => {
    it('appends one row per observation and returns them mapped', async () => {
      const { proxy, calls } = chain([ROW]);
      db.insert.mockReturnValue(proxy);

      const result = await store.record([
        {
          checkName: HealthCheckName.VersionDivergence,
          status: 'breached',
          detail: { summary: 'builds divergentes' },
        },
      ]);

      expect(calls.values).toHaveBeenCalledWith([
        {
          checkName: HealthCheckName.VersionDivergence,
          status: 'breached',
          detail: { summary: 'builds divergentes' },
        },
      ]);
      expect(result).toEqual([{ ...ROW, alertedAt: null }]);
    });

    it('does not touch the database for an empty batch', async () => {
      await expect(store.record([])).resolves.toEqual([]);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('never sets checked_at from the application clock', async () => {
      // The column defaults to now() in Postgres on purpose: history ordering
      // must not depend on clock skew between the container and the database.
      const { proxy, firstArgOf } = chain([ROW]);
      db.insert.mockReturnValue(proxy);

      await store.record([
        {
          checkName: HealthCheckName.OrphanInstance,
          status: 'ok',
          detail: { summary: 'ok' },
        },
      ]);

      const values = firstArgOf('values') as Record<string, unknown>[];
      expect(values[0]).not.toHaveProperty('checkedAt');
      expect(values[0]).not.toHaveProperty('alertedAt');
    });
  });

  describe('latest', () => {
    it('returns the most recent row mapped to a record', async () => {
      db.select.mockReturnValue(chain([ROW]).proxy);

      await expect(
        store.latest(HealthCheckName.VersionDivergence),
      ).resolves.toEqual({ ...ROW, alertedAt: null });
    });

    it('returns null when the check has never run', async () => {
      db.select.mockReturnValue(chain([]).proxy);

      await expect(
        store.latest(HealthCheckName.VersionDivergence),
      ).resolves.toBeNull();
    });
  });

  describe('latestAll', () => {
    it('maps snake_case raw rows and revives the timestamps', async () => {
      db.execute.mockResolvedValue({
        rows: [
          {
            id: 7,
            check_name: 'plan.collection_alive:survival',
            status: 'no_data',
            checked_at: '2026-08-22T03:00:00.000Z',
            detail: { summary: 'sem coleta na janela' },
            alerted_at: '2026-08-22T03:00:05.000Z',
          },
        ],
      });

      const [record] = await store.latestAll();

      expect(record.checkName).toBe('plan.collection_alive:survival');
      expect(record.status).toBe('no_data');
      expect(record.checkedAt).toEqual(new Date('2026-08-22T03:00:00.000Z'));
      expect(record.alertedAt).toEqual(new Date('2026-08-22T03:00:05.000Z'));
    });

    it('keeps a null alerted_at as null instead of the epoch', async () => {
      // `new Date(null)` is 1970-01-01, which would read as "alerted long ago"
      // and permanently suppress grouping for that check.
      db.execute.mockResolvedValue({
        rows: [
          {
            id: 7,
            check_name: 'plan.orphan_instance',
            status: 'ok',
            checked_at: '2026-08-22T03:00:00.000Z',
            detail: null,
            alerted_at: null,
          },
        ],
      });

      const [record] = await store.latestAll();

      expect(record.alertedAt).toBeNull();
      expect(record.detail).toBeNull();
    });
  });

  describe('lastAlertAt', () => {
    it('returns the timestamp of the most recent announced row', async () => {
      const at = new Date('2026-08-20T12:00:00.000Z');
      db.select.mockReturnValue(chain([{ alertedAt: at }]).proxy);

      await expect(
        store.lastAlertAt(HealthCheckName.TutorialEntryRate),
      ).resolves.toEqual(at);
    });

    it('returns null when the check was never announced', async () => {
      db.select.mockReturnValue(chain([]).proxy);

      await expect(
        store.lastAlertAt(HealthCheckName.TutorialEntryRate),
      ).resolves.toBeNull();
    });
  });

  describe('markAlerted', () => {
    it('stamps the given rows and reports how many were updated', async () => {
      const { proxy, calls } = chain([{ id: 1 }, { id: 2 }]);
      db.update.mockReturnValue(proxy);

      await expect(store.markAlerted([1, 2])).resolves.toBe(2);
      expect(calls.set).toHaveBeenCalledTimes(1);
    });

    it('does not touch the database for an empty id list', async () => {
      await expect(store.markAlerted([])).resolves.toBe(0);
      expect(db.update).not.toHaveBeenCalled();
    });
  });
});
