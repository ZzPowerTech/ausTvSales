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
  tutorialPlayerPosition,
  tutorialSyncs,
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

  /**
   * 2026-03-11 02:00 UTC is 2026-03-10 23:00 in São Paulo.
   *
   * The one fixture that can tell `AT TIME ZONE 'America/Sao_Paulo'` from its
   * absence. Every other sale here sits at 15:00 UTC — midday in both zones —
   * so the test named "applies the window in São Paulo local time" passed
   * byte-identically with the timezone conversion deleted. This one does not.
   */
  const LATE_NIGHT = '2026-03-11T02:00:00.000Z';

  beforeAll(async () => {
    ({ app, authCookie } = await createAuthenticatedApp());
    db = app.get<DrizzleDB>(DRIZZLE);

    // Same isolation the analytics suite uses: each e2e file truncates what it
    // owns before seeding, so the order jest happens to run them in never
    // decides whether a suite passes. `maxWorkers: 1` makes that safe.
    await db.execute(
      sql`TRUNCATE sales, items, players, categories, player_dimension, player_dimension_syncs, tutorial_player_position, tutorial_syncs RESTART IDENTITY CASCADE`,
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
      // 23:00 BRT on the 10th. A UTC bucket would file it on the 11th.
      {
        ...sale(
          '11111111-0000-4000-8000-000000000005',
          PREMIUM_2,
          '7.00',
          '2026-03-10',
        ),
        purchasedAt: new Date(LATE_NIGHT),
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

      // 60 + 20 + 20 + 7, with the 999.00 historical row excluded.
      expect(body.totals).toEqual({
        revenue: '107.00',
        sales: 4,
        buyers: 3,
      });
      expect(body.byPlatform).toEqual([
        {
          platform: 'bedrock',
          revenue: '20.00',
          sales: 1,
          buyers: 1,
          share: { percent: 18.7, n: 1 },
        },
        {
          platform: 'java_premium',
          revenue: '87.00',
          sales: 3,
          buyers: 2,
          share: { percent: 81.3, n: 3 },
        },
      ]);
      expect(body.byCohort).toBeNull();
      expect(body.cohortUnavailableReason).toContain('nunca foi preenchida');
      expect(body.excludedHistorical).toEqual({
        sales: 1,
        revenue: '999.00',
      });
    });

    it('applies the window in São Paulo local time, not UTC', async () => {
      // The 7.00 sale is 2026-03-11 02:00 UTC = 2026-03-10 23:00 BRT. Asking
      // for the 11th onwards must NOT include it; a UTC bucket would.
      const from11 = await request(app.getHttpServer())
        .get('/economy/revenue?from=2026-03-11&to=2026-03-12')
        .set('Cookie', authCookie)
        .expect(200);

      expect(
        (from11.body as { totals: { revenue: string } }).totals.revenue,
      ).toBe('20.00');

      // And asking for the 10th alone must include it.
      const on10 = await request(app.getHttpServer())
        .get('/economy/revenue?from=2026-03-10&to=2026-03-10')
        .set('Cookie', authCookie)
        .expect(200);

      // 60.00 from the 10th plus the 7.00 late-night sale.
      expect(
        (on10.body as { totals: { revenue: string } }).totals.revenue,
      ).toBe('67.00');
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
      await db.insert(playerDimension).values([
        dimension(PREMIUM, '2026-01-05', '2026-04-01'),
        dimension(PREMIUM_2, '2026-01-20', '2026-04-01'),
        // Registered 2026-02-01 01:00 UTC = 2026-01-31 22:00 BRT. The cohort
        // is JANUARY, and only the Sao Paulo truncation puts it there — this
        // is the one dimension row that can tell the two apart.
        dimension(
          BEDROCK,
          '2026-02-02',
          '2026-04-01',
          new Date('2026-02-01T01:00:00.000Z'),
        ),
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

    function dimension(
      uuid: string,
      registered: string,
      lastSeen: string,
      registeredAt = new Date(`${registered}T15:00:00.000Z`),
    ) {
      return {
        uuid,
        platform: uuid.startsWith('00000000-0000-0000-0009-')
          ? 'bedrock'
          : 'java_premium',
        registeredAt,
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
          // The Bedrock player registered at 2026-02-01 01:00 UTC, which is
          // 2026-01-31 22:00 BRT — January, not February. A UTC truncation
          // would put this row in its own `2026-02` bucket.
          cohort: '2026-01',
          platform: 'bedrock',
          revenue: '20.00',
          sales: 1,
          buyers: 1,
        },
        {
          cohort: '2026-01',
          platform: 'java_premium',
          revenue: '87.00',
          sales: 3,
          buyers: 2,
        },
      ]);
      // Every sale matched a cohort here, and the coverage says so explicitly
      // rather than leaving a reader to assume it.
      expect(body.cohortCoverage).toEqual({
        salesWithCohort: 4,
        salesTotal: 4,
        revenueWithCohort: '107.00',
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

      const january = body.byCohort.find(
        (c) => c.cohort === '2026-01' && c.platform === 'java_premium',
      );
      // Three Java premium players registered in January; one never bought.
      expect(january).toMatchObject({
        cohortSize: 3,
        spenders: 2,
        everSpent: { percent: 66.7, n: 3 },
      });
      // PREMIUM waited 64 days (2026-01-05 15:00Z → 2026-03-10 15:00Z) and
      // PREMIUM_2 waited 49 (2026-01-20 15:00Z → the late-night sale at
      // 2026-03-11 02:00Z, which is 49 days and 11 hours, floored). Nearest-rank
      // p50 over two observations is the lower one — a day count somebody
      // actually waited, which is the whole reason it is not interpolated.
      expect(january?.medianDaysToFirstSpend).toBe(49);
      expect(january?.p90DaysToFirstSpend).toBe(64);
    });

    it('restricts to the cohort window asked for', async () => {
      const response = await request(app.getHttpServer())
        .get('/economy/first-spend?from=2026-01&to=2026-01')
        .set('Cookie', authCookie)
        .expect(200);

      const body = response.body as { byCohort: { cohort: string }[] };
      // Everyone registered in January once the São Paulo truncation is applied.
      expect(new Set(body.byCohort.map((c) => c.cohort))).toEqual(
        new Set(['2026-01']),
      );
    });

    it('counts a buyer whose first purchase predates their registration', async () => {
      // They demonstrably bought. Leaving them out of `spenders` published a
      // share whose numerator silently dropped real buyers — and `registerDate`
      // is when Plan first saw the player, not when the account was created,
      // while `sales` reaches further back.
      const response = await request(app.getHttpServer())
        .get('/economy/first-spend?from=2026-01&to=2026-01')
        .set('Cookie', authCookie)
        .expect(200);

      const body = response.body as {
        byCohort: {
          platform: string;
          spenders: number;
          beforeRegistration: number;
          everSpent: { percent: number | null };
        }[];
      };

      const bedrock = body.byCohort.find((c) => c.platform === 'bedrock');
      // Registered 2026-01-31 22:00 BRT, bought on 2026-03-15: a normal
      // interval, so nothing lands in `beforeRegistration` here.
      expect(bedrock).toMatchObject({
        spenders: 1,
        beforeRegistration: 0,
        everSpent: { percent: 100 },
      });
    });

    it('says the funnel-position half cannot be measured before the ETL wrote it', async () => {
      // Every environment starts here, and it must read as "cannot measure"
      // rather than as a list of zeroes — the confusion the epic exists for.
      const response = await request(app.getHttpServer())
        .get('/economy/first-spend?from=2026-01&to=2026-02')
        .set('Cookie', authCookie)
        .expect(200);

      const body = response.body as {
        byFunnelPosition: unknown;
        byFurthestStep: unknown;
        funnelPositionUnavailableReason: string;
      };

      expect(body.byFunnelPosition).toBeNull();
      expect(body.byFurthestStep).toBeNull();
      expect(body.funnelPositionUnavailableReason).toContain(
        'TUTORIAL_POSITION_ENABLED',
      );
    });

    it('rejects a day where a cohort month is expected', async () => {
      await request(app.getHttpServer())
        .get('/economy/first-spend?from=2026-01-15')
        .set('Cookie', authCookie)
        .expect(400);
    });
  });

  describe('with the tutorial position written', () => {
    beforeAll(async () => {
      await db.insert(tutorialPlayerPosition).values([
        // Completed the tutorial, and bought.
        position(PREMIUM, '33tutorial', 32, true),
        // Stopped at step 3, and bought.
        position(PREMIUM_2, '03tutorial', 2, false),
        // Stopped at step 3, never bought. The base of that step is BOTH.
        position(SILENT, '03tutorial', 2, false),
      ]);

      await db.insert(tutorialSyncs).values({
        status: 'ok',
        filesScanned: 3,
        filesFailed: 0,
        playersInTutorial: 3,
        daysWritten: 1,
        questsInCatalogue: 33,
        finalQuestId: '33tutorial',
        stepOrder: '01tutorial,02tutorial,03tutorial,33tutorial',
        positionsWritten: 3,
      });
    });

    function position(
      uuid: string,
      furthestQuestId: string,
      furthestIndex: number,
      completedTutorial: boolean,
    ) {
      return {
        playerUuid: uuid,
        platform: uuid.startsWith('00000000-0000-0000-0009-')
          ? 'bedrock'
          : 'java_premium',
        questsTouched: furthestIndex + 1,
        questsCompleted: completedTutorial ? furthestIndex + 1 : furthestIndex,
        furthestQuestId,
        furthestIndex,
        completedTutorial,
        enteredOn: '2026-01-15',
      };
    }

    it('answers the question the spec asks, with the base being the position', async () => {
      const response = await request(app.getHttpServer())
        .get('/economy/first-spend?from=2026-01&to=2026-02')
        .set('Cookie', authCookie)
        .expect(200);

      const body = response.body as {
        byFunnelPosition: {
          position: string;
          players: number;
          spenders: number;
          everSpent: { percent: number | null; n: number | null };
          revenue: string;
        }[];
        byFurthestStep: {
          step: string;
          players: number;
          spenders: number;
          revenue: string;
        }[];
        stepOrder: string[];
      };

      const byPosition = new Map(
        body.byFunnelPosition.map((p) => [p.position, p]),
      );

      // PREMIUM completed and bought 60.00 + 7.00 (the late-night sale is
      // PREMIUM_2's, so it does not land here).
      expect(byPosition.get('concluiu')).toMatchObject({
        players: 1,
        spenders: 1,
        everSpent: { percent: 100, n: 1 },
        revenue: '60.00',
      });

      // Two players stopped at step 3 and one of them bought. The denominator
      // is both — joining from the buyers would make it 100% by construction.
      expect(byPosition.get('entrou_nao_concluiu')).toMatchObject({
        players: 2,
        spenders: 1,
        everSpent: { percent: 50, n: 2 },
      });

      // BEDROCK is in `player_dimension` and not in the position table, so it
      // has a real base of its own rather than being the silence between the
      // other two groups.
      expect(byPosition.get('nao_entrou')).toMatchObject({
        players: 1,
        spenders: 1,
        revenue: '20.00',
      });

      // The half no grouping can answer: "quem trava no passo 03 gasta alguma
      // coisa?"
      const step03 = body.byFurthestStep.find((s) => s.step === '03tutorial');
      expect(step03).toMatchObject({ players: 2, spenders: 1 });

      // The inferred step order travels, so it can be checked against the game.
      expect(body.stepOrder).toEqual([
        '01tutorial',
        '02tutorial',
        '03tutorial',
        '33tutorial',
      ]);
    });
  });
});
