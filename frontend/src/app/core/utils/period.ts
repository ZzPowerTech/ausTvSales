/**
 * Calendar-date helpers for the analysis period (spec S5.3 §4.1).
 *
 * Every date the dashboard puts in a URL is a `YYYY-MM-DD` calendar day in
 * **America/Sao_Paulo**, the project timezone. Brazil abolished DST in 2019, so
 * the fixed `-03:00` offset is correct and stable — no timezone library needed
 * for arithmetic this small.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Fixed America/Sao_Paulo offset — no DST to track. */
const SP_OFFSET_MS = 3 * 60 * 60 * 1000;

export interface PresetRange {
  from: string;
  to: string;
}

/** Calendar date (`YYYY-MM-DD`) of an instant, read in America/Sao_Paulo. */
export function isoDateInSaoPaulo(instantMs: number): string {
  // Shift by the fixed offset, then take the UTC calendar date of the shifted
  // instant — with no DST the two operations compose exactly.
  return new Date(instantMs - SP_OFFSET_MS).toISOString().slice(0, 10);
}

/** `[today - (days - 1), today]` inclusive, on the São Paulo calendar. */
export function presetRange(
  days: number,
  nowMs: number = Date.now(),
): PresetRange {
  return {
    from: isoDateInSaoPaulo(nowMs - (days - 1) * DAY_MS),
    to: isoDateInSaoPaulo(nowMs),
  };
}
