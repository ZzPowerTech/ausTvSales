import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, sql, type SQL } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../db/database.module';
import { playerDimension, sales, tutorialPlayerPosition } from '../db/schema';
import { platformOf, type Platform } from '../instrumentation/platform';
import {
  formatCents,
  percentile,
  shareOf,
  toCents,
  toDate,
} from './economy-math';
import { PlayerDimensionStore } from './player-dimension.store';
import { TutorialStore } from '../tutorial/tutorial.store';
import {
  FUNNEL_POSITION_NO_TUTORIAL_SYNC,
  FUNNEL_POSITION_SWITCH_OFF,
  FUNNEL_POSITIONS,
  type CohortFirstSpend,
  type CohortRevenue,
  type EconomyRevenueReport,
  type EconomySourceState,
  type FirstSpendReport,
  type FunnelPosition,
  type FunnelPositionSpend,
  type FurthestStepSpend,
  type PlatformRevenue,
  type Share,
} from './economy.types';

const TZ = 'America/Sao_Paulo';
const MS_PER_DAY = 86_400_000;

/** One buyer's totals in the window, as the SQL returns them. */
type BuyerRow = {
  player_uuid: string;
  revenue_cents: string;
  sales: number;
  /** `YYYY-MM` of registration, or null when the player is not in the dimension. */
  cohort: string | null;
};

/** One dimension player and their first purchase, if any. */
type FirstSpendRow = {
  uuid: string;
  cohort: string;
  /**
   * Whatever `pg` hands back for a timestamp — a `Date` for a plain column, a
   * **string** for an aggregate. Narrowed by `toDate`, never trusted as typed.
   */
  registered_at: unknown;
  first_purchase_at: unknown;
};

type ExcludedRow = {
  sales: number;
  revenue_cents: string;
};

/** One player, their tutorial position and their spend. */
type PositionRow = {
  entered: boolean;
  completed_tutorial: boolean;
  furthest_quest_id: string | null;
  furthest_index: number | null;
  sales: number;
  revenue_cents: string;
};

/**
 * The economy layer — E1 and E2 (story S9.1, spec §6.4).
 *
 * ## Everything here reads `sales`, which is our own table
 *
 * R2 of ADR-007 requires administrative grants out of every revenue metric,
 * because the PlayerPoints log holds a 9.999.999 row. This service never opens
 * that log: revenue comes from `sales`, where each row is a purchase carrying
 * the price the Genesis `%price%` placeholder resolved. The exclusion is
 * **structural**, not a filter someone has to remember to write.
 *
 * No test asserts it, and none can: there is nothing to assert against, because
 * nothing in this module can reach the PlayerPoints log. A structural guarantee
 * is stronger than a tested one — but an earlier version of this comment claimed
 * a test existed, which is the kind of claim this repository audits later and
 * finds wrong.
 *
 * ## Platform comes from the uuid; cohort comes from the dimension
 *
 * ADR-003 derives platform from the player uuid alone, and `sales.player_uuid`
 * is right here — so **revenue by platform needs no ETL at all** and keeps
 * answering while the dimension is empty, unconfigured or stale. That matters:
 * it is the number the spec says no Bedrock decision should be taken without.
 *
 * The cohort axis is the part that genuinely needs `player_dimension`, because a
 * registration date lives on the other side of an HTTP API and ADR-008 forbids
 * joining two live sources in memory. When the dimension has never synced, the
 * cohort breakdown is `null` **with the reason** — never an empty array, which
 * would read as "no cohort produced revenue".
 *
 * ## Historical imports are excluded from every figure, and republished
 *
 * `historical_import = true` rows carry a migrated price and no real per-event
 * timestamp, so they cannot be attributed to a window nor compared against a
 * registration date. Excluding them silently would make these numbers disagree
 * with the analytics endpoints for a reason nobody could see, so the excluded
 * aggregate travels in the payload.
 */
@Injectable()
export class EconomyService {
  private readonly logger = new Logger(EconomyService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly dimension: PlayerDimensionStore,
    private readonly tutorial: TutorialStore,
  ) {}

