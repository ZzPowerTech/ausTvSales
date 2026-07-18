import { BadRequestException, ConflictException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { categories } from '../db/schema';
import type { DrizzleDB } from '../db/database.module';
import { CategoriesService } from './categories.service';

/**
 * Unit spec for the S4.0 integrity work: atomic reordering and the driver-level
 * unique-violation mapping. Follows the mock-the-data-layer style of the other
 * service specs — the Drizzle builder is a chain of jest mocks, so we assert the
 * *shape* of the writes rather than hitting a real database.
 *
 * The uniqueness index itself is a data-layer guarantee and is exercised by the
 * migration + e2e run in CI, not here.
 */

interface TxMock {
  select: jest.Mock;
  update: jest.Mock;
}

/** Postgres unique_violation, as the `pg` driver surfaces it. */
function uniqueViolation(): Error & { code: string } {
  return Object.assign(
    new Error('duplicate key value violates unique constraint'),
    { code: '23505' },
  );
}

/**
 * Build a service whose transaction sees `existingIds` and records every
 * `display_order` write, so a test can assert the final ordering.
 */
function buildForReorder(existingIds: number[]): {
  service: CategoriesService;
  tx: TxMock;
  writes: Array<{ condition: unknown; displayOrder: number }>;
  finalRows: unknown[];
} {
  const writes: Array<{ condition: unknown; displayOrder: number }> = [];
  const finalRows = existingIds.map((id) => ({ id }));

  // First `select()` is the validation read; the last one is the ordered
  // re-read returned to the caller. Both share the same chain root.
  let selectCall = 0;
  const select = jest.fn(() => {
    selectCall += 1;
    const isValidationRead = selectCall === 1;
    return {
      from: () =>
        isValidationRead
          ? Promise.resolve(existingIds.map((id) => ({ id })))
          : { orderBy: () => Promise.resolve(finalRows) },
    };
  });

  const update = jest.fn(() => ({
    set: (values: { displayOrder: number }) => ({
      where: (condition: unknown) => {
        writes.push({ condition, displayOrder: values.displayOrder });
        return Promise.resolve([]);
      },
    }),
  }));

  const tx: TxMock = { select, update };
  const db = {
    transaction: jest.fn(
      (cb: (t: TxMock) => Promise<unknown>): Promise<unknown> => cb(tx),
    ),
  } as unknown as DrizzleDB;

  return { service: new CategoriesService(db), tx, writes, finalRows };
}

describe('CategoriesService.reorder', () => {
  it('assigns display_order by position, inside a single transaction', async () => {
    const { service, tx, writes, finalRows } = buildForReorder([1, 2, 3]);

    const result = await service.reorder({ order: [3, 1, 2] });

    // display_order follows the position in the request, not the id.
    expect(writes.map((w) => w.displayOrder)).toEqual([0, 1, 2]);
    expect(writes.map((w) => w.condition)).toEqual([
      eq(categories.id, 3),
      eq(categories.id, 1),
      eq(categories.id, 2),
    ]);
    expect(tx.update).toHaveBeenCalledTimes(3);
    expect(tx.update).toHaveBeenCalledWith(categories);
    expect(result).toBe(finalRows);
  });

  it('rejects an unknown id without writing anything', async () => {
    const { service, writes } = buildForReorder([1, 2, 3]);

    await expect(service.reorder({ order: [1, 2, 99] })).rejects.toThrow(
      BadRequestException,
    );
    // No partial ordering: the transaction aborts before the first UPDATE.
    expect(writes).toEqual([]);
  });

  it('rejects an incomplete set without writing anything', async () => {
    const { service, writes } = buildForReorder([1, 2, 3]);

    await expect(service.reorder({ order: [1, 2] })).rejects.toThrow(
      BadRequestException,
    );
    expect(writes).toEqual([]);
  });
});

describe('CategoriesService unique-violation mapping', () => {
  /** Service whose pre-check finds nothing but whose write races and fails. */
  function buildRacingService(): CategoriesService {
    const select = jest.fn(() => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
    }));
    const insert = jest.fn(() => ({
      values: () => ({
        returning: () => Promise.reject(uniqueViolation()),
      }),
    }));
    const db = { select, insert } as unknown as DrizzleDB;
    return new CategoriesService(db);
  }

  it('maps a 23505 on create to 409, not 500', async () => {
    const service = buildRacingService();

    // The pre-check passes (empty select) and the DB constraint catches it —
    // exactly the race the index exists to close.
    await expect(service.create({ name: 'VIP' })).rejects.toThrow(
      ConflictException,
    );
  });

  it('propagates non-unique-violation errors untouched', async () => {
    const boom = Object.assign(new Error('connection terminated'), {
      code: '08006',
    });
    const select = jest.fn(() => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
    }));
    const insert = jest.fn(() => ({
      values: () => ({ returning: () => Promise.reject(boom) }),
    }));
    const service = new CategoriesService({
      select,
      insert,
    } as unknown as DrizzleDB);

    await expect(service.create({ name: 'VIP' })).rejects.toBe(boom);
  });
});
