import { Test, TestingModule } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { DRIZZLE } from '../db/database.module';
import { items } from '../db/schema';
import { ItemsService, type ItemSyncEntry } from './items.service';

/**
 * Unit spec for the plugin-cache sync query (spec S2.3). The Drizzle builder is
 * mocked as a chain (`select().from().where().orderBy()`), matching the
 * mock-the-data-layer style of the existing specs — we assert the *shape* of the
 * query (active-only, lean projection) rather than hitting a real database.
 */
describe('ItemsService.findActiveForSync', () => {
  const orderBy = jest.fn();
  const where = jest.fn(() => ({ orderBy }));
  const from = jest.fn(() => ({ where }));
  const select = jest.fn(() => ({ from }));
  const db = { select };

  let service: ItemsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    where.mockReturnValue({ orderBy });
    from.mockReturnValue({ where });
    select.mockReturnValue({ from });

    const module: TestingModule = await Test.createTestingModule({
      providers: [ItemsService, { provide: DRIZZLE, useValue: db }],
    }).compile();

    service = module.get<ItemsService>(ItemsService);
  });

  it('selects only the lean { itemId, active } projection', async () => {
    orderBy.mockResolvedValue([]);

    await service.findActiveForSync();

    expect(select).toHaveBeenCalledWith({
      itemId: items.itemId,
      active: items.active,
    });
    expect(from).toHaveBeenCalledWith(items);
  });

  it('filters to active = true only (inactive items are excluded)', async () => {
    orderBy.mockResolvedValue([]);

    await service.findActiveForSync();

    expect(where).toHaveBeenCalledTimes(1);
    expect(where).toHaveBeenCalledWith(eq(items.active, true));
  });

  it('returns the rows produced by the query', async () => {
    const rows: ItemSyncEntry[] = [
      { itemId: 'caixaNatal2026', active: true },
      { itemId: 'vipGold', active: true },
    ];
    orderBy.mockResolvedValue(rows);

    await expect(service.findActiveForSync()).resolves.toEqual(rows);
  });
});
