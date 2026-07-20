import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { environment } from '../../../environments/environment';
import {
  CategoryItemsReport,
  SeriesReport,
  TopBuyersReport,
} from '../models/analytics.model';
import { AnalyticsService } from './analytics.service';

const base = environment.apiBaseUrl;

describe('AnalyticsService', () => {
  let service: AnalyticsService;
  let controller: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(AnalyticsService);
    controller = TestBed.inject(HttpTestingController);
  });

  afterEach(() => controller.verify());

  it('requests category items with both period bounds', () => {
    const report: CategoryItemsReport = { categoryId: 3, items: [] };
    service
      .categoryItems(3, { from: '2026-01-01', to: '2026-07-20' })
      .subscribe();

    const req = controller.expectOne(
      `${base}/analytics/categories/3/items?from=2026-01-01&to=2026-07-20`,
    );
    expect(req.request.method).toBe('GET');
    req.flush(report);
  });

  it('omits period params that are undefined', () => {
    service.categoryItems(3, {}).subscribe();

    // No `?from=&to=` empty bounds — an omitted period means "whole history".
    const req = controller.expectOne(`${base}/analytics/categories/3/items`);
    expect(req.request.params.has('from')).toBeFalse();
    expect(req.request.params.has('to')).toBeFalse();
    req.flush({ categoryId: 3, items: [] });
  });

  it('encodes the opaque item id in the top-buyers path and passes the limit', () => {
    const report: TopBuyersReport = { itemId: 'caixa/natal 2026', buyers: [] };
    service
      .topBuyers('caixa/natal 2026', { from: '2026-01-01' }, 5)
      .subscribe();

    const req = controller.expectOne(
      (r) =>
        r.url ===
        `${base}/analytics/items/${encodeURIComponent(
          'caixa/natal 2026',
        )}/top-buyers`,
    );
    expect(req.request.params.get('from')).toBe('2026-01-01');
    expect(req.request.params.has('to')).toBeFalse();
    expect(req.request.params.get('limit')).toBe('5');
    req.flush(report);
  });

  it('omits the limit when not provided', () => {
    service.topBuyers('caixaNatal2026', {}).subscribe();

    const req = controller.expectOne(
      `${base}/analytics/items/caixaNatal2026/top-buyers`,
    );
    expect(req.request.params.has('limit')).toBeFalse();
    req.flush({ itemId: 'caixaNatal2026', buyers: [] });
  });

  it('requests the series with the given bucket', () => {
    const report: SeriesReport = {
      itemId: 'caixaNatal2026',
      bucket: 'week',
      points: [],
      excludedHistorical: { qty: 0, revenue: '0.00' },
    };
    service
      .series('caixaNatal2026', { to: '2026-07-20' }, 'week')
      .subscribe();

    const req = controller.expectOne(
      `${base}/analytics/items/caixaNatal2026/series?to=2026-07-20&bucket=week`,
    );
    expect(req.request.method).toBe('GET');
    req.flush(report);
  });

  it('omits the bucket when not provided', () => {
    service.series('caixaNatal2026', {}).subscribe();

    const req = controller.expectOne(
      `${base}/analytics/items/caixaNatal2026/series`,
    );
    expect(req.request.params.has('bucket')).toBeFalse();
    req.flush({
      itemId: 'caixaNatal2026',
      bucket: 'day',
      points: [],
      excludedHistorical: { qty: 0, revenue: '0.00' },
    });
  });
});
