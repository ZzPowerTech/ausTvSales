import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, map, switchMap, tap } from 'rxjs';

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
 * without refetching. The **server owns the ordering rule** (`display_order`,
 * then name): mutations re-read the list instead of splicing the response into
 * local state, so there is no client-side copy of that rule to drift. The
 * catalog is dozens of rows, so the extra GET is cheap next to the class of bug
 * it removes.
 */
@Injectable({ providedIn: 'root' })
export class CategoriesService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = environment.apiBaseUrl;

  private readonly categoriesSignal = signal<Category[]>([]);
  private readonly loadedSignal = signal(false);

  readonly categories = this.categoriesSignal.asReadonly();

  /**
   * True only once the **full list** has been fetched. Mutations never set it:
   * a screen gating its empty state on this must not be told "loaded" while
   * holding a single row that happened to come back from a create.
   */
  readonly loaded = this.loadedSignal.asReadonly();

  /** Lookup by id, for showing a category name next to an item. */
  readonly byId = computed(
    () => new Map(this.categoriesSignal().map((c) => [c.id, c])),
  );

  list(): Observable<Category[]> {
    return this.http.get<Category[]>(`${this.baseUrl}/categories`).pipe(
      tap((categories) => {
        this.categoriesSignal.set(categories);
        this.loadedSignal.set(true);
      }),
    );
  }

  create(payload: CreateCategoryPayload): Observable<Category> {
    return this.http
      .post<Category>(`${this.baseUrl}/categories`, payload)
      .pipe(switchMap((created) => this.refreshReturning(created)));
  }

  update(id: number, payload: UpdateCategoryPayload): Observable<Category> {
    return this.http
      .patch<Category>(`${this.baseUrl}/categories/${id}`, payload)
      .pipe(switchMap((updated) => this.refreshReturning(updated)));
  }

  /**
   * Atomic reorder (backend S4.0). Sends the **complete** set of ids in the
   * desired order; a partial set is rejected with 400 by design, which is what
   * protects a stale tab from writing an order with holes in it.
   *
   * The response is already the full reordered list, so this needs no refetch.
   */
  reorder(orderedIds: number[]): Observable<Category[]> {
    return this.http
      .patch<Category[]>(`${this.baseUrl}/categories/reorder`, {
        order: orderedIds,
      })
      .pipe(tap((categories) => this.categoriesSignal.set(categories)));
  }

  /** Re-read the list after a mutation, still handing the caller its entity. */
  private refreshReturning<T>(entity: T): Observable<T> {
    return this.list().pipe(map(() => entity));
  }
}
