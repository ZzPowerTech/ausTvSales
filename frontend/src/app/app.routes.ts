import { Routes } from '@angular/router';

import { authGuard } from './core/guards/auth.guard';

export const routes: Routes = [
  {
    path: 'login',
    loadComponent: () =>
      import('./features/login/login.component').then((m) => m.LoginComponent),
  },
  {
    // The guard sits on the parent, so every screen inside the shell inherits
    // it — deny-by-default survives someone adding a child route and forgetting.
    path: '',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/dashboard/dashboard-layout.component').then(
        (m) => m.DashboardLayoutComponent,
      ),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'catalog/categories' },
      {
        path: 'catalog/categories',
        loadComponent: () =>
          import('./features/catalog/categories-page.component').then(
            (m) => m.CategoriesPageComponent,
          ),
      },
      {
        path: 'catalog/items',
        loadComponent: () =>
          import('./features/catalog/items-page.component').then(
            (m) => m.ItemsPageComponent,
          ),
      },
      {
        // Sales analysis by category (S5.2). Nested here so it inherits the
        // parent's authGuard; S5.3/S5.4 fill the shell in.
        path: 'sales/categories/:categoryId',
        loadComponent: () =>
          import(
            './features/analytics/category-analytics-page.component'
          ).then((m) => m.CategoryAnalyticsPageComponent),
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
