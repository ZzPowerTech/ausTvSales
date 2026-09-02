import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../db/database.module';
import { playerDimension } from '../db/schema';
import { percentile, toDate } from './economy-math';
import type { EconomySourceState } from './economy.types';
import { PaymentsStore, type StoredPayment } from './payments.store';
import {
  FEED_DISCLAIMER,
  PAYMENT_DIRECTION_CAVEAT,
  type FeedPayment,
  type FlagMark,
  type PaymentsFeedReport,
} from './social.types';

const MS_PER_DAY = 86_400_000;

/**
 * Only `PAY_RECEIVER` rows are read.
 *
 * Each payment is logged twice — once from each side — so reading both types
 * would double every count in the window and every pair repetition with it. The
 * receiver side is the one carrying the positive amount, which is what a human
 * reads as "the payment".
 */
const CANONICAL_TYPE = 'PAY_RECEIVER';

/** Defaults, documented in `.env.example` as uncalibrated guesses. */
const DEFAULT_WINDOW_DAYS = 30;
const DEFAULT_LIMIT = 50;
const DEFAULT_REPEATED_PAIR = 3;
const DEFAULT_FUNDING_MANY = 4;
const DEFAULT_NEW_ACCOUNT_DAYS = 3;
/**
 * Below this many payments in the window, no outlier mark is issued.
 *
 * A 95th percentile over four observations is the maximum of four observations,
 * and marking it would flag the largest ordinary payment of a quiet month as an
 * anomaly. With ~3 payments a day (R4), a quiet window is the common case, not
 * the edge one.
 */
const DEFAULT_MIN_WINDOW_FOR_OUTLIER = 20;

/**
 * E4 — the admin-only payments feed with anomaly marks (spec §6.4).
 *
 * ## Why a plain chronological feed would be useless
 *
 * The spec says so directly: *"com ~3 pagamentos/dia, os 10 últimos cobrem 3
 * dias e repetem as mesmas pessoas. O valor está na marcação."* So the feed
 * exists for the marks, and the marks exist for four specific abuses — selling
 * for real money, funding an alt, a scam, and abuse of a give permission.
 *
 * ## Marking is signalling, never accusation
 *
 * Every mark publishes what was observed and what it was compared against, and
 * the disclaimer travels in the response. A flag without its numbers asks a
 * person to trust a threshold they cannot see, which is the opposite of leaving
 * the decision with them — and spec §6.4 is explicit that the decision is human.
 *
 * ## The thresholds are guesses, and are labelled as such
 *
 * None of the four has been calibrated against this server's own history. They
 * are in `.env.example` on the same shelf as the three from story S6.3, and the
 * first weeks of real use are what would turn them into calibration. Publishing
 * them in the payload is what makes that possible without reading the source.
 */
@Injectable()
export class PaymentsFeedService {
  private readonly logger = new Logger(PaymentsFeedService.name);

