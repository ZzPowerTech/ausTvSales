import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Observable, map, switchMap, tap } from 'rxjs';

import {
  CreateItemPayload,
  Item,
  UpdateItemPayload,
} from '../models/item.model';
import { environment } from '../../../environments/environment';

/**
 * Item catalog state (spec S4.3), held in Signals.
 *
 * `GET /items` returns the whole catalog ordered by `itemId`, and filtering by
 * category/status happens client-side over this signal. That is a deliberate
 * MVP call: the catalog has dozens of items, not thousands, so server-side
 * pagination would be complexity without demand.
 *
 * As with categories, the **server owns the ordering**: mutations re-read the
 * list rather than splicing their response into local state.
 */
@Injectable({ providedIn: 'root' })
export class ItemsService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = environment.apiBaseUrl;

  private readonly itemsSignal = signal<Item[]>([]);
  private readonly loadedSignal = signal(false);

  readonly items = this.itemsSignal.asReadonly();

  /** True only once the full list has been fetched — never set by a mutation. */
  readonly loaded = this.loadedSignal.asReadonly();

  list(): Observable<Item[]> {
    return this.http.get<Item[]>(`${this.baseUrl}/items`).pipe(
      tap((items) => {
        this.itemsSignal.set(items);
        this.loadedSignal.set(true);
      }),
    );
  }

  create(payload: CreateItemPayload): Observable<Item> {
    return this.http
      .post<Item>(`${this.baseUrl}/items`, payload)
      .pipe(switchMap((created) => this.refreshReturning(created)));
  }

  /** `item_id` is intentionally not updatable — the backend rejects it too. */
  update(id: number, payload: UpdateItemPayload): Observable<Item> {
    return this.http
      .patch<Item>(`${this.baseUrl}/items/${id}`, payload)
      .pipe(switchMap((updated) => this.refreshReturning(updated)));
  }

  /** Re-read the list after a mutation, still handing the caller its entity. */
  private refreshReturning<T>(entity: T): Observable<T> {
    return this.list().pipe(map(() => entity));
  }
}
