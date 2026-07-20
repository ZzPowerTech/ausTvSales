import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { items } from '../src/db/schema';
import { buildDataset } from './seed/dataset';
import { assertSeedTargetAllowed, SeedGuardError } from './seed/guard';
import { parseSeedOptions, SeedOptionsError } from './seed/options';
import { insertDataset } from './seed/writer';

/**
 * Synthetic sales generator (spec S5.0).
 *
 * Development tool, never shipped: `tsconfig.build.json` excludes `scripts/`,
 * so nothing here reaches `dist/`. It is also deliberately not an HTTP endpoint
 * — a seed route would be permanent attack surface in exchange for convenience
 * nobody needs, since whoever runs this already has a shell on the machine.
 *
 *   SEED_ALLOW=true npm run seed:sales -- --count=50000 --from=2026-01-01 --to=2026-07-20
 *
 * Writes straight to the database rather than replaying `POST /sales`: 50k
 * requests through guard, throttle and one transaction each would take tens of
 * minutes and trip the ingest rate limit. The ingest path already has e2e
 * coverage from Sprint 2 — the seed is not the place to re-prove it.
 */
async function main(): Promise<void> {
  try {
    process.loadEnvFile();
  } catch {
    // no .env file — rely on the ambient environment (same as drizzle.config.ts)
  }

  const options = parseSeedOptions(process.argv.slice(2));
  assertSeedTargetAllowed(process.env);

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 30_000,
  });
  const db = drizzle(pool);

  try {
    const activeItems = await db
      .select({ itemId: items.itemId })
      .from(items)
      .where(sql`${items.active} = true`);

    if (activeItems.length === 0) {
      throw new Error(
        'Nenhum item ativo no catalogo. Cadastre categorias e itens pelo ' +
          'dashboard antes de gerar vendas — o gerador nao inventa catalogo.',
      );
    }

    const dataset = buildDataset(
      options,
      activeItems.map((item) => item.itemId),
    );
    const historical = dataset.sales.filter(
      (sale) => sale.historicalImport,
    ).length;

    console.log(
      `Gerando ${dataset.sales.length} vendas (${historical} historicas) de ` +
        `${dataset.players.length} jogadores sobre ${activeItems.length} itens ativos...`,
    );

    const summary = await insertDataset(db, dataset);

    console.log(
      `OK — ${summary.playersWritten} jogadores upsertados, ` +
        `${summary.salesInserted} vendas inseridas` +
        (summary.salesSkipped > 0
          ? ` (${summary.salesSkipped} ja existiam: re-execucao idempotente).`
          : '.'),
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  // Guard and option failures are operator errors, not crashes: show the
  // message, skip the stack trace that would bury it.
  if (error instanceof SeedGuardError || error instanceof SeedOptionsError) {
    console.error(`\n${error.message}\n`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
