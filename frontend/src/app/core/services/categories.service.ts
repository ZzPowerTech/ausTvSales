import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';

import { environment } from '../../../environments/environment';
import {
  Category,
  CreateCategoryPayload,
  UpdateCategoryPayload,
} from '../models/category.model';

/**
 * Category catalog state (spec S4.2), held in Signals.
 *
 * The list is cached in a signal so the item screen can resolve category names
 * without refetching. Every mutation refreshes the local list from the API
 * response rather than patching it by hand — the server owns the ordering rule
 * (`display_order`, then name), and reimplementing it here would be a second
 * source of truth waiting to drift.
 */
@Injectable({ providedIn: 'root' })
export class CategoriesService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = environment.apiBaseUrl;

  private readonly categoriesSignal = signal<Category[]>([]);
  private readonly loadedSignal = signal(false);

  readonly categories = this.categoriesSignal.asReadonly();
  readonly loaded = this.loadedSignal.asReadonly();

  /** Lookup by id, for showing a category name next to an item. */
  readonly byId = computed(
    () => new Map(this.categoriesSignal().map((c) => [c.id, c])),
  );

  list(): Observable<Category[]> {
    return this.http
      .get<Category[]>(`${this.baseUrl}/categories`)
      .pipe(tap((categories) => this.replace(categories)));
  }

  create(payload: CreateCategoryPayload): Observable<Category> {
    return this.http
      .post<Category>(`${this.baseUrl}/categories`, payload)
      .pipe(tap((created) => this.replace([...this.categoriesSignal(), created])));
  }

  update(id: number, payload: UpdateCategoryPayload): Observable<Category> {
    return this.http
      .patch<Category>(`${this.baseUrl}/categories/${id}`, payload)
      .pipe(
        tap((updated) =>
          this.replace(
            this.categoriesSignal().map((c) => (c.id === updated.id ? updated : c)),
          ),
        ),
      );
  }

  /**
   * Atomic reorder (backend S4.0). Sends the **complete** set of ids in the
   * desired order; a partial set is rejected with 400 by design, which is what
   * protects a stale tab from writing an order with holes in it.
   */
  reorder(orderedIds: number[]): Observable<Category[]> {
    return this.http
      .patch<Category[]>(`${this.baseUrl}/categories/reorder`, {
        order: orderedIds,
      })
      .pipe(tap((categories) => this.replace(categories)));
  }

  /** Overwrite local state, keeping the server's ordering rule. */
  private replace(categories: Category[]): void {
    this.categoriesSignal.set(
      [...categories].sort(
        (a, b) => a.displayOrder - b.displayOrder || a.name.localeCompare(b.name),
      ),
    );
    this.loadedSignal.set(true);
  }
}
