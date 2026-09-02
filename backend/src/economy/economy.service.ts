import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, sql, type SQL } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../db/database.module';
import { playerDimension, sales } from '../db/schema';
import { platformOf, type Platform } from '../instrumentation/platform';
import {
  formatCents,
  percentile,
  shareOf,
  toCents,
  toDate,
} from './economy-math';
import { PlayerDimensionStore } from './player-dimension.store';
import {
  FUNNEL_POSITION_UNAVAILABLE,
  type CohortFirstSpend,
  type CohortRevenue,
  type EconomyRevenueReport,
  type EconomySourceState,
  type FirstSpendReport,
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
        ? { cohortUnavailableReason: DIMENSION_NEVER_SYNCED }
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
    const dimensionState = await this.dimensionState();

    if (!dimensionState.ok) {
      return {
        from: fromMonth,
        to: toMonth,
        byCohort: null,
        unavailableReason: DIMENSION_NEVER_SYNCED,
        byFunnelPosition: null,
        funnelPositionUnavailableReason: FUNNEL_POSITION_UNAVAILABLE,
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
      .map((group) => ({
        cohort: group.cohort,
        platform: group.platform,
        cohortSize: group.size,
        spenders: group.days.length,
        everSpent: this.countShare(group.days.length, group.size),
        medianDaysToFirstSpend: percentile(group.days, 0.5),
        p90DaysToFirstSpend: percentile(group.days, 0.9),
        beforeRegistration: group.beforeRegistration,
      }))
      .sort(
        (a, b) =>
          a.cohort.localeCompare(b.cohort) ||
          a.platform.localeCompare(b.platform),
      );

    return {
      from: fromMonth,
      to: toMonth,
      byCohort,
      byFunnelPosition: null,
      funnelPositionUnavailableReason: FUNNEL_POSITION_UNAVAILABLE,
      sources: [{ name: 'sales', ok: true, asOf: null }, dimensionState],
    };
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

const DIMENSION_NEVER_SYNCED =
  'A dimensao de jogador nunca foi preenchida: o ETL do `/v1/retention` nao ' +
  'rodou com sucesso nenhuma vez (`PLAYER_DIMENSION_SYNC_ENABLED` desligado ou ' +
  '`PLAN_BASE_URL` ausente). Sem data de registro nao ha coorte, e publicar ' +
  'uma lista vazia aqui se leria como "nenhuma coorte produziu receita". A ' +
  'receita por plataforma continua valendo: ela sai do proprio uuid da venda ' +
  '(ADR-003) e nao depende deste ETL.';
