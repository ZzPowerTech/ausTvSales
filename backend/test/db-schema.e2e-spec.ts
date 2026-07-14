import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import * as schema from '../src/db/schema';
import { categories, items, players, sales } from '../src/db/schema';

/**
 * Integration test for the S1.2 schema. Runs the real migrations against a real
 * PostgreSQL (docker-compose locally, `services.postgres` in CI) and asserts the
 * spec §4/§7 invariants behaviourally: table set, DB-side defaults, the idempotency
 * PK guard on `sales.id`, the catalog foreign keys, and the financial check constraints.
 */
describe('Database schema migrations (e2e)', () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  const ITEM_ID = 'caixaTest2026';
  const PLAYER_UUID = randomUUID();

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    db = drizzle(pool, { schema });

    // Migrations run from zero and are idempotent: running twice must not fail.
    await migrate(db, { migrationsFolder: './drizzle' });
    await migrate(db, { migrationsFolder: './drizzle' });

    // Deterministic starting point regardless of prior runs against this DB.
    await pool.query(
      'TRUNCATE sales, items, players, categories RESTART IDENTITY CASCADE',
    );

    const [category] = await db
      .insert(categories)
      .values({ name: 'Caixas' })
      .returning();
    await db.insert(items).values({
      itemId: ITEM_ID,
      displayName: 'Caixa de Teste',
      categoryId: category.id,
    });
    await db
      .insert(players)
      .values({ uuid: PLAYER_UUID, lastKnownNickname: 'Steve' });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('creates the four tables from the spec', async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [['categories', 'items', 'players', 'sales']],
    );

    expect(rows.map((r) => r.table_name).sort()).toEqual([
      'categories',
      'items',
      'players',
      'sales',
    ]);
  });

  it('persists a full sale and applies DB-side defaults', async () => {
    const saleId = randomUUID();

    await db.insert(sales).values({
      id: saleId,
      itemId: ITEM_ID,
      playerUuid: PLAYER_UUID,
      nicknameAtPurchase: 'Steve',
      totalPrice: '150.00',
      qtd: 1,
      purchasedAt: new Date('2026-07-14T10:00:00.000Z'),
    });

    const [row] = await db.select().from(sales).where(eq(sales.id, saleId));

    expect(row.historicalImport).toBe(false); // default false
    expect(row.createdAt).toBeInstanceOf(Date); // stamped by the DB
    expect(row.totalPrice).toBe('150.00'); // numeric precision preserved
    expect(row.purchasedAt.toISOString()).toBe('2026-07-14T10:00:00.000Z');
  });

  it('rejects a duplicate sale id (idempotency guard on the PK)', async () => {
    const saleId = randomUUID();
    const payload = {
      id: saleId,
      itemId: ITEM_ID,
      playerUuid: PLAYER_UUID,
      nicknameAtPurchase: 'Steve',
      totalPrice: '10.00',
      qtd: 1,
      purchasedAt: new Date('2026-07-14T11:00:00.000Z'),
    };

    await db.insert(sales).values(payload);

    // Drizzle wraps the pg error; assert the SQLSTATE (23505 = unique_violation)
    // rather than the message, which is locale-dependent.
    await expect(sqlstateOf(db.insert(sales).values(payload))).resolves.toBe(
      '23505',
    );
  });

  it('rejects a sale referencing an unknown item (foreign key)', async () => {
    await expect(
      sqlstateOf(
        db.insert(sales).values({
          id: randomUUID(),
          itemId: 'itemThatDoesNotExist',
          playerUuid: PLAYER_UUID,
          nicknameAtPurchase: 'Steve',
          totalPrice: '10.00',
          qtd: 1,
          purchasedAt: new Date('2026-07-14T12:00:00.000Z'),
        }),
      ),
    ).resolves.toBe('23503'); // foreign_key_violation
  });

  it('rejects non-positive qtd or total_price (financial check constraints)', async () => {
    const base = {
      itemId: ITEM_ID,
      playerUuid: PLAYER_UUID,
      nicknameAtPurchase: 'Steve',
      purchasedAt: new Date('2026-07-14T13:00:00.000Z'),
    };

    await expect(
      sqlstateOf(
        db
          .insert(sales)
          .values({ ...base, id: randomUUID(), totalPrice: '10.00', qtd: 0 }),
      ),
    ).resolves.toBe('23514'); // check_violation — qtd must be > 0

    await expect(
      sqlstateOf(
        db
          .insert(sales)
          .values({ ...base, id: randomUUID(), totalPrice: '0.00', qtd: 1 }),
      ),
    ).resolves.toBe('23514'); // check_violation — total_price must be > 0
  });
});

/**
 * Resolves to the PostgreSQL SQLSTATE code of the error thrown by `promise`.
 * Drizzle rethrows a wrapper whose `.cause` is the original node-postgres error,
 * where the `.code` lives. Fails the test if the promise does NOT reject.
 */
async function sqlstateOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const cause = error as { cause?: { code?: string }; code?: string };
    return cause.cause?.code ?? cause.code ?? 'no-sqlstate';
  }
  throw new Error('expected the query to reject, but it resolved');
}
