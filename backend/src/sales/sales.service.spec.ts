import { UnprocessableEntityException } from '@nestjs/common';
import type { DrizzleDB } from '../db/database.module';
import { players, sales } from '../db/schema';
import type { CreateSaleDto } from './dto/create-sale.dto';
import { SalesService } from './sales.service';

/**
 * Unit tests for the S2.2 ingest flow. The Drizzle layer is mocked (like the
 * other `*.spec.ts` here) so `npm test` needs no real Postgres.
 *
 * These assert the *shape* of the flow (catalog gate, which statements run,
 * created-vs-duplicate result). The actual SQL-level guarantees — `ON CONFLICT`
 * idempotency on `sales.id`, the concurrency-safe player upsert and the
 * "nickname changed" UPDATE predicate — are enforced by Postgres and are not
 * observable through a mock; a `sales.e2e-spec.ts` against a real DB (not yet
 * written — Sprint 2 DoD) is the place to verify them end to end.
 */

function baseDto(overrides: Partial<CreateSaleDto> = {}): CreateSaleDto {
  return {
    sale_id: '11111111-1111-4111-8111-111111111111',
    item_id: 'caixaNatal2026',
    player_uuid: '22222222-2222-4222-8222-222222222222',
    nickname_at_purchase: 'Murilo',
    total_price: 10.5,
    qtd: 1,
    purchased_at: '2026-07-16T12:00:00.000Z',
    ...overrides,
  };
}

interface MockConfig {
  itemRows: Array<{ active: boolean }>;
  saleReturning: Array<{ id: string }>;
}

interface TxMock {
  select: jest.Mock;
  insert: jest.Mock;
  update: jest.Mock;
}

function buildService(config: MockConfig): {
  service: SalesService;
  tx: TxMock;
} {
  // Only the catalog gate reads (items); the player upsert no longer does a
  // read-then-branch, so `select` is items-only now.
  const select = jest.fn(() => ({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve(config.itemRows),
      }),
    }),
  }));

  const insert = jest.fn((table: unknown) => ({
    values: () =>
      table === sales
        ? {
            onConflictDoNothing: () => ({
              returning: () => Promise.resolve(config.saleReturning),
            }),
          }
        : // players: INSERT ... ON CONFLICT (uuid) DO NOTHING
          {
            onConflictDoNothing: () => Promise.resolve([]),
          },
  }));

  const update = jest.fn(() => ({
    set: () => ({
      where: () => Promise.resolve([]),
    }),
  }));

  const tx: TxMock = { select, insert, update };
  const db = {
    transaction: jest.fn(
      (cb: (t: TxMock) => Promise<unknown>): Promise<unknown> => cb(tx),
    ),
  } as unknown as DrizzleDB;

  return { service: new SalesService(db), tx };
}

describe('SalesService', () => {
  it('records a new sale for an active item and upserts the player (created)', async () => {
    const { service, tx } = buildService({
      itemRows: [{ active: true }],
      saleReturning: [{ id: baseDto().sale_id }],
    });

    const result = await service.record(baseDto());

    expect(result).toEqual({ saleId: baseDto().sale_id, created: true });
    // Concurrency-safe upsert always issues both statements; the DB decides via
    // ON CONFLICT / the WHERE guard whether each actually writes.
    expect(tx.insert).toHaveBeenCalledWith(players);
    expect(tx.update).toHaveBeenCalledWith(players);
    expect(tx.insert).toHaveBeenCalledWith(sales);
  });

  it('is idempotent: a replayed sale_id inserts nothing and reports not-created', async () => {
    const { service, tx } = buildService({
      itemRows: [{ active: true }],
      saleReturning: [], // ON CONFLICT DO NOTHING → empty RETURNING
    });

    const result = await service.record(baseDto());

    expect(result).toEqual({ saleId: baseDto().sale_id, created: false });
    // The sale insert is still attempted (the DB conflict is the guard); it just
    // returns no row, so we answer 200 without duplicating.
    expect(tx.insert).toHaveBeenCalledWith(sales);
  });

  it('rejects an unknown item with 422 and touches neither player nor sale', async () => {
    const { service, tx } = buildService({
      itemRows: [], // item_id not in catalog
      saleReturning: [],
    });

    await expect(service.record(baseDto())).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(tx.insert).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
  });

  it('rejects an inactive item with 422 (permanent error) before any write', async () => {
    const { service, tx } = buildService({
      itemRows: [{ active: false }],
      saleReturning: [],
    });

    await expect(service.record(baseDto())).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(tx.insert).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
  });

  it('runs the player upsert as insert-on-conflict + guarded update, in the tx', async () => {
    const { service, tx } = buildService({
      itemRows: [{ active: true }],
      saleReturning: [{ id: baseDto().sale_id }],
    });

    await service.record(baseDto());

    // The whole flow runs inside a single transaction, and the player write is
    // the race-free upsert (INSERT ... ON CONFLICT DO NOTHING, then the guarded
    // UPDATE) — never a SELECT-then-branch that could 500 on the PK.
    expect(tx.select.mock.calls.length).toBe(1); // items gate only
    expect(tx.insert).toHaveBeenCalledWith(players);
    expect(tx.update).toHaveBeenCalledWith(players);
  });
});
