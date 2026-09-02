import { INestApplication } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { DRIZZLE, type DrizzleDB } from '../src/db/database.module';
import {
  playerDimension,
  playerPaymentSyncs,
  playerPayments,
} from '../src/db/schema';
import { createAuthenticatedApp } from './e2e-utils';

/**
 * E3 and E4 end to end (story S9.1).
 *
 * ## What only this suite can prove
 *
 * That the social SQL runs — in particular the `LEFT JOIN` whose `ON` matches a
 * payment against **either side** of a player and inside an interval measured
 * from that player's own registration. That is the most intricate statement in
 * the module and the unit tests, which stub the Drizzle handle, say nothing
 * about whether it parses.
 *
 * It also pins the composite primary key of `player_payments` against a real
 * server: the tiebreak ordinal only works if Postgres actually accepts two rows
 * that differ in nothing but that column.
 */
describe('Economy social (e2e)', () => {
  let app: INestApplication<App>;
  let authCookie: string;
  let db: DrizzleDB;

  /** Registered long enough ago that D7 is mature. */
  const SOCIAL = '11111111-1111-4111-8111-00000000aa01';
  const TUTORIAL_ONLY = '11111111-1111-4111-8111-00000000aa02';
  const SILENT = '11111111-1111-4111-8111-00000000aa03';
  /**
   * Receives the tutorial amount and sends a spontaneous one, and only the
   * receive half is paired.
   *
   * This player exists to make the type filter observable. Every other fixture
   * here is a matched pair, and a matched pair CANNOT show the difference: the
   * two rows are negations of each other, the SQL groups on `abs(amount)`, so
   * reading both simply doubles each count — and the group is picked by `> 0`,
   * which doubling preserves. A test built on paired rows passes with the filter
   * and passes without it.
   *
   * With two halves carrying DIFFERENT amounts, the readings diverge:
   * filtered → `tutorial_only` (only the 100 is seen); unfiltered → the -250 is
   * seen too and the player becomes `spontaneous`.
   */
  const CROSS = '11111111-1111-4111-8111-00000000aa04';

  const REGISTERED = new Date('2026-01-10T15:00:00.000Z');
  /** Survived past D7. */
  const LATE = new Date('2026-03-10T15:00:00.000Z');
  /** Left within the week. */
  const EARLY = new Date('2026-01-12T15:00:00.000Z');

  beforeAll(async () => {
    ({ app, authCookie } = await createAuthenticatedApp());
    db = app.get<DrizzleDB>(DRIZZLE);

    await db.execute(
      sql`TRUNCATE player_dimension, player_payments, player_payment_syncs, account_creations_daily RESTART IDENTITY CASCADE`,
    );

    await db
      .insert(playerDimension)
      .values([
        dimension(SOCIAL, REGISTERED, LATE),
        dimension(TUTORIAL_ONLY, REGISTERED, LATE),
        dimension(SILENT, REGISTERED, EARLY),
        dimension(CROSS, REGISTERED, LATE),
      ]);
  });

  afterAll(async () => {
    await app.close();
  });

  function dimension(uuid: string, registeredAt: Date, lastSeenAt: Date) {
    return {
      uuid,
      platform: 'java_premium',
      registeredAt,
      lastSeenAt,
    };
  }

  /**
   * Feed fixtures are anchored to **now**, not to a constant.
   *
   * `MAX_FEED_WINDOW_DAYS` is 366, so a payment pinned to a fixed 2026-01-10
   * falls out of every reachable window once the wall clock passes 2027-01-11 —
   * and no larger `days` value exists to compensate. The contact fixtures stay
   * anchored to `REGISTERED`, because E3 measures against each player's own
   * registration and does not care where "now" is.
   */
  const RECENT = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

  function payment(over: {
    source?: string;
    receiver?: string;
    amount?: number;
    minutesAfter?: number;
    ordinal?: number;
    transactionType?: string;
    occurredAt?: Date;
  }) {
    return {
      transactionType: over.transactionType ?? 'PAY_RECEIVER',
      source: over.source ?? 'someone-else',
      receiver: over.receiver ?? SOCIAL,
      amount: over.amount ?? 250,
      occurredAt:
        over.occurredAt ??
        new Date(REGISTERED.getTime() + (over.minutesAfter ?? 5) * 60_000),
      ordinal: over.ordinal ?? 0,
    };
  }

  describe('the routes are behind the session', () => {
    it.each(['/economy/social-contact', '/economy/payments/feed'])(
      'answers 401 on %s without a session',
      async (path) => {
        // The feed carries player uuids and transaction values; spec §8 keeps
        // both off any public surface, and the absence of `@Public()` is what
        // enforces it.
        await request(app.getHttpServer()).get(path).expect(401);
      },
    );
  });

  describe('before the payments ETL has ever run', () => {
    it('E3 says it cannot measure, rather than showing empty groups', async () => {
      const response = await request(app.getHttpServer())
        .get('/economy/social-contact?from=2026-01&to=2026-01')
        .set('Cookie', authCookie)
        .expect(200);

      const body = response.body as {
        groups: unknown;
        unavailableReason?: string;
        d7Semantics: string;
        tutorialSeparationCaveat: string;
      };

      expect(body.groups).toBeNull();
      expect(body.unavailableReason).toContain('player_payments');
      // Both caveats are part of the contract, present even when there is no
      // number to caveat.
      expect(body.d7Semantics).toContain('INTERVALO DE SOBREVIVENCIA');
      expect(body.tutorialSeparationCaveat).toContain('ASSINATURA DE VALOR');
    });

    it('E4 returns null with a reason, never an empty feed', async () => {
      const response = await request(app.getHttpServer())
        .get('/economy/payments/feed')
        .set('Cookie', authCookie)
        .expect(200);

      const body = response.body as {
        payments: unknown;
        unavailableReason?: string;
        disclaimer: string;
      };

      expect(body.payments).toBeNull();
      expect(body.unavailableReason).toContain('nunca completou');
      expect(body.disclaimer).toContain('nunca acusacao automatica');
    });
  });

  describe('with payments copied', () => {
    beforeAll(async () => {
      await db.insert(playerPayments).values([
        // Spontaneous: an amount that does not match the tutorial signature.
        payment({ receiver: SOCIAL, amount: 250, minutesAfter: 5 }),
        // Tutorial-shaped: exactly the `10tutorial` amount.
        payment({ receiver: TUTORIAL_ONLY, amount: 100, minutesAfter: 5 }),
        // Outside the contact window: must not count as first-minutes contact.
        payment({ receiver: SILENT, amount: 300, minutesAfter: 60 * 24 }),
        // Two byte-identical payments, separated only by the ordinal. This is
        // the deliberate collision of criterion 8, against a real primary key.
        payment({
          source: 'twin-sender',
          receiver: 'twin-receiver',
          amount: 7,
          minutesAfter: 10,
          ordinal: 0,
        }),
        payment({
          source: 'twin-sender',
          receiver: 'twin-receiver',
          amount: 7,
          minutesAfter: 10,
          ordinal: 1,
        }),
        // Anchored to now, so the feed window can reach it for as long as this
        // suite exists.
        payment({
          source: 'recent-sender',
          receiver: 'recent-receiver',
          amount: 42,
          occurredAt: RECENT,
        }),
        // The `PAY_SENDER` halves of the first three payments, with `source` and
        // `receiver` SWAPPED and the amount negated — the shape a real
        // PlayerPoints log has, confirmed against a live payment on 2026-09-02.
        //
        // Every fixture in this file used to be receiver-only, which is why the
        // double-count went unseen: with only one row per payment, a join that
        // reads both types is indistinguishable from one that reads the right
        // one. These three rows are the property that tells them apart.
        payment({
          transactionType: 'PAY_SENDER',
          source: SOCIAL,
          receiver: 'someone-else',
          amount: -250,
          minutesAfter: 5,
        }),
        payment({
          transactionType: 'PAY_SENDER',
          source: TUTORIAL_ONLY,
          receiver: 'someone-else',
          amount: -100,
          minutesAfter: 5,
        }),
        payment({
          transactionType: 'PAY_SENDER',
          source: SILENT,
          receiver: 'someone-else',
          amount: -300,
          minutesAfter: 60 * 24,
        }),
        // CROSS: the two halves carry different amounts, which is the only shape
        // that makes the type filter observable. See the constant.
        payment({ receiver: CROSS, amount: 100, minutesAfter: 5 }),
        payment({
          transactionType: 'PAY_SENDER',
          source: CROSS,
          receiver: 'someone-else',
          amount: -250,
          minutesAfter: 5,
        }),
      ]);

      await db.insert(playerPaymentSyncs).values({
        status: 'ok',
        paymentsRead: 11,
        paymentsWritten: 11,
        senderRows: 4,
        receiverRows: 7,
        creationsRead: 0,
        creationDaysWritten: 0,
        durationMs: 20,
        sourceQueryMs: 10,
      });
    });

    it('accepts two rows differing only in the tiebreak ordinal', async () => {
      const result = await db.execute<{ total: number }>(
        sql`SELECT count(*)::int AS total FROM ${playerPayments}
             WHERE ${playerPayments.source} = 'twin-sender'`,
      );

      // If the composite key were missing the ordinal, the second insert would
      // have failed above and one payment would have been silently lost.
      expect(result.rows[0].total).toBe(2);
    });

    it('splits the three contact groups, each with its own base', async () => {
      const response = await request(app.getHttpServer())
        .get('/economy/social-contact?from=2026-01&to=2026-01')
        .set('Cookie', authCookie)
        .expect(200);

      const body = response.body as {
        contactWindowMinutes: number;
        tutorialPaymentAmount: number;
        groups: {
          group: string;
          players: number;
          immature: number;
          d7: { percent: number | null; n: number | null };
        }[];
      };

      expect(body.contactWindowMinutes).toBe(60);
      expect(body.tutorialPaymentAmount).toBe(100);

      const byGroup = new Map(body.groups.map((g) => [g.group, g]));
      expect(byGroup.get('spontaneous')).toMatchObject({
        players: 1,
        d7: { percent: 100, n: 1 },
      });
      // The tutorial payment is separated from spontaneous contact, which is a
      // requirement of the story rather than a refinement. Two players: the one
      // with only a tutorial payment, and CROSS, whose spontaneous half is on
      // the ledger row this metric does not read.
      expect(byGroup.get('tutorial_only')).toMatchObject({
        players: 2,
        d7: { percent: 100, n: 2 },
      });
      // The player whose only payment fell outside the first-minutes window.
      expect(byGroup.get('none')).toMatchObject({
        players: 1,
        d7: { percent: 0, n: 1 },
      });
    });

    it('reads one ledger row per payment, not both', async () => {
      // A first attempt at this test used a matched pair and proved nothing: the
      // two rows negate each other, the SQL groups on `abs(amount)`, and the
      // group is picked by `> 0` — so reading both merely doubles both counts
      // and the published group is identical either way. It passed with the
      // filter and passed without it.
      //
      // CROSS is the shape that discriminates. Its `PAY_RECEIVER` half is the
      // tutorial amount and its unpaired `PAY_SENDER` half is a spontaneous one,
      // so the two readings put it in DIFFERENT groups: `tutorial_only` when the
      // type is pinned, `spontaneous` when both rows are read.
      const rows = await db.execute<{ total: number }>(
        sql`SELECT count(*)::int AS total FROM ${playerPayments}
             WHERE ${playerPayments.receiver} = ${CROSS}
                OR ${playerPayments.source} = ${CROSS}`,
      );
      // Both rows really are in the table — otherwise this proves nothing.
      expect(rows.rows[0].total).toBe(2);

      const response = await request(app.getHttpServer())
        .get('/economy/social-contact?from=2026-01&to=2026-01')
        .set('Cookie', authCookie)
        .expect(200);

      const body = response.body as {
        groups: { group: string; players: number }[];
      };

      const byGroup = new Map(body.groups.map((g) => [g.group, g.players]));
      // 2 = TUTORIAL_ONLY + CROSS. Drop the filter and CROSS moves to
      // `spontaneous`, taking both of these numbers with it.
      expect(byGroup.get('tutorial_only')).toBe(2);
      expect(byGroup.get('spontaneous')).toBe(1);
    });

    it('shows the feed with the thresholds and the disclaimer', async () => {
      const response = await request(app.getHttpServer())
        // A week is enough to reach the `RECENT` payment, and it does not depend
        // on the wall clock staying near the seeded 2026-01-10.
        .get('/economy/payments/feed?days=7&limit=10')
        .set('Cookie', authCookie)
        .expect(200);

      const body = response.body as {
        windowSize: number;
        amountP95: number | null;
        thresholds: Record<string, number>;
        directionCaveat: string;
        payments: { from: string; to: string; amount: number; flags: [] }[];
      };

      expect(body.windowSize).toBe(1);
      // One payment is far below the floor for an outlier mark to mean anything.
      expect(body.amountP95).toBeNull();
      expect(body.thresholds.repeatedPair).toBe(3);
      expect(body.payments).toHaveLength(1);
      expect(body.payments[0]).toMatchObject({
        from: 'recent-sender',
        to: 'recent-receiver',
        amount: 42,
        flags: [],
      });
      // Both measurements travel with the data: the column swap (which is a trap
      // for any direct query, and outlives the direction being settled) and the
      // `SET` row that settled the direction itself.
      expect(body.directionCaveat).toContain('TROCAM');
      expect(body.directionCaveat).toContain('`source = NULL`');
      expect(body.directionCaveat).not.toContain('INFERIDA');
    });

    it('publishes the arrivals series with its caveat', async () => {
      const response = await request(app.getHttpServer())
        .get('/economy/account-creations?from=2026-01-01&to=2026-12-31')
        .set('Cookie', authCookie)
        .expect(200);

      const body = response.body as {
        days: { day: string; created: number }[] | null;
        caveat: string;
      };

      // Nothing was seeded into `account_creations_daily` by this suite, and the
      // provenance row says the ETL ran — so an empty range is a real answer
      // HERE. It would not be a real answer coming out of the ETL: a zero `SET`
      // read is refused before `replaceCreations` is ever called, precisely so
      // that this shape can never be produced by wiping the series.
      expect(body.days).toEqual([]);
      // The caveat is contractual: this counts accounts, not arrivals, and
      // reading a plugin's own series as reality is what produced the
      // "48 chegadas/mes" of the investigation.
      expect(body.caveat).toContain('RECONCILIACAO');
      expect(body.caveat).toContain('48 chegadas/mes');
    });

    it('rejects a window beyond the cap', async () => {
      // An unbounded window would dilute every percentile until nothing is ever
      // an outlier — a failure that is silent rather than loud.
      await request(app.getHttpServer())
        .get('/economy/payments/feed?days=99999')
        .set('Cookie', authCookie)
        .expect(400);
    });
  });
});
