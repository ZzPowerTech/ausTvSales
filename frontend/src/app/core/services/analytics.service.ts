import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { environment } from '../../../environments/environment';
import {
  AnalyticsPeriod,
  CategoryItemsReport,
  SeriesBucket,
  SeriesReport,
  TopBuyersReport,
} from '../models/analytics.model';

/**
 * Read-side analytics API (spec S5.1 §2.1).
 *
 * Same shape as the catalog services — `inject(HttpClient)`, `apiBaseUrl`,
 * methods returning `Observable`. Unlike them, this holds **no cached Signal
 * state**: each report is scoped to an item/category + period and is short-lived,
 * so caching here would just be a stale window waiting to happen. The screens
 * (S5.3/S5.4) own the Signal state around the period they are showing.
 *
 * The period bounds are appended only when present: an omitted `from`/`to` must
 * fall off the query string entirely so the backend reads it as "whole history",
 * not as an empty-string bound.
 */
@Injectable({ providedIn: 'root' })
export class AnalyticsService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = environment.apiBaseUrl;

  categoryItems(
    categoryId: number,
    period: AnalyticsPeriod,
  ): Observable<CategoryItemsReport> {
    return this.http.get<CategoryItemsReport>(
      `${this.baseUrl}/analytics/categories/${categoryId}/items`,
      { params: this.periodParams(period) },
    );
  }

  topBuyers(
    itemId: string,
    period: AnalyticsPeriod,
    limit?: number,
  ): Observable<TopBuyersReport> {
    let params = this.periodParams(period);
    if (limit !== undefined) {
      params = params.set('limit', String(limit));
    }
    return this.http.get<TopBuyersReport>(
      `${this.baseUrl}/analytics/items/${encodeURIComponent(itemId)}/top-buyers`,
      { params },
    );
  }

  series(
    itemId: string,
    period: AnalyticsPeriod,
    bucket?: SeriesBucket,
  ): Observable<SeriesReport> {
    let params = this.periodParams(period);
    if (bucket !== undefined) {
      params = params.set('bucket', bucket);
    }
    return this.http.get<SeriesReport>(
      `${this.baseUrl}/analytics/items/${encodeURIComponent(itemId)}/series`,
      { params },
    );
  }

  /** Build the `from`/`to` query params, omitting any that is undefined. */
  private periodParams(period: AnalyticsPeriod): HttpParams {
    let params = new HttpParams();
    if (period.from !== undefined) {
      params = params.set('from', period.from);
    }
    if (period.to !== undefined) {
      params = params.set('to', period.to);
    }
    return params;
  }
}
