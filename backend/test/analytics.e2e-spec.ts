import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import request from 'supertest';
import { App } from 'supertest/types';
import * as schema from '../src/db/schema';
import { categories, items, players, sales } from '../src/db/schema';
import { createAuthenticatedApp } from './e2e-utils';

/**
 * Analytics reads (spec S5.1 §2.9) against a real PostgreSQL.
 *
 * The fixture is built with exact money and deliberately awkward timestamps so
 * the assertions pin the rules that only a real DB can prove: São Paulo bucket
 * boundaries, `numeric(12,2)` summation, the current-nickname join, and the
 * historical_import include/exclude split.
 */
describe('Analytics (e2e)', () => {
  let app: INestApplication<App>;
  let authCookie: string;
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  // Two players; P1 renamed, so the snapshot on the sale differs from the
  // current nickname the ranking must show (CA4).
  const P1 = randomUUID();
  const P2 = randomUUID();
  const P3 = randomUUID();

  beforeAll(async () => {
    ({ app, authCookie } = await createAuthenticatedApp());
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    db = drizzle(pool, { schema });

    await pool.query(
      'TRUNCATE sales, items, players, categories RESTART IDENTITY CASCADE',
    );

    const [caixas] = await db
      .insert(categories)
      .values({ name: 'Caixas' })
      .returning();

    await db.insert(items).values([
      { itemId: 'caixaA', displayName: 'Caixa A', categoryId: caixas.id },
      {
        itemId: 'caixaB',
        displayName: 'Caixa B',
        categoryId: caixas.id,
        active: false,
      },
      { itemId: 'caixaC', displayName: 'Caixa C', categoryId: caixas.id },
    ]);

    await db.insert(players).values([
      { uuid: P1, lastKnownNickname: 'P1_now' },
      { uuid: P2, lastKnownNickname: 'P2_now' },
      { uuid: P3, lastKnownNickname: 'P3_now' },
    ]);

    await db.insert(sales).values([
      // 23:30 BRT on 2026-03-10 == 02:30 UTC on 2026-03-11. A naive UTC truncation
      // would bucket this on the 11th; São Paulo truncation keeps it on the 10th.
      sale('caixaA', P1, 'P1_old', '100.00', 2, '2026-03-11T02:30:00Z'),
      sale('caixaA', P1, 'P1_old', '50.00', 1, '2026-03-15T15:00:00Z'),
      sale('caixaA', P2, 'P2_now', '30.00', 1, '2026-03-15T15:00:00Z'),
      // 0.10 + 0.20 == 0.30 exactly; a float path would drift here.
      sale('caixaA', P3, 'P3_now', '0.10', 1, '2026-03-20T15:00:00Z'),
      sale('caixaA', P3, 'P3_now', '0.20', 1, '2026-03-20T15:00:00Z'),
      // Historical: one fixed pre-window instant, big totals.
      historical(
        'caixaA',
        P1,
        'P1_old',
        '36000.00',
        300,
        '2025-01-01T00:00:00Z',
      ),
      // Inactive item still has a sale, to prove it is listed (flagged inactive).
      sale('caixaB', P2, 'P2_now', '10.00', 1, '2026-03-15T15:00:00Z'),
      // caixaC has only a historical sale: series must be empty but baseline set.
      historical('caixaC', P2, 'P2_now', '500.00', 5, '2025-01-01T00:00:00Z'),
    ]);
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  describe('autenticação (§2.9)', () => {
    it('exige sessão nas três rotas (401)', async () => {
      await http().get('/analytics/categories/1/items').expect(401);
      await http().get('/analytics/items/caixaA/top-buyers').expect(401);
      await http().get('/analytics/items/caixaA/series').expect(401);
    });
  });

  describe('GET categories/:id/items', () => {
    it('lista os itens da categoria com totais que incluem o histórico', async () => {
      const res = await http()
        .get('/analytics/categories/1/items')
        .set('Cookie', authCookie)
        .expect(200);

      const body = res.body as {
        categoryId: number;
        items: Array<{
          itemId: string;
          active: boolean;
          salesCount: number;
          totalQty: number;
          revenue: string;
        }>;
      };
      expect(body.categoryId).toBe(1);

      const a = body.items.find((i) => i.itemId === 'caixaA')!;
      // 5 recentes + 1 histórica; qtd 6 + 300; receita 180.30 + 36000.00.
      expect(a.salesCount).toBe(6);
      expect(a.totalQty).toBe(306);
      expect(a.revenue).toBe('36180.30');

      const b = body.items.find((i) => i.itemId === 'caixaB')!;
      expect(b.active).toBe(false);

      // Item sem venda no período ainda aparece (aqui todos têm venda).
      const c = body.items.find((i) => i.itemId === 'caixaC')!;
      expect(c.totalQty).toBe(5);
    });

    it('aplica o filtro de período', async () => {
      const res = await http()
        .get('/analytics/categories/1/items?from=2026-03-16&to=2026-03-25')
        .set('Cookie', authCookie)
        .expect(200);
      const a = (
        res.body as {
          items: Array<{ itemId: string; totalQty: number; revenue: string }>;
        }
      ).items.find((i) => i.itemId === 'caixaA')!;
      // Só as duas vendas de 0.10 e 0.20 caem na janela.
      expect(a.totalQty).toBe(2);
      expect(a.revenue).toBe('0.30');
    });

    it('404 para categoria inexistente', () =>
      http()
        .get('/analytics/categories/999/items')
        .set('Cookie', authCookie)
        .expect(404));
  });

  describe('GET items/:itemId/top-buyers', () => {
    it('ranqueia por receita e mostra o nickname ATUAL, não o da compra (CA4)', async () => {
      const res = await http()
        .get('/analytics/items/caixaA/top-buyers')
        .set('Cookie', authCookie)
        .expect(200);

      const body = res.body as {
        buyers: Array<{ nickname: string; totalQty: number; revenue: string }>;
      };
      expect(body.buyers).toHaveLength(3);
      // P1 lidera (100+50+36000). O snapshot 'P1_old' está no banco, mas o
      // ranking precisa exibir 'P1_now'.
      expect(body.buyers[0].nickname).toBe('P1_now');
      expect(body.buyers[0].revenue).toBe('36150.00');
      expect(body.buyers[0].totalQty).toBe(303);
    });

    it('respeita o limit', async () => {
      const res = await http()
        .get('/analytics/items/caixaA/top-buyers?limit=1')
        .set('Cookie', authCookie)
        .expect(200);
      expect((res.body as { buyers: unknown[] }).buyers).toHaveLength(1);
    });

    it('404 para item inexistente', () =>
      http()
        .get('/analytics/items/naoExiste/top-buyers')
        .set('Cookie', authCookie)
        .expect(404));
  });

  describe('GET items/:itemId/series', () => {
    it('bucketiza em São Paulo e exclui o histórico, com baseline explícito (CA7, §2.3)', async () => {
      const res = await http()
        .get('/analytics/items/caixaA/series')
        .set('Cookie', authCookie)
        .expect(200);

      const body = res.body as {
        bucket: string;
        points: Array<{ at: string; qty: number; revenue: string }>;
        excludedHistorical: { qty: number; revenue: string };
      };
      expect(body.bucket).toBe('day');

      const days = body.points.map((p) => p.at);
      // A venda 23:30 BRT do dia 10 fica no bucket do dia 10, não do 11.
      expect(days).toEqual(['2026-03-10', '2026-03-15', '2026-03-20']);
      // Nenhum ponto datado no passado da migração.
      expect(days).not.toContain('2025-01-01');

      const d10 = body.points.find((p) => p.at === '2026-03-10')!;
      expect(d10.qty).toBe(2);
      expect(d10.revenue).toBe('100.00');

      // 0.10 + 0.20 fecha exatamente 0.30 (§2.5).
      const d20 = body.points.find((p) => p.at === '2026-03-20')!;
      expect(d20.revenue).toBe('0.30');

      // O histórico não some: vira baseline textual.
      expect(body.excludedHistorical.qty).toBe(300);
      expect(body.excludedHistorical.revenue).toBe('36000.00');
    });

    it('período sem vendas: points vazio mas baseline preservado', async () => {
      const res = await http()
        .get('/analytics/items/caixaA/series?from=2020-01-01&to=2020-01-31')
        .set('Cookie', authCookie)
        .expect(200);
      const body = res.body as {
        points: unknown[];
        excludedHistorical: { qty: number };
      };
      expect(body.points).toHaveLength(0);
      expect(body.excludedHistorical.qty).toBe(300);
    });

    it('item só com histórico: série vazia, baseline presente', async () => {
      const res = await http()
        .get('/analytics/items/caixaC/series')
        .set('Cookie', authCookie)
        .expect(200);
      const body = res.body as {
        points: unknown[];
        excludedHistorical: { qty: number; revenue: string };
      };
      expect(body.points).toHaveLength(0);
      expect(body.excludedHistorical.qty).toBe(5);
      expect(body.excludedHistorical.revenue).toBe('500.00');
    });

    it('aceita bucket=week', async () => {
      const res = await http()
        .get('/analytics/items/caixaA/series?bucket=week')
        .set('Cookie', authCookie)
        .expect(200);
      expect((res.body as { bucket: string }).bucket).toBe('week');
    });

    it('400 para janela ampla demais em bucket=day (§2.8)', () =>
      http()
        .get(
          '/analytics/items/caixaA/series?from=2000-01-01&to=2026-12-31&bucket=day',
        )
        .set('Cookie', authCookie)
        .expect(400));

    it('400 para bucket inválido', () =>
      http()
        .get('/analytics/items/caixaA/series?bucket=hour')
        .set('Cookie', authCookie)
        .expect(400));
  });

  describe('validação de período (comum às três rotas)', () => {
    it('400 idêntico para from > to', async () => {
      const bad = '?from=2026-03-20&to=2026-03-10';
      await http()
        .get(`/analytics/categories/1/items${bad}`)
        .set('Cookie', authCookie)
        .expect(400);
      await http()
        .get(`/analytics/items/caixaA/top-buyers${bad}`)
        .set('Cookie', authCookie)
        .expect(400);
      await http()
        .get(`/analytics/items/caixaA/series${bad}`)
        .set('Cookie', authCookie)
        .expect(400);
    });

    it('400 para data fora do formato YYYY-MM-DD', () =>
      http()
        .get('/analytics/categories/1/items?from=03/2026')
        .set('Cookie', authCookie)
        .expect(400));

    it('400 para query param desconhecido (whitelist)', () =>
      http()
        .get('/analytics/categories/1/items?foo=bar')
        .set('Cookie', authCookie)
        .expect(400));
  });
});

function sale(
  itemId: string,
  playerUuid: string,
  nicknameAtPurchase: string,
  totalPrice: string,
  qtd: number,
  purchasedAtIso: string,
): typeof sales.$inferInsert {
  return {
    id: randomUUID(),
    itemId,
    playerUuid,
    nicknameAtPurchase,
    totalPrice,
    qtd,
    purchasedAt: new Date(purchasedAtIso),
    historicalImport: false,
  };
}

function historical(
  itemId: string,
  playerUuid: string,
  nicknameAtPurchase: string,
  totalPrice: string,
  qtd: number,
  purchasedAtIso: string,
): typeof sales.$inferInsert {
  return {
    ...sale(
      itemId,
      playerUuid,
      nicknameAtPurchase,
      totalPrice,
      qtd,
      purchasedAtIso,
    ),
    historicalImport: true,
  };
}