  /** E1 — revenue by platform and by registration cohort. */
  async revenue(
    from: string | null,
    to: string | null,
  ): Promise<EconomyRevenueReport> {
    const window = this.windowPredicate(from, to);
    const dimensionState = await this.dimensionState();

    const [buyers, excluded] = await Promise.all([
      this.buyerRows(window),
      this.excludedHistorical(),
    ]);

    const byPlatformCents = new Map<
      Platform,
      { cents: bigint; sales: number; buyers: number }
    >();
    const byCohortCents = new Map<
      string,
      {
        cohort: string | null;
        platform: Platform;
        cents: bigint;
        sales: number;
        buyers: number;
      }
    >();

    let totalCents = 0n;
    let totalSales = 0;
    let salesWithCohort = 0;
    let cohortCents = 0n;

    for (const row of buyers) {
      const platform = platformOf(row.player_uuid);
      const cents = toCents(row.revenue_cents);

      totalCents += cents;
      totalSales += row.sales;

      const platformBucket = byPlatformCents.get(platform) ?? {
        cents: 0n,
        sales: 0,
        buyers: 0,
      };
      platformBucket.cents += cents;
      platformBucket.sales += row.sales;
      platformBucket.buyers += 1;
      byPlatformCents.set(platform, platformBucket);

      const key = `${row.cohort ?? '?'} ${platform}`;
      const cohortBucket = byCohortCents.get(key) ?? {
        cohort: row.cohort,
        platform,
        cents: 0n,
        sales: 0,
        buyers: 0,
      };
      cohortBucket.cents += cents;
      cohortBucket.sales += row.sales;
      cohortBucket.buyers += 1;
      byCohortCents.set(key, cohortBucket);

      if (row.cohort !== null) {
        salesWithCohort += row.sales;
        cohortCents += cents;
      }
    }

    const byPlatform: PlatformRevenue[] = [...byPlatformCents.entries()]
      .map(([platform, bucket]) => ({
        platform,
        revenue: formatCents(bucket.cents),
        sales: bucket.sales,
        buyers: bucket.buyers,
        share: this.share(bucket.cents, totalCents, bucket.sales),
      }))
      .sort((a, b) => a.platform.localeCompare(b.platform));

    const byCohort: CohortRevenue[] | null = dimensionState.ok
      ? [...byCohortCents.values()]
          .map((bucket) => ({
            cohort: bucket.cohort,
            platform: bucket.platform,
            revenue: formatCents(bucket.cents),
            sales: bucket.sales,
            buyers: bucket.buyers,
          }))
          .sort(
            (a, b) =>
              (a.cohort ?? '9999-99').localeCompare(b.cohort ?? '9999-99') ||
              a.platform.localeCompare(b.platform),
          )
      : null;

    return {
      from,
      to,
      totals: {
        revenue: formatCents(totalCents),
        sales: totalSales,
        buyers: buyers.length,
      },
      byPlatform,
      byCohort,
      ...(byCohort === null
        ? { cohortUnavailableReason: dimensionReason(dimensionState) }
        : {}),
      cohortCoverage: dimensionState.ok
        ? {
            salesWithCohort,
            salesTotal: totalSales,
            revenueWithCohort: formatCents(cohortCents),
          }
        : null,
      excludedHistorical: {
        sales: excluded.sales,
        revenue: formatCents(toCents(excluded.revenue_cents)),
      },
      // `sales` is our own table: a failure there is a 500, not a degraded
      // report, so it is published as `ok` by construction. It appears in the
      // list anyway, because a consumer reading `sources` should see every input
      // rather than only the ones that can fail.
      sources: [{ name: 'sales', ok: true, asOf: null }, dimensionState],
    };
  }

