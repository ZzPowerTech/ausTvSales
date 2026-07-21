import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
  signal,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';

import {
  AnalyticsPeriod,
  CategoryItemsReport,
  TopBuyer,
} from '../../core/models/analytics.model';
import { AnalyticsService } from '../../core/services/analytics.service';
import { CategoriesService } from '../../core/services/categories.service';
import { formatBRL } from '../../core/utils/currency';
import { presetRange } from '../../core/utils/period';
import { SalesSeriesChartComponent } from './sales-series-chart/sales-series-chart.component';

/** Per-item top-5 drilldown state, loaded on demand when the item is expanded. */
interface BuyersState {
  loading: boolean;
  error: boolean;
  /** `null` until the first response lands. */
  buyers: TopBuyer[] | null;
}

/** Which quick filter matches the current URL window (drives the pill styling). */
type ActivePreset = '7d' | '30d' | 'custom' | 'all';

/**
 * Category analytics page (S5.3): per-item totals for the selected window plus a
 * top-5 buyers drilldown on demand.
 *
 * The **URL is the single source of truth for the period** (spec §4.1): `from`/`to`
 * arrive as query-param `input()`s (`withComponentInputBinding()`), the presets and
 * the custom inputs only *write* to the URL, and an `effect` reloads the item list
 * whenever the id or the window changes. That gives reload-and-share for free and
 * keeps list, ranking and (later) chart reading the same window by construction —
 * no three local states to keep in sync.
 *
 * Top-5 buyers are **never** fetched on load (a 30-item category would fire 30
 * calls for data nobody looked at, §4.2): the request goes out only when an item
 * is expanded, and its cache is dropped whenever the window changes because those
 * buyers belong to the old period. The series chart (S5.4) mounts under the same
 * expansion for the same reason, and is handed the URL-owned window so the whole
 * page always reads one period.
 */
