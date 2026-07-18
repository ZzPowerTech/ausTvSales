import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * Category management screen. The real table, form and reordering land in S4.2;
 * this establishes the route so the shell (S4.1) is deployable on its own.
 */
@Component({
  selector: 'app-categories-page',
  imports: [],
  template: `
    <p class="u-label page__eyebrow">Catálogo</p>
    <h1 class="page__title">Categorias</h1>
    <p class="page__lead">
      A gestão de categorias (criar, renomear e reordenar) chega na S4.2.
    </p>
  `,
  styleUrl: './catalog-page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CategoriesPageComponent {}
