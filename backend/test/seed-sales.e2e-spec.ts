import { eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

import { buildDataset, type SeedOptions } from '../scripts/seed/dataset';
import { parseLocalDate } from '../scripts/seed/options';
import { insertDataset } from '../scripts/seed/writer';
import * as schema from '../src/db/schema';
import { categories, items, players, sales } from '../src/db/schema';

/**
 * Integration test for the S5.0 generator against a real PostgreSQL.
 *
 * The unit tests cover the dataset rules; what can only be proven here is the
 * write path: the foreign key ordering, the `ON CONFLICT` idempotency (against
 * a real unique index, not a mock) and the `numeric(12,2)` money round-trip.
 */
describe('Synthetic sales seed (e2e)', () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  const ITEM_IDS = ['caixaSeedA', 'caixaSeedB', 'caixaSeedC'];

  const options: SeedOptions = {
    count: 400,
    from: parseLocalDate('2026-01-01', 'from'),
    to: parseLocalDate('2026-04-01', 'to'),
    seed: 'e2e-seed',
    historicalRatio: 0.25,
    playerCount: 25,
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    db = drizzle(pool, { schema });

    await migrate(db, { migrationsFolder: './drizzle' });
    await pool.query(
      'TRUNCATE sales, items, players, categories RESTART IDENTITY CASCADE',
    );

    const [category] = await db
      .insert(categories)
      .values({ name: 'Caixas Seed' })
      .returning();

    await db.insert(items).values(
      ITEM_IDS.map((itemId) => ({
        itemId,
        displayName: `Item ${itemId}`,
        categoryId: category.id,
      })),
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it('grava o dataset respeitando a FK de player e as constraints de valor', async () => {
    const dataset = buildDataset(options, ITEM_IDS);
    const summary = await insertDataset(db, dataset);

    expect(summary.salesInserted).toBe(options.count);
    expect(summary.salesSkipped).toBe(0);

    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(sales);
    expect(row.count).toBe(options.count);
  });

  it('e idempotente: re-executar a mesma seed nao duplica nada', async () => {
    const dataset = buildDataset(options, ITEM_IDS);
    const summary = await insertDataset(db, dataset);

    // Todas as linhas ja existem — este e o comportamento que permite somar
    // volume sem recriar o banco, e o que protege contra o dedo escorregar.
    expect(summary.salesInserted).toBe(0);
    expect(summary.salesSkipped).toBe(options.count);

    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(sales);
    expect(row.count).toBe(options.count);
  });

  it('gera um dataset disjunto com outra seed, somando volume', async () => {
    const other = buildDataset({ ...options, seed: 'outra-seed' }, ITEM_IDS);
    const summary = await insertDataset(db, other);

    expect(summary.salesInserted).toBe(options.count);

    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(sales);
    expect(row.count).toBe(options.count * 2);
  });

  it('preserva o valor monetario exatamente no numeric(12,2)', async () => {
    const dataset = buildDataset(options, ITEM_IDS);
    const expectedCents = dataset.sales.reduce(
      (total, sale) => total + Math.round(Number(sale.totalPrice) * 100),
      0,
    );

    const [row] = await db
      .select({ total: sql<string>`sum(${sales.totalPrice})::text` })
      .from(sales)
      .where(
        inArray(
          sales.id,
          dataset.sales.map((sale) => sale.id),
        ),
      );

    // Comparacao em centavos inteiros: se o valor tivesse passado por float em
    // qualquer ponto do caminho, a soma nao fecharia exata.
    expect(Math.round(Number(row.total) * 100)).toBe(expectedCents);
  });

  it('mantem o historico num unico instante e fora da janela (CA7)', async () => {
    const historicalInstants = await db
      .selectDistinct({ purchasedAt: sales.purchasedAt })
      .from(sales)
      .where(eq(sales.historicalImport, true));

    expect(historicalInstants).toHaveLength(1);
    expect(historicalInstants[0].purchasedAt.getTime()).toBeLessThan(
      options.from.getTime(),
    );
  });

  it('deixa last_known_nickname com o nick atual, nao o da compra (CA4)', async () => {
    const drifted = await db
      .select({
        uuid: players.uuid,
        current: players.lastKnownNickname,
        atPurchase: sales.nicknameAtPurchase,
      })
      .from(sales)
      .innerJoin(players, eq(players.uuid, sales.playerUuid))
      .where(sql`${players.lastKnownNickname} <> ${sales.nicknameAtPurchase}`)
      .limit(5);

    // Sem pelo menos um caso destes no banco, o ranking da S5.1 nao tem como
    // ser demonstrado na tela — passaria "verde" exibindo o snapshot antigo.
    expect(drifted.length).toBeGreaterThan(0);
  });
});
