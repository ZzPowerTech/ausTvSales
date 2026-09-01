/**
 * Money and percentile arithmetic for the economy layer (story S9.1).
 *
 * ## Money never becomes a float, at any point
 *
 * Spec §2.5 of `PROJECT.md`: `SUM(total_price)` stays a decimal end to end,
 * because `numeric(12,2)` exists precisely to keep the rounding error out. The
 * analytics module honours that by passing the string through untouched.
 *
 * This module cannot pass through untouched — it has to **re-group** per-player
 * sums into platforms and cohorts, and grouping means adding. So the addition
 * happens in **integer cents**, as `bigint`, which is exact for any total this
 * server could ever produce, and the result is formatted back to a decimal
 * string. At no point does a value pass through `Number`.
 *
 * The alternative was expressing ADR-003's UUID rule in SQL so Postgres could do
 * the grouping. That rule already exists in TypeScript (`platformOf`), and the
 * funnel service records why writing it a second time in a second language is a
 * bad trade: the two spellings drift, and the drift is silent.
 */

/**
 * Parse an integer-cents string as it arrives from Postgres.
 *
 * `bigint` columns come back as strings from `pg` precisely so nothing is lost,
 * and this is the only place that conversion happens.
 */
export function toCents(raw: unknown): bigint {
  if (typeof raw === 'bigint') {
    return raw;
  }
  if (typeof raw === 'number' && Number.isInteger(raw)) {
    return BigInt(raw);
  }
  if (typeof raw === 'string' && /^-?\d+$/.test(raw.trim())) {
    return BigInt(raw.trim());
  }
  // Not a silent zero: a caller that could not read a sum must not publish it as
  // "nobody spent anything". Callers treat the throw as a query failure.
  throw new TypeError(
    `valor monetario ilegivel vindo do banco: ${String(raw)}`,
  );
}

/** Format integer cents as a decimal string with two places. */
export function formatCents(cents: bigint): string {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const whole = absolute / 100n;
  const fraction = absolute % 100n;
  return `${negative ? '-' : ''}${whole}.${fraction.toString().padStart(2, '0')}`;
}

/**
 * Share of `part` in `whole`, as a percentage with one decimal.
 *
 * Returns `null` when the base is zero — dividing by it is undefined, and
 * publishing `0%` there would invent a reading out of an empty period. Same rule
 * the funnel's `convert` applies, for the same reason.
 */
export function shareOf(part: bigint, whole: bigint): number | null {
  if (whole === 0n) {
    return null;
  }
  // Scaled integer division keeps the ratio exact up to the published decimal:
  // converting two large cent totals to Number first could lose precision above
  // 2^53, which this server will never reach but the reader of this code cannot
  // tell at a glance.
  const scaled = (part * 1000n) / whole;
  return Number(scaled) / 10;
}

/**
 * Nearest-rank percentile of a sorted-on-demand sample.
 *
 * Nearest-rank rather than interpolated, and the choice is worth a line: with
 * cohorts of a few dozen players, an interpolated median invents a value between
 * two real observations, and every consumer of this number is going to read it
 * as "a player waited this long". Nearest-rank always returns a day count
 * somebody actually waited.
 *
 * @returns `null` for an empty sample — never zero, which would read as
 *   "everybody bought on day one".
 */
export function percentile(
  values: readonly number[],
  fraction: number,
): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(fraction * sorted.length);
  const index = Math.min(Math.max(rank, 1), sorted.length) - 1;
  return sorted[index];
}

/**
 * Coerce a timestamp coming back from Postgres into a `Date`.
 *
 * ## Why this exists, and it is not defensive programming for its own sake
 *
 * The `pg` driver parses a plain `timestamptz` **column** into a `Date`, and the
 * TypeScript row types say so. It does not always do the same for the result of
 * an **aggregate**: `min(purchased_at)` came back as a string, and
 * `row.first_purchase_at.getTime()` threw `is not a function` — caught by the
 * e2e suite, which is the only place that runs against a real server.
 *
 * The lesson is the one this repo keeps relearning about someone else's
 * contract: the row type is what the code *believes*, not what the driver
 * *does*. Every timestamp read through `db.execute` goes through here.
 *
 * @returns `null` for anything unusable — never `new Date()`, which would file a
 *   row under today and produce a measurement nobody can audit.
 */
export function toDate(raw: unknown): Date | null {
  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime()) ? null : raw;
  }
  if (typeof raw === 'string' || typeof raw === 'number') {
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}
