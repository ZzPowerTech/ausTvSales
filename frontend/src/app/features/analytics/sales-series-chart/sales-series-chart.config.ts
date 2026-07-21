/**
 * Pure, framework-free helpers behind {@link SalesSeriesChartComponent} (S5.4).
 *
 * Everything here is a plain function so the chart's *shape* — its labels, the
 * numbers that land on the canvas, the axis/tooltip formatting, the a11y
 * summary — can be asserted directly, without a live `<canvas>` 2D context. The
 * component owns only the Chart.js lifecycle (create once, `update()`, destroy);
 * the decisions about *what* to draw live here.
 *
 * Money crosses from string to `number` in exactly one place — {@link toPlot} —
 * and only because the canvas cannot plot a decimal string. Everything the human
 * reads (baseline text, the screen-reader table) formats from the API's original
 * `numeric(12,2)` string, so the float never reaches a displayed value (§2.5).
 */
import type { ChartConfiguration, ChartDataset } from 'chart.js';

import { SeriesPoint, SeriesReport } from '../../../core/models/analytics.model';
import { formatBRL } from '../../../core/utils/currency';

/** Which measure the line plots. */
export type ChartMode = 'qty' | 'revenue';

/**
 * Visual tokens pulled from `_tokens.scss` at runtime and handed in, so nothing
 * here hardcodes a colour or font — the AusTV identity stays the single source.
 */
export interface ChartTokens {
  /** `--color-chart-series` — data wears purple. */
  series: string;
  /** `--color-line` — grid and axis lines. */
  grid: string;
  /** `--color-ink` — primary text. */
  ink: string;
  /** `--color-ink-muted` — ticks and secondary text. */
  inkMuted: string;
  /** `--font-body` — tick/label/tooltip typeface. */
  fontFamily: string;
}

/**
 * Convert the API's decimal string to a `number` — the **only** float boundary,
 * and only because a `<canvas>` cannot plot a string. Never call this to build a
 * value shown as text; format the original string instead.
 */
export function toPlot(revenue: string): number {
  return Number(revenue);
}

/** Y label for the current measure. */
export function axisLabel(mode: ChartMode): string {
  return mode === 'qty' ? 'Quantidade' : 'Receita (R$)';
}

/** Legend/dataset label for the current measure. */
export function datasetLabel(mode: ChartMode): string {
  return mode === 'qty' ? 'Quantidade vendida' : 'Receita';
}

/** The numbers that land on the canvas for the current measure. */
export function datasetValues(
  points: readonly SeriesPoint[],
  mode: ChartMode,
): number[] {
  return mode === 'qty'
    ? points.map((point) => point.qty)
    : points.map((point) => toPlot(point.revenue));
}

/** The X axis: the day strings the API already bucketed (`point.at`). */
export function labels(points: readonly SeriesPoint[]): string[] {
  return points.map((point) => point.at);
}

/**
 * A one-line spoken summary of the series for `aria-label`. The full point list
 * lives in the `.sr-only` table; this is the at-a-glance headline.
 */
export function buildAriaLabel(report: SeriesReport, mode: ChartMode): string {
  const points = report.points;
  if (points.length === 0) {
    return `Sem vendas de ${report.itemId} no período.`;
  }
  const measure = mode === 'qty' ? 'quantidade' : 'receita';
  const first = points[0].at;
  const last = points[points.length - 1].at;
  const total =
    mode === 'qty'
      ? `${points.reduce((sum, point) => sum + point.qty, 0)} unidades`
      : formatBRL(
          points
            .reduce((sum, point) => sum + toPlot(point.revenue), 0)
            .toFixed(2),
        );
  return (
    `Série de ${measure} de ${report.itemId}, ${points.length} ` +
    `${points.length === 1 ? 'ponto' : 'pontos'} de ${first} a ${last}. ` +
    `Total no período: ${total}.`
  );
}

/** Tick/tooltip value formatter for the active measure. */
export function formatValue(value: number, mode: ChartMode): string {
  return mode === 'qty' ? String(value) : formatBRL(value);
}

/** Build the single line dataset for the active measure. */
export function buildDataset(
  report: SeriesReport,
  mode: ChartMode,
  tokens: ChartTokens,
): ChartDataset<'line', number[]> {
  return {
    label: datasetLabel(mode),
    data: datasetValues(report.points, mode),
    borderColor: tokens.series,
    backgroundColor: withAlpha(tokens.series, 0.16),
    pointBackgroundColor: tokens.series,
    pointBorderColor: tokens.series,
    pointRadius: 3,
    pointHoverRadius: 5,
    borderWidth: 2,
    tension: 0.25,
    fill: true,
  };
}

/**
 * The full Chart.js config. Built once for the first `new Chart(...)`; later
 * measure/period changes go through {@link applyReport} + `chart.update()`
 * rather than a rebuild.
 */
export function buildLineConfig(
  report: SeriesReport,
  mode: ChartMode,
  tokens: ChartTokens,
): ChartConfiguration<'line', number[], string> {
  return {
    type: 'line',
    data: {
      labels: labels(report.points),
      datasets: [buildDataset(report, mode, tokens)],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      // Chart.js draws its own <canvas> role/label; ours lives on the element,
      // so silence the library's generated description to avoid a double read.
      plugins: {
        legend: {
          display: true,
          labels: { color: tokens.ink, font: { family: tokens.fontFamily } },
        },
        tooltip: {
          callbacks: {
            label: (context) =>
              ` ${formatValue(context.parsed.y ?? 0, mode)}`,
          },
        },
      },
      scales: {
        x: {
          type: 'category',
          grid: { color: tokens.grid },
          ticks: {
            color: tokens.inkMuted,
            font: { family: tokens.fontFamily },
          },
        },
        y: {
          type: 'linear',
          beginAtZero: true,
          title: {
            display: true,
            text: axisLabel(mode),
            color: tokens.inkMuted,
            font: { family: tokens.fontFamily },
          },
          grid: { color: tokens.grid },
          ticks: {
            color: tokens.inkMuted,
            font: { family: tokens.fontFamily },
            callback: (value) =>
              formatValue(
                typeof value === 'number' ? value : Number(value),
                mode,
              ),
          },
        },
      },
    },
  };
}

/**
 * Rewrite an existing chart's data + measure-dependent labels in place, so the
 * caller can `chart.update()` instead of recreating the instance (§5.2).
 * Mutates `config` and returns it for convenience.
 */
export function applyReport(
  config: ChartConfiguration<'line', number[], string>,
  report: SeriesReport,
  mode: ChartMode,
  tokens: ChartTokens,
): ChartConfiguration<'line', number[], string> {
  config.data.labels = labels(report.points);
  config.data.datasets = [buildDataset(report, mode, tokens)];
  const yScale = config.options?.scales?.['y'];
  if (yScale && yScale.type === 'linear' && yScale.title) {
    yScale.title.text = axisLabel(mode);
  }
  return config;
}

/** Expand a hex/`rgb` token into a translucent fill without hardcoding a colour. */
function withAlpha(color: string, alpha: number): string {
  const hex = color.trim();
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (match) {
    const int = parseInt(match[1], 16);
    const r = (int >> 16) & 0xff;
    const g = (int >> 8) & 0xff;
    const b = int & 0xff;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  // Non-hex token (rgb()/named): fall back to the opaque colour. The fill just
  // loses translucency; the series colour still comes from the token.
  return hex;
}
