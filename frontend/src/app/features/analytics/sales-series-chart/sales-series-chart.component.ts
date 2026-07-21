import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import {
  CategoryScale,
  Chart,
  type ChartConfiguration,
  Filler,
  Legend,
  LineController,
  LineElement,
  LinearScale,
  PointElement,
  Tooltip,
} from 'chart.js';

import {
  AnalyticsPeriod,
  SeriesBucket,
  SeriesReport,
} from '../../../core/models/analytics.model';
import { AnalyticsService } from '../../../core/services/analytics.service';
import {
  type ChartMode,
  type ChartTokens,
  applyReport,
  buildAriaLabel,
  buildLineConfig,
  datasetValues,
  formatRevenue,
} from './sales-series-chart.config';

/**
 * Selective Chart.js registration (ADR-0003): only the pieces a filled line
 * chart needs, so tree-shaking can drop the rest of the library. Registering at
 * module scope runs it exactly once, no matter how many charts mount. Never
 * `import 'chart.js/auto'` — that pulls in every controller and scale.
 */
Chart.register(
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Filler,
  Tooltip,
  Legend,
);

/** Fallback token values (from `_tokens.scss`) for when the custom property is
 * not resolvable — e.g. a unit test that mounts the component without the global
 * stylesheet. The live screen always reads the real token first. */
const TOKEN_FALLBACKS: ChartTokens = {
  series: '#a876f0',
  grid: 'rgba(119, 123, 158, 0.18)',
  ink: '#ffffff',
  inkMuted: '#777b9e',
  fontFamily: 'Roboto, system-ui, sans-serif',
};

/**
 * Time-series chart of one item's sales (S5.4).
 *
 * Framework-agnostic Chart.js v4 instantiated **directly** — no `ng2-charts`
 * wrapper (ADR-0003): wrappers lag new Angular majors and this is Angular 22.
 * The instance is created once and thereafter `update()`d in place; it is
 * destroyed on teardown so a route change leaves no dangling canvas listener
 * (§5.2). All colours/fonts come from `_tokens.scss` read at runtime, never
 * hardcoded in the options object (§5.3). The `what to draw` logic lives in the
 * pure `*.config.ts` module, which is unit-tested without a live canvas.
 */
