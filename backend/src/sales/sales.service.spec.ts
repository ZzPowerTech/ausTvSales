import { UnprocessableEntityException } from '@nestjs/common';
import type { DrizzleDB } from '../db/database.module';
import { items, players, sales } from '../db/schema';
import type { CreateSaleDto } from './dto/create-sale.dto';
import { SalesService } from './sales.service';

/**
 * Unit tests for the S2.2 ingest flow. The Drizzle layer is mocked (like the
 * other `*.spec.ts` here) so `npm test` needs no real Postgres; the ON CONFLICT
 * / PK idempotency itself is exercised against a real DB in the e2e suite
 * (`npm run test:e2e`) — see the note in the task report.
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
  playerRows: Array<{ lastKnownNickname: string }>;
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
  const select = jest.fn(() => ({
    from: (table: unknown) => ({
      where: () => ({
        limit: () =>
          Promise.resolve(
            table === items ? config.itemRows : config.playerRows,
          ),
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
        : Promise.resolve([]),
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
  it('records a new sale for an active item and a new player (created)', async () => {
    const { service, tx } = buildService({
      itemRows: [{ active: true }],
      playerRows: [],
      saleReturning: [{ id: baseDto().sale_id }],
    });

    const result = await service.record(baseDto());

    expect(result).toEqual({ saleId: baseDto().sale_id, created: true });
    expect(tx.insert).toHaveBeenCalledWith(players); // player created
    expect(tx.insert).toHaveBeenCalledWith(sales); // sale inserted
    expect(tx.update).not.toHaveBeenCalled();
  });

  it('is idempotent: a replayed sale_id inserts nothing and reports not-created', async () => {
    const { service, tx } = buildService({
      itemRows: [{ active: true }],
      playerRows: [{ lastKnownNickname: 'Murilo' }],
      saleReturning: [], // ON CONFLICT DO NOTHING → empty RETURNING
    });

    const result = await service.record(baseDto());

    expect(result).toEqual({ saleId: baseDto().sale_id, created: false });
    // The sale insert is still attempted (the DB conflict is the guard); it just
    // returns no row, so we answer 200 without duplicating.
    expect(tx.insert).toHaveBeenCalledWith(sales);
  });

  it('rejects an unknown item with 422 and creates neither player nor sale', async () => {
    const { service, tx } = buildService({
      itemRows: [], // item_id not in catalog
      playerRows: [],
      saleReturning: [],
    });

    await expect(service.record(baseDto())).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(tx.insert).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
  });

  it('rejects an inactive item with 422 (permanent error)', async () => {
    const { service, tx } = buildService({
      itemRows: [{ active: false }],
      playerRows: [],
      saleReturning: [],
    });

    await expect(service.record(baseDto())).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it('updates last_known_nickname when the purchase nickname changed', async () => {
    const { service, tx } = buildService({
      itemRows: [{ active: true }],
      playerRows: [{ lastKnownNickname: 'OldNick' }],
      saleReturning: [{ id: baseDto().sale_id }],
    });

    await service.record(baseDto({ nickname_at_purchase: 'NewNick' }));

    expect(tx.update).toHaveBeenCalledWith(players);
    expect(tx.insert).not.toHaveBeenCalledWith(players); // player already exists
  });

  it('does not UPDATE the player when the nickname is unchanged', async () => {
    const { service, tx } = buildService({
      itemRows: [{ active: true }],
      playerRows: [{ lastKnownNickname: 'Murilo' }],
      saleReturning: [{ id: baseDto().sale_id }],
    });

    await service.record(baseDto({ nickname_at_purchase: 'Murilo' }));

    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.insert).not.toHaveBeenCalledWith(players);
  });
});
