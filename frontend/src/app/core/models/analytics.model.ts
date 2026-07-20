/**
 * Analytics read models (spec S5.1 §2.1), mirroring the backend response
 * verbatim — Drizzle/pg camelCases the columns on the way out, so no
 * client-side renaming.
 *
 * `revenue` is **always a string**. `total_price` is `numeric(12,2)` and the
 * `pg` driver returns `SUM(...)` as a string on purpose: keeping it a string
 * end-to-end preserves precision, and the UI formats it with `Intl.NumberFormat`
 * from that string (§2.5). A `parseFloat` in the middle reintroduces the exact
 * float error the `numeric` column exists to avoid — so this must never be typed
 * as `number`.
 */

/** Optional analysis window; both bounds are `YYYY-MM-DD` (America/Sao_Paulo). */
export interface AnalyticsPeriod {
  from?: string;
  to?: string;
}

/** Per-item aggregate inside a category report. */
export interface CategoryItemTotals {
  itemId: string;
  displayName: string;
  active: boolean;
  salesCount: number;
  totalQty: number;
  /** `numeric(12,2)` as a string — never parse into a `number`. */
  revenue: string;
}

/** `GET /analytics/categories/:id/items` response. */
export interface CategoryItemsReport {
  categoryId: number;
  items: CategoryItemTotals[];
}

/**
 * One ranked buyer of an item. `nickname` is the **current** nickname
 * (`last_known_nickname` joined from `players`), not the historical snapshot at
 * purchase time (CA4).
 */
export interface TopBuyer {
  playerUuid: string;
  nickname: string;
  salesCount: number;
  totalQty: number;
  /** `numeric(12,2)` as a string — never parse into a `number`. */
  revenue: string;
}

/** `GET /analytics/items/:itemId/top-buyers` response. */
export interface TopBuyersReport {
  itemId: string;
  buyers: TopBuyer[];
}

/** Bucket granularity of a time series. */
export type SeriesBucket = 'day' | 'week' | 'month';

/** One datapoint of a time series. `at` is a `YYYY-MM-DD` bucket start. */
export interface SeriesPoint {
  at: string;
  qty: number;
  /** `numeric(12,2)` as a string — never parse into a `number`. */
  revenue: string;
}

/**
 * `GET /analytics/items/:itemId/series` response.
 *
 * `excludedHistorical` carries the `historical_import` baseline explicitly: the
 * series excludes those rows because they have no real timestamp to plot (CA7),
 * but the totals they represent are surfaced as a textual annotation, never as a
 * dated point.
 */
export interface SeriesReport {
  itemId: string;
  bucket: SeriesBucket;
  points: SeriesPoint[];
  excludedHistorical: {
    qty: number;
    /** `numeric(12,2)` as a string — never parse into a `number`. */
    revenue: string;
  };
}