  /** E2 — time to first spend, by cohort and platform. */
  async firstSpend(
    fromMonth: string,
    toMonth: string,
  ): Promise<FirstSpendReport> {
    const [dimensionState, position] = await Promise.all([
      this.dimensionState(),
      this.funnelPosition(),
    ]);

    if (!dimensionState.ok) {
      return {
        from: fromMonth,
        to: toMonth,
        byCohort: null,
        unavailableReason: dimensionReason(dimensionState),
        ...position,
        sources: [{ name: 'sales', ok: true, asOf: null }, dimensionState],
      };
    }

    const rows = await this.firstSpendRows(fromMonth, toMonth);

    const groups = new Map<
      string,
      {
        cohort: string;
        platform: Platform;
        size: number;
        days: number[];
        beforeRegistration: number;
      }
    >();

    for (const row of rows) {
      const platform = platformOf(row.uuid);
      const key = `${row.cohort} ${platform}`;
      const group = groups.get(key) ?? {
        cohort: row.cohort,
        platform,
        size: 0,
        days: [],
        beforeRegistration: 0,
      };

      const registeredAt = toDate(row.registered_at);
      if (registeredAt === null) {
        // A player whose registration date cannot be read belongs to no
        // interval. Dropped from the cohort entirely rather than counted with a
        // missing numerator, which would deflate the "ever spent" share.
        continue;
      }
      group.size += 1;

      const firstPurchaseAt = toDate(row.first_purchase_at);
      if (firstPurchaseAt !== null) {
        const delta = firstPurchaseAt.getTime() - registeredAt.getTime();
        if (delta < 0) {
          // The two sources disagree about when this player started — usually a
          // buyer whose purchase predates Plan's own history. Counted and left
          // out of the percentiles rather than clamped to zero, which would bias
          // the median downwards while looking like data.
          group.beforeRegistration += 1;
        } else {
          group.days.push(Math.floor(delta / MS_PER_DAY));
        }
      }

      groups.set(key, group);
    }

    const byCohort: CohortFirstSpend[] = [...groups.values()]
      .map((group) => {
        // A player whose first purchase predates their registration date DID
        // buy. They are excluded from the percentile sample because the interval
        // is unusable — and counting them out of `spenders` too would publish a
        // share whose numerator silently drops real buyers.
        //
        // Not hypothetical here: `registerDate` is when Plan first saw the
        // player, Plan's history starts 2024-06-02, and `sales` reaches further
        // back. An early cohort could report `everSpent: 5%` while
        // `/economy/revenue` shows that same cohort producing real money — two
        // endpoints of one module contradicting each other, with the wrong one
        // looking like a finding about onboarding.
        const spenders = group.days.length + group.beforeRegistration;
        return {
          cohort: group.cohort,
          platform: group.platform,
          cohortSize: group.size,
          spenders,
          everSpent: this.countShare(spenders, group.size),
          // The percentiles keep the clean sample: an unusable interval cannot
          // be averaged in as "bought on day 0" without biasing the median.
          medianDaysToFirstSpend: percentile(group.days, 0.5),
          p90DaysToFirstSpend: percentile(group.days, 0.9),
          beforeRegistration: group.beforeRegistration,
        };
      })
      .sort(
        (a, b) =>
          a.cohort.localeCompare(b.cohort) ||
          a.platform.localeCompare(b.platform),
      );

    return {
      from: fromMonth,
      to: toMonth,
      byCohort,
      ...position,
      sources: [{ name: 'sales', ok: true, asOf: null }, dimensionState],
    };
  }

