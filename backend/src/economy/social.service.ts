import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../db/database.module';
import { playerDimension, playerPayments } from '../db/schema';
import { toDate } from './economy-math';
import type { EconomySourceState, Share } from './economy.types';
import { PaymentsStore } from './payments.store';
import { PlayerDimensionStore } from './player-dimension.store';
import {
  CONTACT_GROUPS,
  SOCIAL_D7_SEMANTICS,
  CANONICAL_PAYMENT_TYPE,
  TUTORIAL_SEPARATION_CAVEAT,
  type ContactGroup,
  type ContactGroupResult,
  type SocialContactReport,
} from './social.types';

const TZ = 'America/Sao_Paulo';
const MS_PER_DAY = 86_400_000;
const D7_DAYS = 7;

/** Defaults, documented in `.env.example` as uncalibrated. */
const DEFAULT_CONTACT_MINUTES = 60;
const DEFAULT_TUTORIAL_AMOUNT = 100;

/** One player and how their first minutes went. */
type ContactRow = {
  /**
   * Whatever `pg` hands back for a timestamp. Narrowed by `toDate` rather than
   * trusted as typed — the economy service shipped `.getTime is not a function`
   * on exactly this assumption, and the e2e is what caught it.
   */
  registered_at: unknown;
  last_seen_at: unknown;
  /** Payments in the window whose amount matches the tutorial signature. */
  tutorial_like: number;
  /** Payments in the window whose amount does not. */
  spontaneous: number;
};

/**
 * E3 — social contact in the first minutes (story S9.1, spec §6.4).
 *
 * ## Why this metric exists
 *
 * *"Pagamento entre jogadores é registro de contato social real — um dos
 * preditores mais fortes de retenção em jogo multiplayer."* The question is
 * whether a newcomer who talks to somebody in their first hour sticks around
 * longer than one who does not.
 *
 * ## Two things this number cannot hide, and does not try to
 *
 * 1. **The sample is small, and known to be.** R4 of ADR-007: 666 payments in
 *    6,7 months, ~3 a day, against ~579 active players. *"E3 nasce com amostra
 *    pequena; medir sim, esperar conclusão rápida não."* Every group publishes
 *    its `players` count next to its D7 for exactly this reason.
 * 2. **The D7 is a survival interval**, not a return on day seven — see
 *    `SOCIAL_D7_SEMANTICS`, which travels in the payload.
 *
 * ## Immature players are excluded from D7 and counted
 *
 * A player who registered three days ago cannot have a seven-day outcome.
 * Leaving them in the denominator would drag every group down by however many
 * of them it happens to contain — an effect invisible without the count, and
 * one that would look like a real decline in a recent cohort.
 */
@Injectable()
export class SocialService {
  private readonly logger = new Logger(SocialService.name);

