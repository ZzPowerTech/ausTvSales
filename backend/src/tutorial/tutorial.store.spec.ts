import { Test, TestingModule } from '@nestjs/testing';
import { DRIZZLE } from '../db/database.module';
import type { TutorialDayRow } from './tutorial-aggregate';
import { TutorialStore } from './tutorial.store';

/**
 * Chainable stub for Drizzle's fluent builders — same pattern as
 * `health-check.store.spec.ts`: every method returns the same object, and
 * awaiting it resolves to `result`.
 */
type StubMock = jest.Mock<unknown, unknown[]>;

function chain(result: unknown) {
  const target: Record<string, StubMock> = {};
  const proxy: unknown = new Proxy(target, {
    get(_, property: string) {
      if (property === 'then') {
        return (resolve: (value: unknown) => unknown) => resolve(result);
      }
      target[property] ??= jest.fn((): unknown => proxy);
      return target[property];
    },
  });
  return {
    proxy: proxy as never,
    calls: target,
  };
}

const SYNC = {
  filesScanned: 19_700,
  filesFailed: 0,
  playersInTutorial: 10_834,
  daysWritten: 2,
  questsInCatalogue: 41,
  finalQuestId: '33tutorial',
};

function rows(count: number): TutorialDayRow[] {
  return Array.from({ length: count }, (_, i) => ({
    day: `2026-03-${String((i % 28) + 1).padStart(2, '0')}`,
    platform: 'bedrock' as never,
    entered: 1,
    completed: 0,
  }));
}

