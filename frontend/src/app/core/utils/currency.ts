/**
 * The one BRL display formatter (spec S5.1 §2.5).
 *
 * Revenue crosses the API as a `numeric(12,2)` **string** and must stay one
 * until a human-facing boundary — a `parseFloat` upstream would reintroduce the
 * float error the column exists to prevent. This module is that boundary:
 * `Number()` happens here, at display time, and nowhere earlier.
 */

const BRL = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
});

/**
 * Format a revenue value as BRL. Accepts the API's decimal string (the normal
 * case) or a number that is already at a display boundary, e.g. a chart tick.
 */
export function formatBRL(revenue: string | number): string {
  return BRL.format(typeof revenue === 'string' ? Number(revenue) : revenue);
}
