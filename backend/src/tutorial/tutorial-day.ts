/**
 * Bucketing of an epoch into an AusTV calendar day (story S8.0).
 *
 * Every date in this project is `YYYY-MM-DD` in **America/Sao_Paulo**
 * (`CLAUDE.md`). The tutorial series is built in JavaScript rather than in SQL,
 * so the conversion has to happen here — and it has to happen with a real time
 * zone, not with `toISOString().slice(0, 10)`.
 *
 * The difference is not cosmetic. A player who enters the tutorial at 21:00 BRT
 * is at 00:00 UTC **the next day**: slicing the ISO string would file them under
 * tomorrow. Every evening in Brazil — which is when this server is busiest —
 * would leak into the following day, and the daily series would be quietly wrong
 * in the same direction every single day.
 */

const TIME_ZONE = 'America/Sao_Paulo';

/**
 * `Intl` formatter reused across calls.
 *
 * Constructing one per file would matter: the ETL converts up to two timestamps
 * for each of ~20.000 files, and `DateTimeFormat` construction is the expensive
 * part of `Intl`.
 *
 * `en-CA` is not a stylistic choice — it is the locale whose short date format
 * is already `YYYY-MM-DD`, so no reassembly of parts is needed.
 */
const FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * Convert epoch milliseconds to a `YYYY-MM-DD` day in America/Sao_Paulo.
 *
 * @returns the day, or `null` when the input is not a usable epoch. Null is
 *   deliberate rather than a fallback to "today": a row with an unusable date
 *   must be dropped from the series and counted as undated, never filed under a
 *   day it did not happen on.
 */
export function toSaoPauloDay(epochMs: number | null): string | null {
  if (epochMs === null || !Number.isFinite(epochMs) || epochMs <= 0) {
    return null;
  }

  const formatted = FORMATTER.format(new Date(epochMs));
  // `Intl` can hand back a non-Gregorian rendering if the runtime resolves the
  // locale unexpectedly. Cheap to assert, and the alternative is a malformed
  // date reaching a `date` column and failing far from here.
  return /^\d{4}-\d{2}-\d{2}$/.test(formatted) ? formatted : null;
}
