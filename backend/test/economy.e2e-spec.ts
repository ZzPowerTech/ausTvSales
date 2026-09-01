import { INestApplication } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { DRIZZLE, type DrizzleDB } from '../src/db/database.module';
import {
  categories,
  items,
  playerDimension,
  playerDimensionSyncs,
  players,
  sales,
} from '../src/db/schema';
import { createAuthenticatedApp } from './e2e-utils';

/**
 * The economy layer end to end (story S9.1, E1 and E2).
 *
 * ## What only this suite can prove
 *
 * That the SQL runs. The unit tests stub the Drizzle handle, so they exercise
 * the grouping and the degradation rules and say nothing at all about whether
 * `(sum(total_price) * 100)::bigint` is valid Postgres or whether the month
 * boundaries land where they should. Both are the kind of thing that fails only
 * against a real server, which is exactly where this suite runs.
 *
 * It also pins the two rules that are business decisions rather than mechanics:
 * historical imports stay out of every figure, and the cohort denominator is the
 * cohort rather than the buyers.
 */
describe('Economy (e2e)', () => {
  let app: INestApplication<App>;
  let authCookie: string;
  let db: DrizzleDB;

  const PREMIUM = '11111111-1111-4111-8111-000000000001';
  const PREMIUM_2 = '11111111-1111-4111-8111-000000000002';
  const BEDROCK = '00000000-0000-0000-0009-000000000003';
  /** In the dimension, never bought anything — the denominator's whole point. */
  const SILENT = '11111111-1111-4111-8111-000000000004';

  const ITEM = 'economyE2eItem';

  beforeAll(async () => {
    ({ app, authCookie } = await createAuthenticatedApp());
    db = app.get<DrizzleDB>(DRIZZLE);

    // Same isolation the analytics suite uses: each e2e file truncates what it
    // owns before seeding, so the order jest happens to run them in never
    // decides whether a suite passes. `maxWorkers: 1` makes that safe.
    await db.execute(
      sql`TRUNCATE sales, items, players, categories, player_dimension, player_dimension_syncs RESTART IDENTITY CASCADE`,
    );

    const [category] = await db
      .insert(categories)
      .values({ name: `Economia e2e ${Date.now()}` })
      .returning();
    await db
      .insert(items)
      .values({
        itemId: ITEM,
        displayName: 'Item e2e',
        categoryId: category.id,
      })
      .onConflictDoNothing();

    await db
      .insert(players)
      .values([
        { uuid: PREMIUM, lastKnownNickname: 'um' },
        { uuid: PREMIUM_2, lastKnownNickname: 'dois' },
        { uuid: BEDROCK, lastKnownNickname: 'tres' },
      ])
      .onConflictDoNothing();

    await db.insert(sales).values([
      // 60.00 from a Java premium player, inside the window.
      sale(
        '11111111-0000-4000-8000-000000000001',
        PREMIUM,
        '60.00',
        '2026-03-10',
      ),
      // 20.00 from a second Java premium player.
      sale(
        '11111111-0000-4000-8000-000000000002',
        PREMIUM_2,
        '20.00',
        '2026-03-12',
      ),
      // 20.00 from a Bedrock player.
      sale(
        '11111111-0000-4000-8000-000000000003',
        BEDROCK,
        '20.00',
        '2026-03-15',
      ),
      // A historical import: excluded from every figure, republished apart.
      {
        ...sale(
          '11111111-0000-4000-8000-000000000004',
          PREMIUM,
          '999.00',
          '2025-01-01',
        ),
        historicalImport: true,
      },
    ]);
  });

  afterAll(async () => {
    await app.close();
  });

  function sale(
    id: string,
    playerUuid: string,
    totalPrice: string,
    day: string,
  ) {
    return {
      id,
      itemId: ITEM,
      playerUuid,
      nicknameAtPurchase: 'nick',
      totalPrice,
      qtd: 1,
      purchasedAt: new Date(`${day}T15:00:00.000Z`),
      historicalImport: false,
    };
  }

  describe('the routes are behind the session', () => {
    it.each(['/economy/revenue', '/economy/first-spend'])(
      'answers 401 on %s without a session',
      async (path) => {
        await request(app.getHttpServer()).get(path).expect(401);
      },
    );
  });

  describe('E1 — revenue, before the dimension has ever synced', () => {
    it('still answers by platform, and says the cohort axis is out', async () => {
      const response = await request(app.getHttpServer())
        .get('/economy/revenue')
        .set('Cookie', authCookie)
        .expect(200);

      const body = response.body as {
        totals: { revenue: string; sales: number; buyers: number };
        byPlatform: { platform: string; revenue: string; share: unknown }[];
        byCohort: unknown;
        cohortUnavailableReason?: string;
        excludedHistorical: { sales: number; revenue: string };
      };

      // 60 + 20 + 20, with the 999.00 historical row excluded.
      expect(body.totals).toEqual({
        revenue: '100.00',
        sales: 3,
        buyers: 3,
      });
      expect(body.byPlatform).toEqual([
        {
          platform: 'bedrock',
          revenue: '20.00',
          sales: 1,
          buyers: 1,
          share: { percent: 20, n: 1 },
        },
        {
          platform: 'java_premium',
          revenue: '80.00',
          sales: 2,
          buyers: 2,
          share: { percent: 80, n: 2 },
        },
      ]);
      expect(body.byCohort).toBeNull();
      expect(body.cohortUnavailableReason).toContain('nunca foi preenchida');
      expect(body.excludedHistorical).toEqual({
        sales: 1,
        revenue: '999.00',
      });
    });

    it('applies the window in São Paulo local time', async () => {
      const response = await request(app.getHttpServer())
        .get('/economy/revenue?from=2026-03-11&to=2026-03-12')
        .set('Cookie', authCookie)
        .expect(200);

      const body = response.body as { totals: { revenue: string } };
      expect(body.totals.revenue).toBe('20.00');
    });

    it('rejects an inverted window', async () => {
      await request(app.getHttpServer())
        .get('/economy/revenue?from=2026-03-12&to=2026-03-01')
        .set('Cookie', authCookie)
        .expect(400);
    });
  });

  describe('E2 — first spend, before the dimension has ever synced', () => {
    it('is null with the reason rather than an empty list', async () => {
      const response = await request(app.getHttpServer())
        .get('/economy/first-spend')
        .set('Cookie', authCookie)
        .expect(200);

      const body = response.body as {
        byCohort: unknown;
        unavailableReason?: string;
        byFunnelPosition: unknown;
        funnelPositionUnavailableReason: string;
      };

      expect(body.byCohort).toBeNull();
      expect(body.unavailableReason).toContain('nunca foi preenchida');
      // The blocked half of E2 is published as blocked, not omitted.
      expect(body.byFunnelPosition).toBeNull();
      expect(body.funnelPositionUnavailableReason).toContain(
        'posicao do jogador no tutorial',
      );
    });
  });

  describe('with a synced dimension', () => {
    beforeAll(async () => {
      await db
        .insert(playerDimension)
        .values([
          dimension(PREMIUM, '2026-01-05', '2026-04-01'),
          dimension(PREMIUM_2, '2026-01-20', '2026-04-01'),
          dimension(BEDROCK, '2026-02-02', '2026-04-01'),
          dimension(SILENT, '2026-01-25', '2026-02-01'),
        ]);
      await db.insert(playerDimensionSyncs).values({
        status: 'ok',
        rowsRead: 4,
        rowsWritten: 4,
        rowsDropped: 0,
        durationMs: 12,
      });
    });

    function dimension(uuid: string, registered: string, lastSeen: string) {
      return {
        uuid,
        platform: uuid.startsWith('00000000-0000-0000-0009-')
          ? 'bedrock'
          : 'java_premium',
        registeredAt: new Date(`${registered}T15:00:00.000Z`),
        lastSeenAt: new Date(`${lastSeen}T15:00:00.000Z`),
      };
    }

    it('breaks revenue down by cohort, with coverage published', async () => {
      const response = await request(app.getHttpServer())
        .get('/economy/revenue')
        .set('Cookie', authCookie)
        .expect(200);

      const body = response.body as {
        byCohort: {
          cohort: string | null;
          platform: string;
          revenue: string;
        }[];
        cohortCoverage: {
          salesWithCohort: number;
          salesTotal: number;
          revenueWithCohort: string;
        };
      };

      expect(body.byCohort).toEqual([
        {
          cohort: '2026-01',
          platform: 'java_premium',
          revenue: '80.00',
          sales: 2,
          buyers: 2,
        },
        {
          cohort: '2026-02',
          platform: 'bedrock',
          revenue: '20.00',
          sales: 1,
          buyers: 1,
        },
      ]);
      // Every sale matched a cohort here, and the coverage says so explicitly
      // rather than leaving a reader to assume it.
      expect(body.cohortCoverage).toEqual({
        salesWithCohort: 3,
        salesTotal: 3,
        revenueWithCohort: '100.00',
      });
    });

    it('divides by the cohort, so a player who never bought is in the base', async () => {
      const response = await request(app.getHttpServer())
        .get('/economy/first-spend?from=2026-01&to=2026-02')
        .set('Cookie', authCookie)
        .expect(200);

      const body = response.body as {
        byCohort: {
          cohort: string;
          platform: string;
          cohortSize: number;
          spenders: number;
          everSpent: { percent: number | null; n: number | null };
          medianDaysToFirstSpend: number | null;
          p90DaysToFirstSpend: number | null;
        }[];
      };

      const january = body.byCohort.find((c) => c.cohort === '2026-01');
      // Three players registered in January; one of them never bought.
      expect(january).toMatchObject({
        cohortSize: 3,
        spenders: 2,
        everSpent: { percent: 66.7, n: 3 },
      });
      // PREMIUM waited 64 days (2026-01-05 → 2026-03-10) and PREMIUM_2 waited
      // 51 (2026-01-20 → 2026-03-12). Nearest-rank p50 over two observations is
      // the lower one — a day count somebody actually waited, which is the
      // whole reason the percentile is not interpolated.
      expect(january?.medianDaysToFirstSpend).toBe(51);
      expect(january?.p90DaysToFirstSpend).toBe(64);
    });

    it('restricts to the cohort window asked for', async () => {
      const response = await request(app.getHttpServer())
        .get('/economy/first-spend?from=2026-02&to=2026-02')
        .set('Cookie', authCookie)
        .expect(200);

      const body = response.body as { byCohort: { cohort: string }[] };
      expect(body.byCohort.map((c) => c.cohort)).toEqual(['2026-02']);
    });

    it('rejects a day where a cohort month is expected', async () => {
      await request(app.getHttpServer())
        .get('/economy/first-spend?from=2026-01-15')
        .set('Cookie', authCookie)
        .expect(400);
    });
  });
});