  /**
   * The second half of E2 — spend by tutorial position (story S9.3).
   *
   * ## Why this reads the whole picture and not just the buyers
   *
   * The question is *"quem conclui o tutorial gasta mais?"*, and the denominator
   * has to be **everyone in that position**, not everyone in that position who
   * bought. A join the other way round makes every group spend 100% by
   * construction — the same defect the cohort half of this endpoint was written
   * to avoid.
   *
   * So the query starts from `tutorial_player_position` and LEFT JOINs `sales`.
   * Players with no tutorial progress at all are absent from that table, and are
   * counted separately from `player_dimension` so the `nao_entrou` group has a
   * real base instead of being the silence between the other two.
   *
   * ## `null` and not an empty list
   *
   * When the position table has never been filled, every group would come back
   * with zeros — which reads as "nobody in any position ever spent". The whole
   * block goes `null` with the reason instead.
   */
  private async funnelPosition(): Promise<
    Pick<
      FirstSpendReport,
      | 'byFunnelPosition'
      | 'funnelPositionUnavailableReason'
      | 'byFurthestStep'
      | 'stepOrder'
    >
  > {
    let lastSync;
    try {
      lastSync = await this.tutorial.lastSuccessfulSync();
    } catch (error) {
      this.logger.warn(
        `Procedencia do tutorial ilegivel: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      lastSync = null;
    }

    const stepOrder =
      lastSync?.stepOrder != null && lastSync.stepOrder !== ''
        ? lastSync.stepOrder.split(',')
        : null;

    // Two different absences, and telling them apart is the whole point: no
    // successful tutorial run at all sends you to `TUTORIAL_SYNC_ENABLED` and
    // the directories, while a run with `positionsWritten` null sends you to
    // `TUTORIAL_POSITION_ENABLED`. One message for both named the second — and
    // against a real instance whose parent ETL was unconfigured, that pointed
    // at the one variable already set correctly.
    if (lastSync === null) {
      return {
        byFunnelPosition: null,
        funnelPositionUnavailableReason: FUNNEL_POSITION_NO_TUTORIAL_SYNC,
        byFurthestStep: null,
        stepOrder,
      };
    }

    // The switch was off on the last good run, so the table is either empty or
    // stale from an older configuration. Either way it is not a measurement.
    if (lastSync.positionsWritten === null) {
      return {
        byFunnelPosition: null,
        funnelPositionUnavailableReason: FUNNEL_POSITION_SWITCH_OFF,
        byFurthestStep: null,
        stepOrder,
      };
    }

    const rows = await this.positionRows();

    const byPosition = new Map<
      FunnelPosition,
      { players: number; spenders: number; cents: bigint; steps: number[] }
    >();
    for (const group of FUNNEL_POSITIONS) {
      byPosition.set(group, {
        players: 0,
        spenders: 0,
        cents: 0n,
        steps: [],
      });
    }

    const bySteps = new Map<
      string,
      { index: number; players: number; spenders: number; cents: bigint }
    >();

    for (const row of rows) {
      const group: FunnelPosition =
        row.entered === false
          ? 'nao_entrou'
          : row.completed_tutorial
            ? 'concluiu'
            : 'entrou_nao_concluiu';

      const bucket = byPosition.get(group);
      if (bucket === undefined) {
        continue;
      }
      const cents = toCents(row.revenue_cents);
      bucket.players += 1;
      bucket.cents += cents;
      if (row.sales > 0) {
        bucket.spenders += 1;
      }
      if (row.furthest_index !== null) {
        bucket.steps.push(row.furthest_index);
      }

      if (row.furthest_quest_id !== null && row.furthest_index !== null) {
        const step = bySteps.get(row.furthest_quest_id) ?? {
          index: row.furthest_index,
          players: 0,
          spenders: 0,
          cents: 0n,
        };
        step.players += 1;
        step.cents += cents;
        if (row.sales > 0) {
          step.spenders += 1;
        }
        bySteps.set(row.furthest_quest_id, step);
      }
    }

    const byFunnelPosition: FunnelPositionSpend[] = FUNNEL_POSITIONS.map(
      (group) => {
        const bucket = byPosition.get(group) ?? {
          players: 0,
          spenders: 0,
          cents: 0n,
          steps: [],
        };
        return {
          position: group,
          players: bucket.players,
          spenders: bucket.spenders,
          everSpent: this.countShare(bucket.spenders, bucket.players),
          revenue: formatCents(bucket.cents),
          medianFurthestStep: percentile(bucket.steps, 0.5),
        };
      },
    );

    const byFurthestStep: FurthestStepSpend[] = [...bySteps.entries()]
      .map(([step, bucket]) => ({
        step,
        index: bucket.index,
        players: bucket.players,
        spenders: bucket.spenders,
        everSpent: this.countShare(bucket.spenders, bucket.players),
        revenue: formatCents(bucket.cents),
      }))
      .sort((a, b) => a.index - b.index);

    return { byFunnelPosition, byFurthestStep, stepOrder };
  }

  /**
   * Every known player, their tutorial position and what they spent.
   *
   * A `FULL JOIN` in spirit: the population is `player_dimension` (everyone the
   * Plan knows) unioned with `tutorial_player_position` (everyone the Quests
   * files know). Neither alone is the right denominator — the first misses a
   * player the Plan never registered, and the second misses everyone who never
   * touched the tutorial, which is precisely the `nao_entrou` group.
   */
  private async positionRows(): Promise<PositionRow[]> {
    const result = await this.db.execute<PositionRow>(sql`
      WITH population AS (
        SELECT ${playerDimension.uuid}::text AS uuid FROM ${playerDimension}
        UNION
        SELECT ${tutorialPlayerPosition.playerUuid}::text AS uuid
          FROM ${tutorialPlayerPosition}
      )
      SELECT
        (${tutorialPlayerPosition.playerUuid} IS NOT NULL) AS entered,
        coalesce(${tutorialPlayerPosition.completedTutorial}, false)
          AS completed_tutorial,
        ${tutorialPlayerPosition.furthestQuestId} AS furthest_quest_id,
        ${tutorialPlayerPosition.furthestIndex} AS furthest_index,
        count(${sales.id})::int AS sales,
        coalesce((sum(${sales.totalPrice}) * 100)::bigint, 0)::text
          AS revenue_cents
      FROM population
      LEFT JOIN ${tutorialPlayerPosition}
        ON ${tutorialPlayerPosition.playerUuid}::text = population.uuid
      LEFT JOIN ${sales}
        ON ${sales.playerUuid}::text = population.uuid
        AND ${sales.historicalImport} = false
      GROUP BY population.uuid,
               ${tutorialPlayerPosition.playerUuid},
               ${tutorialPlayerPosition.completedTutorial},
               ${tutorialPlayerPosition.furthestQuestId},
               ${tutorialPlayerPosition.furthestIndex}
    `);

    return result.rows;
  }

  /**
   * One row per buyer in the window, with their registration cohort.
   *
   * The aggregation is per **player**, not per platform, because the platform
   * rule (ADR-003) is TypeScript and pushing it into SQL would be a second
   * spelling of a rule that already exists. A few hundred rows come back; the
   * grouping into platforms and cohorts happens in memory, in cents.
   */
  private async buyerRows(window: SQL | undefined): Promise<BuyerRow[]> {
    const result = await this.db.execute<BuyerRow>(sql`
      SELECT
        ${sales.playerUuid}::text AS player_uuid,
        -- Integer cents, as text. numeric(12,2) times 100 is exact, and the pg
        -- driver hands a bigint back as a string so nothing is lost on the way.
        (sum(${sales.totalPrice}) * 100)::bigint::text AS revenue_cents,
        count(*)::int AS sales,
        to_char(
          date_trunc('month', ${playerDimension.registeredAt} AT TIME ZONE ${TZ}),
          'YYYY-MM'
        ) AS cohort
      FROM ${sales}
      LEFT JOIN ${playerDimension}
        ON ${playerDimension.uuid} = ${sales.playerUuid}
      WHERE ${sales.historicalImport} = false
        ${window ? sql`AND ${window}` : sql``}
      GROUP BY ${sales.playerUuid}, ${playerDimension.registeredAt}
    `);

    return result.rows;
  }

  /** What the historical-import exclusion left out, so it is never invisible. */
  private async excludedHistorical(): Promise<ExcludedRow> {
    const result = await this.db.execute<ExcludedRow>(sql`
      SELECT
        count(*)::int AS sales,
        coalesce((sum(${sales.totalPrice}) * 100)::bigint, 0)::text AS revenue_cents
      FROM ${sales}
      WHERE ${sales.historicalImport} = true
    `);

    return result.rows[0] ?? { sales: 0, revenue_cents: '0' };
  }

  /**
   * Every player in the cohort window, with their first non-historical purchase.
   *
   * A `LEFT JOIN`, and that is the whole point: the denominator of "share of the
   * cohort that ever spent" has to be the cohort, not the buyers. Joining the
   * other way round would make the answer 100% by construction.
   */
  private async firstSpendRows(
    fromMonth: string,
    toMonth: string,
  ): Promise<FirstSpendRow[]> {
    const result = await this.db.execute<FirstSpendRow>(sql`
      SELECT
        ${playerDimension.uuid}::text AS uuid,
        to_char(
          date_trunc('month', ${playerDimension.registeredAt} AT TIME ZONE ${TZ}),
          'YYYY-MM'
        ) AS cohort,
        ${playerDimension.registeredAt} AS registered_at,
        min(${sales.purchasedAt}) AS first_purchase_at
      FROM ${playerDimension}
      LEFT JOIN ${sales}
        ON ${sales.playerUuid} = ${playerDimension.uuid}
        AND ${sales.historicalImport} = false
      -- Compared against the column itself rather than against to_char of it,
      -- so the (registered_at, platform) index is usable and the month
      -- boundaries are evaluated once instead of per row.
      WHERE ${playerDimension.registeredAt}
              >= ((${fromMonth} || '-01')::date::timestamp AT TIME ZONE ${TZ})
        AND ${playerDimension.registeredAt}
              < (((${toMonth} || '-01')::date + interval '1 month')::timestamp AT TIME ZONE ${TZ})
      GROUP BY ${playerDimension.uuid}, ${playerDimension.registeredAt}
    `);

    return result.rows;
  }

  /** Window predicate on `purchased_at`, evaluated in São Paulo local time. */
  private windowPredicate(
    from: string | null,
    to: string | null,
  ): SQL | undefined {
    const parts: SQL[] = [];
    if (from) {
      parts.push(
        sql`${sales.purchasedAt} >= (${from}::date::timestamp AT TIME ZONE ${TZ})`,
      );
    }
    if (to) {
      // Exclusive upper bound on the day after, so the whole of `to` is included
      // without depending on the time part — the same shape the analytics module
      // uses.
      parts.push(
        sql`${sales.purchasedAt} < ((${to}::date + 1)::timestamp AT TIME ZONE ${TZ})`,
      );
    }
    return parts.length === 0 ? undefined : and(...parts);
  }

  /**
   * Whether the dimension has ever been filled.
   *
   * An empty `player_dimension` and a dimension nobody ever synced produce the
   * same query result, and reading the second as the first is how a collection
   * gap becomes a reported zero. The provenance table is what separates them.
   */
  private async dimensionState(): Promise<EconomySourceState> {
    try {
      const last = await this.dimension.lastSuccessfulSync();
      if (last === null) {
        return {
          name: 'player_dimension',
          ok: false,
          asOf: null,
          failure: 'never_synced',
        };
      }
      return {
        name: 'player_dimension',
        ok: true,
        // The ETL's own currency, not the moment of this request: the cohorts
        // are only as fresh as the last successful run.
        asOf: last.ranAt.toISOString(),
      };
    } catch (error) {
      this.logger.warn(
        `Procedencia da dimensao de jogador ilegivel: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return {
        name: 'player_dimension',
        ok: false,
        asOf: null,
        failure: 'query_failed',
      };
    }
  }

  private share(part: bigint, whole: bigint, n: number): Share {
    const percent = shareOf(part, whole);
    return percent === null
      ? {
          percent: null,
          n,
          unavailableReason:
            'receita total zero na janela — nao ha base para calcular ' +
            'participacao, o que nao e o mesmo que 0% de participacao',
        }
      : { percent, n };
  }

  private countShare(part: number, whole: number): Share {
    if (whole === 0) {
      return {
        percent: null,
        n: 0,
        unavailableReason:
          'coorte vazia — nao ha base para calcular a fracao que gastou',
      };
    }
    return { percent: Math.round((part / whole) * 1000) / 10, n: whole };
  }
}

/**
 * The sentence that matches the label.
 *
 * `dimensionState` already distinguishes `never_synced` from `query_failed`, and
 * both call sites used to emit the same three sentences telling the reader to
 * check two environment variables. On a night when the ETL ran fine and the
 * provenance read timed out, that sends the operator to the one place that is
 * not the problem — the same defect the alert layer paid for when a healthy Plan
 * was announced every fifteen minutes as "probably the wrong database".
 */
function dimensionReason(state: EconomySourceState): string {
  return state.failure === 'query_failed'
    ? DIMENSION_UNREADABLE
    : DIMENSION_NEVER_SYNCED;
}

const DIMENSION_UNREADABLE =
  'Nao foi possivel ler a procedencia da dimensao de jogador: a consulta a ' +
  '`player_dimension_syncs` falhou. Isto NAO diz que o ETL nao rodou — diz que ' +
  'nao deu para saber se rodou, e sem essa resposta uma coorte publicada ' +
  'poderia estar em cima de dado congelado sem que nada indicasse. A receita ' +
  'por plataforma continua valendo: ela sai do proprio uuid da venda (ADR-003).';

const DIMENSION_NEVER_SYNCED =
  'A dimensao de jogador nunca foi preenchida: o ETL do `/v1/retention` nao ' +
  'rodou com sucesso nenhuma vez (`PLAYER_DIMENSION_SYNC_ENABLED` desligado ou ' +
  '`PLAN_BASE_URL` ausente). Sem data de registro nao ha coorte, e publicar ' +
  'uma lista vazia aqui se leria como "nenhuma coorte produziu receita". A ' +
  'receita por plataforma continua valendo: ela sai do proprio uuid da venda ' +
  '(ADR-003) e nao depende deste ETL.';
