import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../db/database.module';
import { categories, items, players, sales } from '../db/schema';
import type { PeriodQueryDto } from './dto/period-query.dto';
import {
  DEFAULT_SERIES_BUCKET,
  type SeriesBucket,
} from './dto/series-query.dto';
import { DEFAULT_TOP_BUYERS_LIMIT } from './dto/top-buyers-query.dto';

/** IANA zone for every date boundary and bucket (project convention). */
const TZ = 'America/Sao_Paulo';

/** Hard ceiling on series points (spec §2.8): protects the chart and the server. */
const MAX_SERIES_BUCKETS = 366;

const MS_PER_DAY = 86_400_000;

export interface CategoryItemTotals {
  itemId: string;
  displayName: string;
  active: boolean;
  salesCount: number;
  totalQty: number;
  /** Decimal string straight from `SUM(numeric)` — never parsed to a float (§2.5). */
  revenue: string;
}

export interface CategoryItemsReport {
  categoryId: number;
  items: CategoryItemTotals[];
}

export interface TopBuyer {
  playerUuid: string;
  /** Current display name (`players.last_known_nickname`), not the snapshot (§2.6). */
  nickname: string;
  salesCount: number;
  totalQty: number;
  revenue: string;
}

export interface TopBuyersReport {
  itemId: string;
  buyers: TopBuyer[];
}

export interface SeriesPoint {
  /** Bucket start as `YYYY-MM-DD` in São Paulo. */
  at: string;
  qty: number;
  revenue: string;
}

export interface SeriesReport {
  itemId: string;
  bucket: SeriesBucket;
  points: SeriesPoint[];
  /**
   * Pre-migration total carried as an explicit baseline (§2.4): `historical_import`
   * rows have no real timestamp, so they are kept out of `points` and surfaced
   * here instead — a textual annotation, never a dated point (CA7).
   */
  excludedHistorical: { qty: number; revenue: string };
}

/**
 * Read-side aggregations for the dashboard (spec S5.1).
 *
 * Deliberately its own module, not part of `sales`: `sales` is the plugin's
 * write path (API-key guard, throttle), while this is the dashboard's read path
 * (session guard). Keeping them apart is how a guard never ends up on the wrong
 * route.
 *
 * Two rules run through every method here:
 *  - **Timezone (§2.3):** every date boundary and bucket is evaluated
 *    `AT TIME ZONE 'America/Sao_Paulo'`. Without it a 21:00 BRT sale lands in the
 *    next day's UTC bucket and a launch spike splits across two days.
 *  - **Money (§2.5):** `SUM(total_price)` stays a string end to end. A `parseFloat`
 *    anywhere reintroduces the rounding error `numeric(12,2)` exists to prevent.
 *
 * Queries use raw `sql` with Drizzle column refs (`${sales.purchasedAt}` renders
 * as `"sales"."purchased_at"`) rather than manual table aliases, so the shared
 * period predicate from {@link periodBounds} composes into every statement.
 */