  private readonly repeatedPair: number;
  private readonly fundingMany: number;
  private readonly newAccountDays: number;
  private readonly minWindowForOutlier: number;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly payments: PaymentsStore,
    config: ConfigService,
  ) {
    this.repeatedPair =
      config.get<number>('ECONOMY_FEED_REPEATED_PAIR_MIN') ??
      DEFAULT_REPEATED_PAIR;
    this.fundingMany =
      config.get<number>('ECONOMY_FEED_FUNDING_MANY_MIN') ??
      DEFAULT_FUNDING_MANY;
    this.newAccountDays =
      config.get<number>('ECONOMY_FEED_NEW_ACCOUNT_DAYS') ??
      DEFAULT_NEW_ACCOUNT_DAYS;
    this.minWindowForOutlier =
      config.get<number>('ECONOMY_FEED_MIN_WINDOW_FOR_OUTLIER') ??
      DEFAULT_MIN_WINDOW_FOR_OUTLIER;
  }

  async feed(
    windowDays: number = DEFAULT_WINDOW_DAYS,
    limit: number = DEFAULT_LIMIT,
  ): Promise<PaymentsFeedReport> {
    const source = await this.sourceState();
    const thresholds = {
      repeatedPair: this.repeatedPair,
      fundingMany: this.fundingMany,
      newAccountDays: this.newAccountDays,
      minWindowSizeForOutlier: this.minWindowForOutlier,
    };

    if (!source.ok) {
      return {
        windowDays,
        windowSize: 0,
        amountP95: null,
        thresholds,
        payments: null,
        unavailableReason:
          'O ETL do PlayerPoints nunca completou, entao nao ha copia dos ' +
          'pagamentos para exibir. Uma lista vazia aqui se leria como "nenhum ' +
          'pagamento aconteceu", que num instrumento de moderacao e a pior ' +
          'leitura errada possivel.',
        disclaimer: FEED_DISCLAIMER,
        directionCaveat: PAYMENT_DIRECTION_CAVEAT,
        sources: [source],
      };
    }

    const since = new Date(Date.now() - windowDays * MS_PER_DAY);
    const window = (await this.payments.allPaymentsSince(since)).filter(
      (payment) => payment.transactionType === CANONICAL_TYPE,
    );

    // Percentile over the WHOLE window, not over the page. A mark computed on
    // the fifty rows a caller happened to ask for would change meaning with the
    // page size, which is not a property a moderation signal may have.
    const amounts = window.map((payment) => payment.amount);
    const amountP95 =
      window.length >= this.minWindowForOutlier
        ? percentile(amounts, 0.95)
        : null;

    const pairCounts = new Map<string, number>();
    const receiversBySender = new Map<string, Set<string>>();
    for (const payment of window) {
      const pair = JSON.stringify([payment.source, payment.receiver]);
      pairCounts.set(pair, (pairCounts.get(pair) ?? 0) + 1);
      const receivers = receiversBySender.get(payment.source) ?? new Set();
      receivers.add(payment.receiver);
      receiversBySender.set(payment.source, receivers);
    }

    const page = window.slice(0, limit);
    const registeredAt = await this.registrationDates(
      page.map((payment) => payment.receiver),
    );

    return {
      windowDays,
      windowSize: window.length,
      amountP95,
      thresholds,
      payments: page.map((payment) =>
        this.toFeedPayment(payment, {
          amountP95,
          pairCounts,
          receiversBySender,
          registeredAt,
        }),
      ),
      disclaimer: FEED_DISCLAIMER,
      // Travels with every response, like every other caveat in this module.
      // This is the one a mark can be wrong *about* rather than merely
      // imprecise, and it was the only one living solely in a source comment.
      directionCaveat: PAYMENT_DIRECTION_CAVEAT,
      sources: [source],
    };
  }

  private toFeedPayment(
    payment: StoredPayment,
    context: {
      amountP95: number | null;
      pairCounts: Map<string, number>;
      receiversBySender: Map<string, Set<string>>;
      registeredAt: Map<string, Date>;
    },
  ): FeedPayment {
    const flags: FlagMark[] = [];

    // Strictly above, not at, and the difference is the whole mark's usefulness.
    // With `>=`, a window whose amounts are all equal has every row at its own
    // p95 and the feed flags **everything** — which is how a signal becomes
    // noise and then becomes ignored. With `>`, a flat window produces no marks
    // at all, which is the honest answer for a month where nothing stood out.
    //
    // Worth saying plainly: this is a **tail marker**, not a statistical test.
    // In a window with real dispersion it will mark roughly the top 5%, by
    // construction. That is intended for a feed whose job is to surface
    // candidates for a human, and it is exactly why the threshold ships in the
    // payload next to the observation.
    const outlier =
      context.amountP95 !== null && payment.amount > context.amountP95;
    if (outlier && context.amountP95 !== null) {
      flags.push({
        flag: 'amount_outlier',
        observed: payment.amount,
        threshold: context.amountP95,
      });
    }

    const pairCount =
      context.pairCounts.get(
        JSON.stringify([payment.source, payment.receiver]),
      ) ?? 0;
    if (pairCount >= this.repeatedPair) {
      flags.push({
        flag: 'repeated_pair',
        observed: pairCount,
        threshold: this.repeatedPair,
      });
    }

    const fanOut = context.receiversBySender.get(payment.source)?.size ?? 0;
    if (fanOut >= this.fundingMany) {
      flags.push({
        flag: 'funding_many',
        observed: fanOut,
        threshold: this.fundingMany,
      });
    }

    const registered = context.registeredAt.get(payment.receiver);
    if (registered !== undefined && outlier) {
      const ageDays =
        (payment.occurredAt.getTime() - registered.getTime()) / MS_PER_DAY;
      // Negative age means the payment predates the registration this system
      // knows about — two sources disagreeing, not a new account. Left unmarked
      // rather than flagged on a comparison that does not hold.
      if (ageDays >= 0 && ageDays <= this.newAccountDays) {
        flags.push({
          flag: 'new_account_high_value',
          observed: Math.floor(ageDays),
          threshold: this.newAccountDays,
        });
      }
    }

    return {
      occurredAt: payment.occurredAt.toISOString(),
      from: payment.source,
      to: payment.receiver,
      amount: payment.amount,
      flags,
    };
  }

  /**
   * Registration dates for the receivers on this page.
   *
   * Only for the page: the `new_account_high_value` mark is per row, so nothing
   * needs the dates of rows nobody is looking at. Missing entries simply produce
   * no mark — an unknown registration is not evidence of a new account, and
   * treating it as one would flag every player the dimension has not synced yet.
   */
  private async registrationDates(
    uuids: readonly string[],
  ): Promise<Map<string, Date>> {
    const unique = [...new Set(uuids)];
    if (unique.length === 0) {
      return new Map();
    }

    try {
      const result = await this.db.execute<{
        uuid: string;
        /**
         * Whatever `pg` hands back for a timestamp. Narrowed by `toDate` rather
         * than trusted as typed — the economy service shipped
         * `.getTime is not a function` on exactly that assumption.
         */
        registered_at: unknown;
      }>(
        sql`
          SELECT ${playerDimension.uuid}::text AS uuid,
                 ${playerDimension.registeredAt} AS registered_at
            FROM ${playerDimension}
           WHERE ${playerDimension.uuid}::text = ANY(${unique})
        `,
      );

      const dates = new Map<string, Date>();
      for (const row of result.rows) {
        const registered = toDate(row.registered_at);
        if (registered !== null) {
          dates.set(row.uuid, registered);
        }
      }
      return dates;
    } catch (error) {
      // The mark is a nicety; the feed is the product. A failure here costs one
      // flag, and swallowing it keeps a moderation tool usable during a partial
      // outage instead of blanking it.
      this.logger.warn(
        `Datas de registro indisponiveis para a marca de conta nova: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return new Map();
    }
  }

  private async sourceState(): Promise<EconomySourceState> {
    try {
      const last = await this.payments.lastSuccessfulSync();
      return last === null
        ? {
            name: 'player_payments',
            ok: false,
            asOf: null,
            failure: 'never_synced',
          }
        : {
            name: 'player_payments',
            ok: true,
            asOf: last.ranAt.toISOString(),
          };
    } catch (error) {
      this.logger.warn(
        `Procedencia dos pagamentos ilegivel: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return {
        name: 'player_payments',
        ok: false,
        asOf: null,
        failure: 'query_failed',
      };
    }
  }
}