@Component({
  selector: 'app-sales-series-chart',
  imports: [],
  templateUrl: './sales-series-chart.component.html',
  styleUrl: './sales-series-chart.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SalesSeriesChartComponent {
  private readonly analytics = inject(AnalyticsService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly destroyRef = inject(DestroyRef);

  /** Opaque business key of the item to chart (e.g. `caixaNatal2026`). */
  readonly itemId = input.required<string>();
  /** Analysis window; empty means whole history. */
  readonly period = input<AnalyticsPeriod>({});
  /** Bucket granularity; the MVP series is daily. */
  readonly bucket = input<SeriesBucket>('day');

  /** `qty` vs `revenue` — flips the plotted dataset and the Y axis (§5.3). */
  readonly mode = signal<ChartMode>('qty');

  /** Declared before `headingId`, which consumes it during field initialisation. */
  private static nextInstanceId = 0;

  /**
   * Per-instance heading id. The category page mounts one chart per **expanded**
   * item and lets several stay open at once, so a fixed id would repeat in the
   * DOM and every `aria-labelledby` would resolve to the first one.
   */
  readonly headingId = `sales-series-chart-${SalesSeriesChartComponent.nextInstanceId++}`;

  private readonly reportSignal = signal<SeriesReport | null>(null);
  private readonly loadingSignal = signal(false);
  private readonly errorSignal = signal(false);

  /** Latest loaded series, or `null` before the first response. */
  readonly report = this.reportSignal.asReadonly();
  readonly loading = this.loadingSignal.asReadonly();
  readonly loadError = this.errorSignal.asReadonly();

  private readonly canvasRef =
    viewChild<ElementRef<HTMLCanvasElement>>('canvas');

  private chart?: Chart;
  private config?: ChartConfiguration<'line', number[], string>;
  private cachedTokens?: ChartTokens;

  /** Points of the current report (empty until loaded / when there are none). */
  readonly points = computed(() => this.report()?.points ?? []);

  /** True once loaded and there is at least one dated point to plot. */
  readonly hasData = computed(() => this.points().length > 0);

  /** Loaded, succeeded, but the window holds no dated sales. */
  readonly isEmpty = computed(
    () => this.report() !== null && this.points().length === 0,
  );

  /** Pre-migration baseline to surface as text, never as a dated point (CA7). */
  readonly excludedHistorical = computed(
    () => this.report()?.excludedHistorical ?? null,
  );

  readonly hasExcludedHistorical = computed(
    () => (this.excludedHistorical()?.qty ?? 0) > 0,
  );

  /** Baseline as ready-to-render text ("Histórico pré-migração: N vendas, R$ X"). */
  readonly excludedHistoricalLabel = computed(() => {
    const excluded = this.excludedHistorical();
    if (!excluded || excluded.qty <= 0) {
      return null;
    }
    const sales = `${excluded.qty} ${excluded.qty === 1 ? 'venda' : 'vendas'}`;
    return `Histórico pré-migração: ${sales}, ${formatRevenue(excluded.revenue)}`;
  });

  /** Spoken summary for the chart's `role="img"` element. */
  readonly ariaLabel = computed(() => {
    const report = this.report();
    return report ? buildAriaLabel(report, this.mode()) : 'Gráfico de vendas';
  });

  /**
   * The exact numbers handed to the canvas for the active measure. Exposed so
   * the toggle behaviour can be asserted without reaching into the Chart.js
   * instance.
   */
  readonly plottedValues = computed(() =>
    datasetValues(this.points(), this.mode()),
  );

  constructor() {
    // Data effect: any input change reloads the series. Kept apart from the
    // render effect so a measure toggle redraws without refetching.
    effect((onCleanup) => {
      const itemId = this.itemId();
      const period = this.period();
      const bucket = this.bucket();

      this.loadingSignal.set(true);
      this.errorSignal.set(false);
      const sub = this.analytics.series(itemId, period, bucket).subscribe({
        next: (report) => {
          this.reportSignal.set(report);
          this.loadingSignal.set(false);
        },
        error: () => {
          this.reportSignal.set(null);
          this.errorSignal.set(true);
          this.loadingSignal.set(false);
        },
      });
      onCleanup(() => sub.unsubscribe());
    });

    // Render effect: create the chart once, then update it in place. When there
    // is no canvas (empty/loading/error hides it) tear the instance down so no
    // listener outlives the element.
    effect(() => {
      const canvas = this.canvasRef();
      const report = this.report();
      const mode = this.mode();

      if (!canvas || !report || report.points.length === 0) {
        this.destroyChart();
        return;
      }

      const tokens = this.tokens();
      if (this.chart && this.config) {
        applyReport(this.config, report, mode, tokens);
        this.chart.update();
      } else {
        this.config = buildLineConfig(report, mode, tokens);
        this.chart = new Chart(canvas.nativeElement, this.config);
      }
    });

    this.destroyRef.onDestroy(() => this.destroyChart());
  }

  /** Flip the plotted measure; the render effect picks up the signal change. */
  setMode(mode: ChartMode): void {
    this.mode.set(mode);
  }

  /** Format a `numeric(12,2)` string as BRL for the screen-reader table. */
  formatMoney(revenue: string): string {
    return formatRevenue(revenue);
  }

  /** @internal Test seam: whether a live Chart.js instance currently exists. */
  get hasChartInstance(): boolean {
    return this.chart !== undefined;
  }

  /** @internal Test seam: the numbers currently on the canvas dataset. */
  get chartDatasetValues(): readonly number[] | undefined {
    return this.chart?.data.datasets[0]?.data as number[] | undefined;
  }

  private destroyChart(): void {
    this.chart?.destroy();
    this.chart = undefined;
    this.config = undefined;
  }

  /**
   * Read the AusTV visual tokens off the host once. Cached because the theme is
   * a single fixed dark palette — there is no light variant to react to.
   */
  private tokens(): ChartTokens {
    if (this.cachedTokens) {
      return this.cachedTokens;
    }
    const style = getComputedStyle(this.host.nativeElement);
    const read = (name: string, fallback: string): string =>
      style.getPropertyValue(name).trim() || fallback;

    this.cachedTokens = {
      series: read('--color-chart-series', TOKEN_FALLBACKS.series),
      grid: read('--color-line', TOKEN_FALLBACKS.grid),
      ink: read('--color-ink', TOKEN_FALLBACKS.ink),
      inkMuted: read('--color-ink-muted', TOKEN_FALLBACKS.inkMuted),
      fontFamily: read('--font-body', TOKEN_FALLBACKS.fontFamily),
    };
    return this.cachedTokens;
  }
}
