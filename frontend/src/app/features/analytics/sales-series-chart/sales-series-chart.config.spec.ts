import { SeriesReport } from '../../../core/models/analytics.model';
import {
  applyReport,
  axisLabel,
  buildAriaLabel,
  buildLineConfig,
  datasetValues,
  labels,
  toPlot,
} from './sales-series-chart.config';

const TOKENS = {
  series: '#a876f0',
  grid: 'rgba(119, 123, 158, 0.18)',
  ink: '#ffffff',
  inkMuted: '#777b9e',
  fontFamily: 'Roboto, system-ui, sans-serif',
};

const REPORT: SeriesReport = {
  itemId: 'caixaNatal2026',
  bucket: 'day',
  points: [
    { at: '2026-07-01', qty: 12, revenue: '1440.00' },
    { at: '2026-07-02', qty: 5, revenue: '600.30' },
  ],
  excludedHistorical: { qty: 300, revenue: '36000.00' },
};

describe('sales-series-chart.config', () => {
  it('plots qty as raw numbers', () => {
    expect(datasetValues(REPORT.points, 'qty')).toEqual([12, 5]);
  });

  it('converts the revenue string to a number only for the canvas', () => {
    expect(datasetValues(REPORT.points, 'revenue')).toEqual([1440, 600.3]);
  });

  it('uses the API day strings verbatim as the category axis', () => {
    expect(labels(REPORT.points)).toEqual(['2026-07-01', '2026-07-02']);
  });

  it('does not lose float precision on the string→number boundary', () => {
    // 0.1 + 0.2 is the canonical float trap; the API sends the correct string.
    expect(toPlot('0.30')).toBe(0.3);
  });

  it('labels the Y axis per measure', () => {
    expect(axisLabel('qty')).toBe('Quantidade');
    expect(axisLabel('revenue')).toBe('Receita (R$)');
  });

  it('summarises the series for aria-label', () => {
    const label = buildAriaLabel(REPORT, 'qty');
    expect(label).toContain('caixaNatal2026');
    expect(label).toContain('2 pontos');
    expect(label).toContain('2026-07-01');
    expect(label).toContain('2026-07-02');
    expect(label).toContain('17 unidades');
  });

  it('reports an empty series in the aria-label', () => {
    const empty: SeriesReport = { ...REPORT, points: [] };
    expect(buildAriaLabel(empty, 'qty')).toContain('Sem vendas');
  });

  it('builds a line config with a single token-coloured dataset', () => {
    const config = buildLineConfig(REPORT, 'qty', TOKENS);
    expect(config.type).toBe('line');
    expect(config.data.labels).toEqual(['2026-07-01', '2026-07-02']);
    expect(config.data.datasets.length).toBe(1);
    expect(config.data.datasets[0].data).toEqual([12, 5]);
    expect(config.data.datasets[0].borderColor).toBe(TOKENS.series);
  });

  it('does not register a Chart.js date adapter — X is a category scale', () => {
    const config = buildLineConfig(REPORT, 'qty', TOKENS);
    expect(config.options?.scales?.['x']?.type).toBe('category');
  });

  it('rewrites data and Y title in place for update(), not rebuild', () => {
    const config = buildLineConfig(REPORT, 'qty', TOKENS);
    const next: SeriesReport = {
      ...REPORT,
      points: [{ at: '2026-08-01', qty: 9, revenue: '1080.00' }],
    };

    const returned = applyReport(config, next, 'revenue', TOKENS);

    expect(returned).toBe(config); // same object, mutated
    expect(config.data.labels).toEqual(['2026-08-01']);
    expect(config.data.datasets[0].data).toEqual([1080]);
    const yScale = config.options?.scales?.['y'];
    expect(yScale?.type === 'linear' ? yScale.title?.text : undefined).toBe(
      'Receita (R$)',
    );
  });
});
