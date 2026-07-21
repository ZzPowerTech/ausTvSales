import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { WritableSignal, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';

import { environment } from '../../../environments/environment';
import {
  CategoryItemTotals,
  TopBuyer,
} from '../../core/models/analytics.model';
import { Category } from '../../core/models/category.model';
import { CategoriesService } from '../../core/services/categories.service';
import { CategoryAnalyticsPageComponent } from './category-analytics-page.component';

const base = environment.apiBaseUrl;
const CAIXAS: Category = { id: 1, name: 'Caixas', displayOrder: 0 };

const NATAL: CategoryItemTotals = {
  itemId: 'caixaNatal2026',
  displayName: 'Caixa de Natal',
  active: true,
  salesCount: 4,
  totalQty: 10,
  revenue: '1440.00',
};
const GOLD: CategoryItemTotals = {
  itemId: 'caixaGold',
  displayName: 'Caixa Gold',
  active: false,
  salesCount: 1,
  totalQty: 1,
  // 0.1 + 0.2 territory — proves the format runs off the string, not a float sum.
  revenue: '0.30',
};

const BUYER: TopBuyer = {
  playerUuid: 'uuid-1',
  nickname: 'Pikeno',
  salesCount: 3,
  totalQty: 7,
  revenue: '1008.00',
};

describe('CategoryAnalyticsPageComponent', () => {
  let fixture: ComponentFixture<CategoryAnalyticsPageComponent>;
  let component: CategoryAnalyticsPageComponent;
  let controller: HttpTestingController;
  let router: jasmine.SpyObj<Router>;
  let loadedSignal: WritableSignal<boolean>;
  let byIdSignal: WritableSignal<Map<number, Category>>;
  let list: jasmine.Spy;

  const itemsUrl = (id: number): string =>
    `${base}/analytics/categories/${id}/items`;
  const topBuyersUrl = (itemId: string): string =>
    `${base}/analytics/items/${itemId}/top-buyers`;
  const seriesUrl = (itemId: string): string =>
    `${base}/analytics/items/${itemId}/series`;

  /**
   * Answer the series request(s) the embedded chart (S5.4) fires on expand.
   *
   * The chart mounts with the item's detail panel, so every expand issues one
   * `series` call. Collapsing destroys the chart, so re-expanding issues another
   * — unlike the top-5, which is cached by the page. Tests that expand must
   * drain these or `controller.verify()` fails on the open request.
   */
  const flushSeries = (itemId: string, times = 1): void => {
    const requests = controller.match((r) => r.url === seriesUrl(itemId));
    expect(requests.length).toBe(times);
    for (const req of requests) {
      // Collapsing tears the chart down, which unsubscribes and cancels its
      // in-flight request. Matching it clears it from the outstanding list;
      // flushing a cancelled request would throw.
      if (!req.cancelled) {
        req.flush({
          itemId,
          bucket: 'day',
          points: [],
          excludedHistorical: { qty: 0, revenue: '0.00' },
        });
      }
    }
    fixture.detectChanges();
  };

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;

  /** Boot the page and answer the initial category-items request. */
  const boot = (
    items: CategoryItemTotals[],
    opts: { categoryId?: string; from?: string; to?: string } = {},
  ): void => {
    const categoryId = opts.categoryId ?? '1';
    fixture = TestBed.createComponent(CategoryAnalyticsPageComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('categoryId', categoryId);
    if (opts.from !== undefined) {
      fixture.componentRef.setInput('from', opts.from);
    }
    if (opts.to !== undefined) {
      fixture.componentRef.setInput('to', opts.to);
    }
    fixture.detectChanges();

    const req = controller.expectOne((r) => r.url === itemsUrl(+categoryId));
    req.flush({ categoryId: +categoryId, items });
    fixture.detectChanges();
  };

  beforeEach(() => {
    loadedSignal = signal(true);
    byIdSignal = signal(new Map<number, Category>([[1, CAIXAS]]));
    list = jasmine.createSpy('list');
    router = jasmine.createSpyObj<Router>('Router', ['navigate']);
    router.navigate.and.resolveTo(true);

    TestBed.configureTestingModule({
      imports: [CategoryAnalyticsPageComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: Router, useValue: router },
        { provide: ActivatedRoute, useValue: {} },
        {
          provide: CategoriesService,
          useValue: {
            byId: byIdSignal.asReadonly(),
            loaded: loadedSignal.asReadonly(),
            list,
          },
        },
      ],
    });
    controller = TestBed.inject(HttpTestingController);
  });

  afterEach(() => controller.verify());

  it('resolves the category name from the catalog cache', () => {
    boot([NATAL]);
    expect(el().textContent).toContain('Caixas');
  });

  it('applies a 7-day preset by writing from/to to the URL', () => {
    boot([]);
    component.applyPreset(7);

    const day = 24 * 60 * 60 * 1000;
    const nowSp = Date.now() - 3 * 60 * 60 * 1000; // fixed -03:00 São Paulo offset
    const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

    const [commands, extras] = router.navigate.calls.mostRecent().args;
    expect(commands).toEqual([]);
    expect((extras?.queryParams as Record<string, string>)['from']).toBe(
      iso(nowSp - 6 * day),
    );
    expect((extras?.queryParams as Record<string, string>)['to']).toBe(
      iso(nowSp),
    );
  });

  it('sends the URL window as query params to the items endpoint', () => {
    fixture = TestBed.createComponent(CategoryAnalyticsPageComponent);
    fixture.componentRef.setInput('categoryId', '1');
    fixture.componentRef.setInput('from', '2026-01-01');
    fixture.componentRef.setInput('to', '2026-01-31');
    fixture.detectChanges();

    const req = controller.expectOne((r) => r.url === itemsUrl(1));
    expect(req.request.params.get('from')).toBe('2026-01-01');
    expect(req.request.params.get('to')).toBe('2026-01-31');
    req.flush({ categoryId: 1, items: [] });
  });

  it('marks an inactive item as distinct and keeps it visible', () => {
    boot([GOLD]);
    const row = el().querySelector('.item');
    expect(row?.classList).toContain('item--inactive');
    expect(row?.textContent).toContain('Inativo');
    expect(row?.textContent).toContain('Caixa Gold');
  });

  it('formats revenue as BRL from the API string', () => {
    boot([NATAL, GOLD]);
    const expected = new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    });
    expect(el().textContent).toContain(expected.format(1440));
    expect(el().textContent).toContain(expected.format(0.3));
  });

  it('does not request top buyers on load, only when an item is expanded', () => {
    boot([NATAL]);
    // Nothing expanded yet: no drilldown request must have gone out.
    controller.expectNone((r) => r.url === topBuyersUrl(NATAL.itemId));

    component.toggle(NATAL.itemId);
    fixture.detectChanges();

    const req = controller.expectOne((r) => r.url === topBuyersUrl(NATAL.itemId));
    expect(req.request.params.get('limit')).toBe('5');
    req.flush({ itemId: NATAL.itemId, buyers: [BUYER] });
    fixture.detectChanges();
    flushSeries(NATAL.itemId);

    expect(el().textContent).toContain('Pikeno');
  });

  it('does not refetch top buyers on a second expand of the same item', () => {
    boot([NATAL]);

    component.toggle(NATAL.itemId);
    fixture.detectChanges();
    controller
      .expectOne((r) => r.url === topBuyersUrl(NATAL.itemId))
      .flush({ itemId: NATAL.itemId, buyers: [BUYER] });
    fixture.detectChanges();

    component.toggle(NATAL.itemId); // collapse
    fixture.detectChanges();
    component.toggle(NATAL.itemId); // expand again — cached, no new request
    fixture.detectChanges();

    controller.expectNone((r) => r.url === topBuyersUrl(NATAL.itemId));
    // Two series calls: the chart is destroyed on collapse and refetches when it
    // mounts again. Only the top-5 is page-cached.
    flushSeries(NATAL.itemId, 2);
    // Cached data is still what renders, proving no refetch was needed.
    expect(el().textContent).toContain('Pikeno');
  });

  it('shows the empty-category state when there are no items', () => {
    boot([]);
    expect(el().textContent).toContain('Sem vendas no período');
  });

  it('mounts the series chart inside the expanded item, on the URL window (S5.4)', () => {
    boot([NATAL], { from: '2026-03-01', to: '2026-03-31' });

    // Nothing expanded: no chart in the DOM and no series request.
    expect(el().querySelector('app-sales-series-chart')).toBeNull();
    controller.expectNone((r) => r.url === seriesUrl(NATAL.itemId));

    component.toggle(NATAL.itemId);
    fixture.detectChanges();
    controller
      .expectOne((r) => r.url === topBuyersUrl(NATAL.itemId))
      .flush({ itemId: NATAL.itemId, buyers: [BUYER] });
    fixture.detectChanges();

    // The chart inherits the page's window, so the whole screen reads one period.
    const series = controller.expectOne((r) => r.url === seriesUrl(NATAL.itemId));
    expect(series.request.params.get('from')).toBe('2026-03-01');
    expect(series.request.params.get('to')).toBe('2026-03-31');
    series.flush({
      itemId: NATAL.itemId,
      bucket: 'day',
      points: [{ at: '2026-03-10', qty: 2, revenue: '100.00' }],
      excludedHistorical: { qty: 300, revenue: '36000.00' },
    });
    fixture.detectChanges();

    expect(el().querySelector('app-sales-series-chart')).not.toBeNull();
    // The CA7 baseline is rendered as text, never as a dated point.
    expect(el().textContent).toContain('Histórico pré-migração');
  });
});
