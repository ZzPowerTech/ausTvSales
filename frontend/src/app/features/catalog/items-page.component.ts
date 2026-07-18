import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * Item management screen. The real form, filters and the reward-command helper
 * land in S4.3; this establishes the route so the shell (S4.1) is deployable.
 */
@Component({
  selector: 'app-items-page',
  imports: [],
  template: `
    <h1 class="page__title">Itens</h1>
    <p class="page__lead">
      O cadastro de itens e os filtros por categoria e status chegam na S4.3.
    </p>
  `,
  styleUrl: './catalog-page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ItemsPageComponent {}