@Injectable()
export class AnalyticsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async categoryItems(
    categoryId: number,
    period: PeriodQueryDto,
  ): Promise<CategoryItemsReport> {
    await this.assertCategoryExists(categoryId);
    const window = this.periodBounds(period);

    // Period lives in the LEFT JOIN's ON, not the WHERE: an item with no sales
    // in the window must still appear with zeros (CA: list the category's items).
    // Totals include historical_import — the history counts for apuração (§2.4).
    const rows = await this.db.execute<CategoryItemRow>(sql`
      SELECT
        ${items.itemId} AS item_id,
        ${items.displayName} AS display_name,
        ${items.active} AS active,
        count(${sales.id})::int AS sales_count,
        coalesce(sum(${sales.qtd}), 0)::int AS total_qty,
        -- Force scale 2 so an item with no sales reads "0.00", not "0":
        -- the coalesce fallback (integer 0) would otherwise drop the decimals.
        coalesce(sum(${sales.totalPrice}), 0)::numeric(12,2)::text AS revenue
      FROM ${items}
      LEFT JOIN ${sales}
        ON ${sales.itemId} = ${items.itemId}
        ${window ? sql`AND ${window}` : sql``}
      WHERE ${items.categoryId} = ${categoryId}
      GROUP BY ${items.id}
      ORDER BY ${items.itemId} ASC
    `);

    return {
      categoryId,
      items: rows.rows.map((row) => ({
        itemId: row.item_id,
        displayName: row.display_name,
        active: row.active,
        salesCount: row.sales_count,
        totalQty: row.total_qty,
        revenue: row.revenue,
      })),
    };
  }

  async topBuyers(
    itemId: string,
    period: PeriodQueryDto,
    limit: number = DEFAULT_TOP_BUYERS_LIMIT,
  ): Promise<TopBuyersReport> {
    await this.assertItemExists(itemId);
    const window = this.periodBounds(period);

    // Aggregate by player_uuid, then join players for the CURRENT nickname
    // (last_known_nickname), not sales.nickname_at_purchase which is the frozen
    // snapshot (§2.6, CA4). Historical rows are included: quem comprou, comprou.
    const condition = window
      ? and(eq(sales.itemId, itemId), window)
      : eq(sales.itemId, itemId);

    const rows = await this.db.execute<TopBuyerRow>(sql`
      SELECT
        ${sales.playerUuid} AS player_uuid,
        ${players.lastKnownNickname} AS nickname,
        count(${sales.id})::int AS sales_count,
        sum(${sales.qtd})::int AS total_qty,
        sum(${sales.totalPrice})::text AS revenue
      FROM ${sales}
      JOIN ${players} ON ${players.uuid} = ${sales.playerUuid}
      WHERE ${condition}
      GROUP BY ${sales.playerUuid}, ${players.lastKnownNickname}
      ORDER BY sum(${sales.totalPrice}) DESC, sum(${sales.qtd}) DESC, ${players.lastKnownNickname} ASC
      LIMIT ${limit}
    `);

    return {
      itemId,
      buyers: rows.rows.map((row) => ({
        playerUuid: row.player_uuid,
        nickname: row.nickname,
        salesCount: row.sales_count,
        totalQty: row.total_qty,
        revenue: row.revenue,
      })),
    };
  }

  async series(
    itemId: string,
    period: PeriodQueryDto,
    bucket: SeriesBucket = DEFAULT_SERIES_BUCKET,
  ): Promise<SeriesReport> {
    await this.assertItemExists(itemId);
    const window = this.periodBounds(period);
    await this.assertBucketCountWithinLimit(itemId, period, bucket, window);

    // Series EXCLUDES historical_import (§2.4, CA7): those rows have no real
    // per-event timestamp to plot. The truncation runs in São Paulo local time
    // so a launch spike is not split across a UTC day boundary (§2.3).
    const points = await this.db.execute<SeriesRow>(sql`
      SELECT
        to_char(
          date_trunc(${bucket}, ${sales.purchasedAt} AT TIME ZONE ${TZ}),
          'YYYY-MM-DD'
        ) AS at,
        sum(${sales.qtd})::int AS qty,
        sum(${sales.totalPrice})::text AS revenue
      FROM ${sales}
      WHERE ${sales.itemId} = ${itemId}
        AND ${sales.historicalImport} = false
        ${window ? sql`AND ${window}` : sql``}
      GROUP BY 1
      ORDER BY 1 ASC
    `);

    // Baseline: the item's whole pre-migration total, independent of the period
    // (the historical rows all sit before any window anyway). Surfaced so the
    // chart can annotate it instead of a caller "fixing" the exclusion.
    const baseline = await this.db.execute<BaselineRow>(sql`
      SELECT
        coalesce(sum(${sales.qtd}), 0)::int AS qty,
        coalesce(sum(${sales.totalPrice}), 0)::numeric(12,2)::text AS revenue
      FROM ${sales}
      WHERE ${sales.itemId} = ${itemId} AND ${sales.historicalImport} = true
    `);

    const baseRow = baseline.rows[0];
    return {
      itemId,
      bucket,
      points: points.rows.map((row) => ({
        at: row.at,
        qty: row.qty,
        revenue: row.revenue,
      })),
      excludedHistorical: {
        // The aggregate always returns one row, so these fallbacks are defensive
        // only; keep the "0.00" shape consistent with the SQL's scale.
        qty: baseRow?.qty ?? 0,
        revenue: baseRow?.revenue ?? '0.00',
      },
    };
  }

  /**
   * Build the period predicate over `sales.purchased_at`.
   *
   * Each bound is a São Paulo wall-clock instant: `from` opens at 00:00 that day,
   * `to` is inclusive as a day so the upper bound is the start of the following
   * day — the half-open `[from, to+1d)` window (§2.2). Returns `undefined` when
   * neither bound is set (all history). Throws `400` on an inverted range so all
   * three routes reject it identically.
   */
  private periodBounds(period: PeriodQueryDto): SQL | undefined {
    const { from, to } = period;
    if (from && to && from > to) {
      throw new BadRequestException('from must be on or before to');
    }

    const parts: SQL[] = [];
    if (from) {
      parts.push(
        sql`${sales.purchasedAt} >= (${from}::date::timestamp AT TIME ZONE ${TZ})`,
      );
    }
    if (to) {
      parts.push(
        sql`${sales.purchasedAt} < ((${to}::date + interval '1 day')::timestamp AT TIME ZONE ${TZ})`,
      );
    }
    if (parts.length === 0) {
      return undefined;
    }
    return parts.length === 1 ? parts[0] : and(...parts);
  }

  /**
   * Reject a series whose window would produce more than {@link MAX_SERIES_BUCKETS}
   * points (§2.8). When the caller gives no bounds, the effective span is derived
   * from the item's own min/max eligible (non-historical) sale, so an open-ended
   * `?bucket=day` over years of data fails fast instead of streaming thousands of
   * points — a cheap DoS even behind a session.
   */
  private async assertBucketCountWithinLimit(
    itemId: string,
    period: PeriodQueryDto,
    bucket: SeriesBucket,
    window: SQL | undefined,
  ): Promise<void> {
    let fromDate = period.from;
    let toDate = period.to;

    if (!fromDate || !toDate) {
      const bounds = await this.db.execute<SeriesBoundsRow>(sql`
        SELECT
          to_char(min(${sales.purchasedAt} AT TIME ZONE ${TZ}), 'YYYY-MM-DD') AS min_at,
          to_char(max(${sales.purchasedAt} AT TIME ZONE ${TZ}), 'YYYY-MM-DD') AS max_at
        FROM ${sales}
        WHERE ${sales.itemId} = ${itemId}
          AND ${sales.historicalImport} = false
          ${window ? sql`AND ${window}` : sql``}
      `);
      const row = bounds.rows[0];
      // No eligible rows: the series will be empty, nothing to cap.
      if (!row?.min_at || !row?.max_at) {
        return;
      }
      fromDate = fromDate ?? row.min_at;
      toDate = toDate ?? row.max_at;
    }

    const count = bucketCount(fromDate, toDate, bucket);
    if (count > MAX_SERIES_BUCKETS) {
      throw new BadRequestException(
        `Requested window spans ${count} ${bucket} buckets; the maximum is ${MAX_SERIES_BUCKETS}. ` +
          `Narrow the period or use a coarser bucket.`,
      );
    }
  }

  private async assertCategoryExists(categoryId: number): Promise<void> {
    const [category] = await this.db
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.id, categoryId))
      .limit(1);
    if (!category) {
      throw new NotFoundException(`Category ${categoryId} not found`);
    }
  }

  private async assertItemExists(itemId: string): Promise<void> {
    const [item] = await this.db
      .select({ itemId: items.itemId })
      .from(items)
      .where(eq(items.itemId, itemId))
      .limit(1);
    if (!item) {
      throw new NotFoundException(`Item "${itemId}" not found`);
    }
  }
}

