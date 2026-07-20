import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
} from '@angular/core';

import { CategoriesService } from '../../core/services/categories.service';

/**
 * Category analytics shell (S5.2).
 *
 * This exists only so the `/sales/categories/:categoryId` route resolves — the
 * item list, top-5 ranking and time-series chart land in S5.3/S5.4. It reads the
 * route param as an `input()` (the app uses `withComponentInputBinding()`) and
 * resolves the category name off the `CategoriesService` cache the sidenav
 * already populated, so a direct hit on the URL still shows the right title
 * instead of a bare id.
 */
@Component({
  selector: 'app-category-analytics-page',
  imports: [],
  templateUrl: './category-analytics-page.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CategoryAnalyticsPageComponent {
  private readonly categoriesService = inject(CategoriesService);

  /** Route param — a string, per the URL (`:categoryId`). */
  readonly categoryId = input.required<string>();

  private readonly categoryIdNumber = computed(() => Number(this.categoryId()));

  /** Resolved category, or `undefined` until the catalog list is loaded. */
  readonly category = computed(() =>
    this.categoriesService.byId().get(this.categoryIdNumber()),
  );

  constructor() {
    // Someone landing here from a shared/reloaded URL may hit this before the
    // sidenav has fetched the catalog. Trigger the (cached) load so the title
    // can resolve; the service no-ops the state if it is already loaded.
    if (!this.categoriesService.loaded()) {
      this.categoriesService.list().subscribe({ error: () => undefined });
    }
  }
}
