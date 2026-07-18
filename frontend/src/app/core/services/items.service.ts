import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';

import { environment } from '../../../environments/environment';
import {
  CreateItemPayload,
  Item,
  UpdateItemPayload,
} from '../models/item.model';

/**
 * Item catalog state (spec S4.3), held in Signals.
 *
 * `GET /items` returns the whole catalog ordered by `itemId`, and filtering by
 * category/status happens client-side over this signal. That is a deliberate
 * MVP call: the catalog has dozens of items, not thousands, so server-side
 * pagination would be complexity without demand.
 */
@Injectable({ providedIn: 'root' })
export class ItemsService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = environment.apiBaseUrl;

  private readonly itemsSignal = signal<Item[]>([]);
  private readonly loadedSignal = signal(false);

  readonly items = this.itemsSignal.asReadonly();
  readonly loaded = this.loadedSignal.asReadonly();

  list(): Observable<Item[]> {
    return this.http
      .get<Item[]>(`${this.baseUrl}/items`)
      .pipe(tap((items) => this.replace(items)));
  }

  create(payload: CreateItemPayload): Observable<Item> {
    return this.http
      .post<Item>(`${this.baseUrl}/items`, payload)
      .pipe(tap((created) => this.replace([...this.itemsSignal(), created])));
  }

  /** `item_id` is intentionally not updatable — the backend rejects it too. */
  update(id: number, payload: UpdateItemPayload): Observable<Item> {
    return this.http
      .patch<Item>(`${this.baseUrl}/items/${id}`, payload)
      .pipe(
        tap((updated) =>
          this.replace(
            this.itemsSignal().map((i) => (i.id === updated.id ? updated : i)),
          ),
        ),
      );
  }

  /** Overwrite local state, keeping the server's `itemId` ordering. */
  private replace(items: Item[]): void {
    this.itemsSignal.set(
      [...items].sort((a, b) => a.itemId.localeCompare(b.itemId)),
    );
    this.loadedSignal.set(true);
  }
}