// Raw-query row shapes. `db.execute<T>` constrains T to `Record<string, unknown>`,
// so these are `type` aliases (which carry an implicit index signature) rather
// than interfaces (which do not).
type CategoryItemRow = {
  item_id: string;
  display_name: string;
  active: boolean;
  sales_count: number;
  total_qty: number;
  revenue: string;
};

type TopBuyerRow = {
  player_uuid: string;
  nickname: string;
  sales_count: number;
  total_qty: number;
  revenue: string;
};

type SeriesRow = {
  at: string;
  qty: number;
  revenue: string;
};

type BaselineRow = {
  qty: number;
  revenue: string;
};

type SeriesBoundsRow = {
  min_at: string | null;
  max_at: string | null;
};

/**
 * Number of `bucket` slots covered by the inclusive date range `[from, to]`
 * (both `YYYY-MM-DD`). Used only for the §2.8 cap, so an upper-bound estimate is
 * fine — week rounds up, month counts calendar months spanned.
 */
export function bucketCount(
  from: string,
  to: string,
  bucket: SeriesBucket,
): number {
  const fromMs = Date.parse(`${from}T00:00:00Z`);
  const toMs = Date.parse(`${to}T00:00:00Z`);
  const days = Math.floor((toMs - fromMs) / MS_PER_DAY) + 1;

  if (bucket === 'day') {
    return days;
  }
  if (bucket === 'week') {
    return Math.ceil(days / 7);
  }
  const [fromYear, fromMonth] = from.split('-').map(Number);
  const [toYear, toMonth] = to.split('-').map(Number);
  return (toYear - fromYear) * 12 + (toMonth - fromMonth) + 1;
}