  private readonly contactMinutes: number;
  private readonly tutorialAmount: number;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly payments: PaymentsStore,
    private readonly dimension: PlayerDimensionStore,
    config: ConfigService,
  ) {
    this.contactMinutes =
      config.get<number>('ECONOMY_SOCIAL_CONTACT_MINUTES') ??
      DEFAULT_CONTACT_MINUTES;
    this.tutorialAmount =
      config.get<number>('ECONOMY_TUTORIAL_PAYMENT_AMOUNT') ??
      DEFAULT_TUTORIAL_AMOUNT;
  }

  async contact(
    fromMonth: string,
    toMonth: string,
  ): Promise<SocialContactReport> {
    const sources = await this.sourceStates();
    const envelope = {
      from: fromMonth,
      to: toMonth,
      contactWindowMinutes: this.contactMinutes,
      tutorialPaymentAmount: this.tutorialAmount,
      d7Semantics: SOCIAL_D7_SEMANTICS,
      tutorialSeparationCaveat: TUTORIAL_SEPARATION_CAVEAT,
      sources,
    };

    const broken = sources.filter((source) => !source.ok);
    if (broken.length > 0) {
      return {
        ...envelope,
        groups: null,
        unavailableReason:
          'Sem base para medir contato social: ' +
          broken
            .map(
              (source) => `\`${source.name}\` (${source.failure ?? 'falha'})`,
            )
            .join(', ') +
          '. Publicar grupos vazios aqui se leria como "ninguem teve contato", ' +
          'que e a confusao que este epico existe para remover.',
      };
    }

    const rows = await this.contactRows(fromMonth, toMonth);
    const now = Date.now();

    const buckets = new Map<
      ContactGroup,
      { players: number; survived: number; immature: number }
    >();
    for (const group of CONTACT_GROUPS) {
      buckets.set(group, { players: 0, survived: 0, immature: 0 });
    }

    for (const row of rows) {
      const group: ContactGroup =
        row.spontaneous > 0
          ? 'spontaneous'
          : row.tutorial_like > 0
            ? 'tutorial_only'
            : 'none';

      const bucket = buckets.get(group);
      if (bucket === undefined) {
        continue;
      }

      const registered = toDate(row.registered_at);
      const lastSeen = toDate(row.last_seen_at);
      if (registered === null || lastSeen === null) {
        // Unreadable dates make the D7 unanswerable for this player, and
        // counting them in `players` while excluding them from the base would
        // publish a group whose two numbers describe different populations.
        continue;
      }
      bucket.players += 1;

      const registeredAt = registered.getTime();
      if (now - registeredAt < D7_DAYS * MS_PER_DAY) {
        bucket.immature += 1;
        continue;
      }
      if (lastSeen.getTime() - registeredAt >= D7_DAYS * MS_PER_DAY) {
        bucket.survived += 1;
      }
    }

    const groups: ContactGroupResult[] = CONTACT_GROUPS.map((group) => {
      const bucket = buckets.get(group) ?? {
        players: 0,
        survived: 0,
        immature: 0,
      };
      const base = bucket.players - bucket.immature;
      return {
        group,
        players: bucket.players,
        immature: bucket.immature,
        d7: this.share(bucket.survived, base, bucket.players),
      };
    });

    return { ...envelope, groups };
  }

  /**
   * One row per player registered in the cohort window, with their first-minutes
   * payment counts split by the tutorial amount signature.
   *
   * The join is on **either side** of the payment: the spec asks for newcomers
   * who *send or receive*, and a newcomer being paid by a veteran is social
   * contact just as much as the reverse — arguably more, since it is the
   * veteran choosing to engage.
   *
   * ## One ledger row per payment, and the `OR` still catches both directions
   *
   * `player_payments` holds **two** rows per transfer, and they swap `source`
   * and `receiver` between them (see {@link CANONICAL_PAYMENT_TYPE}). Without
   * the type filter this join matched a player on both of them — every payment
   * counted twice, whichever end of it the player was on.
   *
   * That doubling was inert here, and saying so is the honest version: the two
   * counts below are only ever read as `> 0` when picking a contact group, and
   * doubling preserves zero. No published number was wrong. What it was is a
   * loaded gun — the day either count is published as a count, it is 2×.
   *
   * The `OR` still reaches both ends from one row, and — usefully — it does so
   * **without depending on the direction**: it is symmetric in the two columns,
   * so this metric is correct whichever of the two readings of `source` and
   * `receiver` turns out to be right.
   *
   * ## What the filter does cost
   *
   * A payment whose `PAY_RECEIVER` half is missing now disappears from this
   * metric entirely, and the player is filed under `none` with no warning. The
   * unfiltered version got that case right, by accident — it counted the
   * surviving half.
   *
   * Not hypothetical by decree: the ETL counts `senderRows` against
   * `receiverRows` precisely because a broken pairing is the observation that
   * would falsify the assumption this rests on. Production is 666/666 today, so
   * the cost is zero today — but it is a real trade, and the honest version is
   * that it converts a logged condition into a silent one rather than that it is
   * free.
   */
  private async contactRows(
    fromMonth: string,
    toMonth: string,
  ): Promise<ContactRow[]> {
    const result = await this.db.execute<ContactRow>(sql`
      SELECT
        ${playerDimension.registeredAt} AS registered_at,
        ${playerDimension.lastSeenAt} AS last_seen_at,
        count(*) FILTER (
          WHERE ${playerPayments.amount} IS NOT NULL
            AND abs(${playerPayments.amount}) = ${this.tutorialAmount}
        )::int AS tutorial_like,
        count(*) FILTER (
          WHERE ${playerPayments.amount} IS NOT NULL
            AND abs(${playerPayments.amount}) <> ${this.tutorialAmount}
        )::int AS spontaneous
      FROM ${playerDimension}
      LEFT JOIN ${playerPayments}
        ON ${playerPayments.transactionType} = ${CANONICAL_PAYMENT_TYPE}
        AND (
             ${playerPayments.receiver} = ${playerDimension.uuid}::text
          OR ${playerPayments.source} = ${playerDimension.uuid}::text
        )
        AND ${playerPayments.occurredAt} >= ${playerDimension.registeredAt}
        AND ${playerPayments.occurredAt} <
            ${playerDimension.registeredAt}
              + (${this.contactMinutes} * interval '1 minute')
      WHERE ${playerDimension.registeredAt}
              >= ((${fromMonth} || '-01')::date::timestamp AT TIME ZONE ${TZ})
        AND ${playerDimension.registeredAt}
              < (((${toMonth} || '-01')::date + interval '1 month')::timestamp
                 AT TIME ZONE ${TZ})
      GROUP BY ${playerDimension.uuid}, ${playerDimension.registeredAt},
               ${playerDimension.lastSeenAt}
    `);

    return result.rows;
  }

  /** Both stores have to have run for this metric to mean anything. */
  private async sourceStates(): Promise<EconomySourceState[]> {
    const [dimension, payments] = await Promise.all([
      this.syncState('player_dimension', () =>
        this.dimension.lastSuccessfulSync(),
      ),
      this.syncState('player_payments', () =>
        this.payments.lastSuccessfulSync(),
      ),
    ]);
    return [dimension, payments];
  }

  private async syncState(
    name: EconomySourceState['name'],
    read: () => Promise<{ ranAt: Date } | null>,
  ): Promise<EconomySourceState> {
    try {
      const last = await read();
      return last === null
        ? { name, ok: false, asOf: null, failure: 'never_synced' }
        : { name, ok: true, asOf: last.ranAt.toISOString() };
    } catch (error) {
      this.logger.warn(
        `Procedencia de ${name} ilegivel: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { name, ok: false, asOf: null, failure: 'query_failed' };
    }
  }

  private share(part: number, whole: number, players: number): Share {
    if (whole === 0) {
      return {
        percent: null,
        n: 0,
        unavailableReason:
          players === 0
            ? 'nenhum jogador caiu neste grupo no periodo — nao ha base para ' +
              'calcular D7, o que nao e o mesmo que D7 de 0%'
            : 'nenhum jogador deste grupo teve 7 dias de oportunidade ainda — ' +
              'publicar 0% aqui seria o calendario, nao a retencao',
      };
    }
    return { percent: Math.round((part / whole) * 1000) / 10, n: whole };
  }
}
