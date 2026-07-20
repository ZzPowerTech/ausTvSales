import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

import { AuthService } from '../../core/services/auth.service';
import { CategoriesService } from '../../core/services/categories.service';

/**
 * Authenticated shell: topbar, side navigation and the routed screen.
 *
 * The side nav holds two sections: the static "Catálogo" admin links, and the
 * dynamic "Vendas" section (S5.2) whose entries are the catalog categories.
 * Those come straight from the shared `CategoriesService` Signal — the same
 * cached list the management screen uses, already ordered by `display_order` on
 * the server. There is deliberately no second source of truth and no
 * client-side sort here: duplicating that rule is how it starts to diverge.
 */
@Component({
  selector: 'app-dashboard-layout',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './dashboard-layout.component.html',
  styleUrl: './dashboard-layout.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DashboardLayoutComponent {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly categoriesService = inject(CategoriesService);

  readonly user = this.auth.user;

  /** Categories driving the "Vendas" section — server-ordered, not re-sorted. */
  readonly categories = this.categoriesService.categories;
  /** Gate empty/loaded states on this, never on the array being empty. */
  readonly categoriesLoaded = this.categoriesService.loaded;

  constructor() {
    // Populate the nav on first entry. Guarded so re-mounting the shell (or a
    // screen having already fetched) does not fire a redundant request.
    if (!this.categoriesService.loaded()) {
      this.categoriesService.list().subscribe({ error: () => undefined });
    }
  }

  logout(): void {
    this.auth.logout().subscribe(() => {
      void this.router.navigate(['/login']);
    });
  }
}