describe('TutorialStore', () => {
  let db: {
    insert: jest.Mock;
    select: jest.Mock;
    delete: jest.Mock;
    transaction: jest.Mock;
  };
  let store: TutorialStore;
  /** The transaction handle handed to the callback. */
  let tx: {
    insert: jest.Mock;
    delete: jest.Mock;
  };

  beforeEach(async () => {
    tx = { insert: jest.fn(), delete: jest.fn() };
    db = {
      insert: jest.fn(),
      select: jest.fn(),
      delete: jest.fn(),
      transaction: jest.fn(async (run: (handle: unknown) => Promise<unknown>) =>
        run(tx),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [TutorialStore, { provide: DRIZZLE, useValue: db }],
    }).compile();

    store = module.get(TutorialStore);
  });

  describe('replaceAll', () => {
    it('deletes and inserts inside ONE transaction', async () => {
      // The delete and the insert must not be separately visible: a read landing
      // between them would see zero entrants across the whole history — a
      // catastrophic-looking number produced by a routine nightly job.
      tx.delete.mockReturnValue(chain(undefined).proxy);
      tx.insert.mockReturnValue(chain(undefined).proxy);

      await store.replaceAll(rows(3), SYNC);

      expect(db.transaction).toHaveBeenCalledTimes(1);
      expect(tx.delete).toHaveBeenCalledTimes(1);
      // One insert for the rows, one for the provenance record.
      expect(tx.insert).toHaveBeenCalledTimes(2);
      // Neither statement escaped the transaction handle.
      expect(db.delete).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('records the sync in the SAME transaction as the rows it describes', async () => {
      // Otherwise a crash between them leaves a success record pointing at the
      // previous run's numbers.
      const inserted: unknown[] = [];
      tx.delete.mockReturnValue(chain(undefined).proxy);
      tx.insert.mockImplementation(() => {
        const link = chain(undefined);
        link.calls.values = jest.fn((value: unknown) => {
          inserted.push(value);
          return link.proxy;
        }) as StubMock;
        return link.proxy;
      });

      await store.replaceAll(rows(1), SYNC);

      expect(inserted).toContainEqual(
        expect.objectContaining({ status: 'ok', ...SYNC }),
      );
    });

    it('still deletes when there are no rows, but only inside the transaction', async () => {
      // The store does not second-guess an empty set — refusing a degenerate
      // scan is the sync service's job, and duplicating the rule here would let
      // the two drift apart. What the store guarantees is atomicity.
      tx.delete.mockReturnValue(chain(undefined).proxy);
      tx.insert.mockReturnValue(chain(undefined).proxy);

      await store.replaceAll([], SYNC);

      expect(tx.delete).toHaveBeenCalledTimes(1);
      // Only the provenance insert — no empty `values([])`, which Drizzle rejects.
      expect(tx.insert).toHaveBeenCalledTimes(1);
    });

    it('chunks large inserts so the bound-parameter cap is unreachable', async () => {
      // Postgres caps a statement at 65535 bound parameters and each row binds
      // four. Chunking at 5.000 keeps every statement an order of magnitude clear.
      tx.delete.mockReturnValue(chain(undefined).proxy);
      tx.insert.mockReturnValue(chain(undefined).proxy);

      await store.replaceAll(rows(12_001), SYNC);

      // 3 chunks (5000 + 5000 + 2001) plus the provenance row.
      expect(tx.insert).toHaveBeenCalledTimes(4);
    });
  });

  describe('recordFailure', () => {
    it('inserts an error row and does NOT touch the series', async () => {
      // A failed sync means we could not measure, not that the numbers became
      // zero. Wiping here would turn a missing directory into "nobody ever
      // entered the tutorial".
      db.insert.mockReturnValue(chain(undefined).proxy);

      await store.recordFailure({ detail: 'diretorio vazio', filesScanned: 0 });

      expect(db.insert).toHaveBeenCalledTimes(1);
      expect(db.delete).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('nulls the fields a failed run could not determine', async () => {
      let values: unknown;
      const link = chain(undefined);
      link.calls.values = jest.fn((value: unknown) => {
        values = value;
        return link.proxy;
      }) as StubMock;
      db.insert.mockReturnValue(link.proxy);

      await store.recordFailure({ detail: 'catalogo vazio' });

      expect(values).toEqual({
        status: 'error',
        detail: 'catalogo vazio',
        filesScanned: null,
        filesFailed: null,
        playersInTutorial: null,
        daysWritten: null,
        questsInCatalogue: null,
        finalQuestId: null,
      });
    });
  });

  describe('enteredSince', () => {
    it('reads the summed total, which pg returns as a string', async () => {
      // `sum()` comes back as a string for bigint results. Number() on it is the
      // whole point of the coalesce in the query.
      db.select.mockReturnValue(chain([{ total: '4212' }]).proxy);

      await expect(store.enteredSince('2026-03-01')).resolves.toBe(4212);
    });

    it('returns 0 rather than NaN when the query yields no row', async () => {
      db.select.mockReturnValue(chain([]).proxy);

      await expect(store.enteredSince('2026-03-01')).resolves.toBe(0);
    });
  });

  describe('lastSync vs lastSuccessfulSync', () => {
    it('lastSync returns the newest run of any status', async () => {
      const row = { id: 9, status: 'error' };
      db.select.mockReturnValue(chain([row]).proxy);

      await expect(store.lastSync()).resolves.toBe(row);
    });

    it('returns null when nothing has ever run', async () => {
      db.select.mockReturnValue(chain([]).proxy);

      // Null, never a fabricated empty record: "no sync has ever run" and "the
      // last sync found nothing" are the two things this table exists to keep
      // apart.
      await expect(store.lastSync()).resolves.toBeNull();
      await expect(store.lastSuccessfulSync()).resolves.toBeNull();
    });

    it('lastSuccessfulSync filters by status, which lastSync must not', async () => {
      const link = chain([{ id: 4, status: 'ok' }]);
      db.select.mockReturnValue(link.proxy);

      await store.lastSuccessfulSync();
      expect(link.calls.where).toHaveBeenCalledTimes(1);

      jest.clearAllMocks();
      db.select.mockReturnValue(chain([{ id: 5 }]).proxy);
      await store.lastSync();
      // The two answer different questions: one dates the data in the table, the
      // other dates the last attempt. When they differ the series is stale.
      expect(link.calls.where).toHaveBeenCalledTimes(0);
    });
  });
});