@Component({
  selector: 'app-category-analytics-page',
  imports: [SalesSeriesChartComponent],
  templateUrl: './category-analytics-page.component.html',
  styleUrl: './category-analytics-page.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CategoryAnalyticsPageComponent {
  private readonly categoriesService = inject(CategoriesService);
  private readonly analytics = inject(AnalyticsService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  /** Route param — a string, per the URL (`:categoryId`). */
  readonly categoryId = input.required<string>();

  /** Period bounds as query params (`YYYY-MM-DD`), both optional. */
  readonly from = input<string>();
  readonly to = input<string>();

  private readonly categoryIdNumber = computed(() => Number(this.categoryId()));

  /** Resolved category, or `undefined` until the catalog list is loaded. */
  readonly category = computed(() =>
    this.categoriesService.byId().get(this.categoryIdNumber()),
  );

  /** The window read straight off the URL — the only source of truth (§4.1). */
  readonly period = computed<AnalyticsPeriod>(() => ({
    from: this.from() || undefined,
    to: this.to() || undefined,
  }));

  /** Which preset (if any) the current URL window corresponds to. */
  readonly activePreset = computed<ActivePreset>(() => {
    const from = this.from();
    const to = this.to();
    if (!from && !to) {
      return 'all';
    }
    const p7 = presetRange(7);
    if (from === p7.from && to === p7.to) {
      return '7d';
    }
    const p30 = presetRange(30);
    if (from === p30.from && to === p30.to) {
      return '30d';
    }
    return 'custom';
  });

  /**
   * Draft values for the custom-range inputs. `linkedSignal` reseeds them from
   * the URL whenever the window changes, but they stay writable so the user can
   * type a range before committing it with "Aplicar".
   */
  readonly customFrom = linkedSignal(() => this.from() ?? '');
  readonly customTo = linkedSignal(() => this.to() ?? '');

  // ---- item list state (Signals; no client-side aggregation) ----
  private readonly itemsReport = signal<CategoryItemsReport | null>(null);
  readonly itemsLoading = signal(false);
  readonly itemsError = signal(false);

  readonly items = computed(() => this.itemsReport()?.items ?? []);
  /** Category loaded but with no items at all (distinct from "still loading"). */
  readonly emptyCategory = computed(
    () => this.itemsReport() !== null && this.items().length === 0,
  );

  // ---- per-item drilldown state ----
  private readonly buyersState = signal<ReadonlyMap<string, BuyersState>>(
    new Map(),
  );
  private readonly expandedIds = signal<ReadonlySet<string>>(new Set());

  /**
   * Bumped on every list reload. In-flight responses (list or buyers) carry the
   * token they were issued under and drop themselves if the window changed
   * underneath them, so a slow reply for the old period can never overwrite the
   * new one.
   */
  private loadToken = 0;

  constructor() {
    // A shared/reloaded URL may hit this before the sidenav fetched the catalog.
    // Trigger the (cached) load so the title resolves; the service no-ops if it
    // is already loaded.
    if (!this.categoriesService.loaded()) {
      this.categoriesService.list().subscribe({ error: () => undefined });
    }

    // The URL owns the window: reload the list on any id/period change. Resetting
    // the drilldown here is what keeps a stale top-5 from surviving a new window.
    effect(() => {
      const categoryId = this.categoryIdNumber();
      const period = this.period();
      this.loadItems(categoryId, period);
    });
  }

  // ---------------------------------------------------------------- period

  applyPreset(days: number): void {
    const { from, to } = presetRange(days);
    this.writePeriod(from, to);
  }

  applyCustom(): void {
    this.writePeriod(
      this.customFrom().trim() || undefined,
      this.customTo().trim() || undefined,
    );
  }

  clearPeriod(): void {
    this.writePeriod(undefined, undefined);
  }

  /** Presets only ever write to the URL; the `effect` reacts to the change. */
  private writePeriod(from: string | undefined, to: string | undefined): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { from: from ?? null, to: to ?? null },
      queryParamsHandling: 'merge',
    });
  }

  // ---------------------------------------------------------------- list

  retry(): void {
    this.loadItems(this.categoryIdNumber(), this.period());
  }

  private loadItems(categoryId: number, period: AnalyticsPeriod): void {
    const token = ++this.loadToken;

    // The drilldown cache belongs to the old window; drop it on every reload.
    this.buyersState.set(new Map());
    this.expandedIds.set(new Set());

    if (Number.isNaN(categoryId)) {
      this.itemsReport.set(null);
      this.itemsLoading.set(false);
      this.itemsError.set(true);
      return;
    }

    this.itemsError.set(false);
    this.itemsLoading.set(true);

    this.analytics.categoryItems(categoryId, period).subscribe({
      next: (report) => {
        if (token !== this.loadToken) {
          return;
        }
        this.itemsReport.set(report);
        this.itemsLoading.set(false);
      },
      error: () => {
        if (token !== this.loadToken) {
          return;
        }
        this.itemsReport.set(null);
        this.itemsLoading.set(false);
        this.itemsError.set(true);
      },
    });
  }

  // ---------------------------------------------------------------- drilldown

  isExpanded(itemId: string): boolean {
    return this.expandedIds().has(itemId);
  }

  buyersFor(itemId: string): BuyersState | undefined {
    return this.buyersState().get(itemId);
  }

  toggle(itemId: string): void {
    const next = new Set(this.expandedIds());
    if (next.has(itemId)) {
      next.delete(itemId);
    } else {
      next.add(itemId);
      this.ensureBuyers(itemId);
    }
    this.expandedIds.set(next);
  }

  retryBuyers(itemId: string): void {
    this.loadBuyers(itemId);
  }

  /** Fetch the top-5 only the first time an item is opened for this window. */
  private ensureBuyers(itemId: string): void {
    const existing = this.buyersState().get(itemId);
    if (existing && (existing.loading || existing.buyers !== null)) {
      return;
    }
    this.loadBuyers(itemId);
  }

  private loadBuyers(itemId: string): void {
    const token = this.loadToken;
    this.patchBuyers(itemId, { loading: true, error: false, buyers: null });

    this.analytics.topBuyers(itemId, this.period(), 5).subscribe({
      next: (report) => {
        if (token !== this.loadToken) {
          return;
        }
        this.patchBuyers(itemId, {
          loading: false,
          error: false,
          buyers: report.buyers,
        });
      },
      error: () => {
        if (token !== this.loadToken) {
          return;
        }
        this.patchBuyers(itemId, { loading: false, error: true, buyers: null });
      },
    });
  }

  private patchBuyers(itemId: string, state: BuyersState): void {
    const next = new Map(this.buyersState());
    next.set(itemId, state);
    this.buyersState.set(next);
  }

  // ---------------------------------------------------------------- display

  /** Format BRL **from the string** the API returns (§2.5). */
  formatRevenue(revenue: string): string {
    return formatBRL(revenue);
  }
}
