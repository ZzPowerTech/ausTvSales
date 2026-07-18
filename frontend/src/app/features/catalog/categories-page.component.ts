import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';

import { Category } from '../../core/models/category.model';
import { CategoriesService } from '../../core/services/categories.service';

/**
 * Category management (spec S4.2): create, rename and reorder the sidebar.
 *
 * There is deliberately **no delete or deactivate**: `categories` has no
 * `active` column and items reference it by foreign key, so removal is out of
 * scope for the MVP (decision of 2026-07-18).
 */
@Component({
  selector: 'app-categories-page',
  imports: [],
  templateUrl: './categories-page.component.html',
  styleUrl: './catalog-page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CategoriesPageComponent {
  private readonly service = inject(CategoriesService);

  readonly categories = this.service.categories;
  readonly loaded = this.service.loaded;

  /** Name typed into the create field. */
  readonly newName = signal('');
  /** Id of the row being renamed, or `null` when nothing is being edited. */
  readonly editingId = signal<number | null>(null);
  /** Draft name while renaming. */
  readonly editingName = signal('');

  /** Errors are shown next to the control that caused them, never as a toast. */
  readonly createError = signal<string | null>(null);
  readonly editError = signal<string | null>(null);
  readonly listError = signal<string | null>(null);
  readonly reorderError = signal<string | null>(null);

  /** Blocks double-submits while a write is in flight. */
  readonly busy = signal(false);

  readonly canCreate = computed(
    () => this.newName().trim().length > 0 && !this.busy(),
  );

  constructor() {
    this.load();
  }

  load(): void {
    this.listError.set(null);
    this.service.list().subscribe({
      error: () =>
        this.listError.set(
          'Não foi possível carregar as categorias. Verifique a conexão e tente de novo.',
        ),
    });
  }

  create(): void {
    const name = this.newName().trim();
    if (!name || this.busy()) {
      return;
    }
    this.busy.set(true);
    this.createError.set(null);

    this.service.create({ name }).subscribe({
      next: () => {
        this.newName.set('');
        this.busy.set(false);
      },
      error: (error: unknown) => {
        this.createError.set(this.messageFor(error, name));
        this.busy.set(false);
      },
    });
  }

  startEditing(category: Category): void {
    this.editingId.set(category.id);
    this.editingName.set(category.name);
    this.editError.set(null);
  }

  cancelEditing(): void {
    this.editingId.set(null);
    this.editError.set(null);
  }

  saveEditing(): void {
    const id = this.editingId();
    const name = this.editingName().trim();
    if (id === null || !name || this.busy()) {
      return;
    }
    this.busy.set(true);
    this.editError.set(null);

    this.service.update(id, { name }).subscribe({
      next: () => {
        this.editingId.set(null);
        this.busy.set(false);
      },
      error: (error: unknown) => {
        this.editError.set(this.messageFor(error, name));
        this.busy.set(false);
      },
    });
  }

  /**
   * Move one row up or down. The whole id set is sent, because the endpoint
   * rejects a partial one by design — that is what keeps a stale second tab
   * from writing an order with holes in it.
   */
  move(index: number, direction: -1 | 1): void {
    const current = this.categories();
    const target = index + direction;
    if (target < 0 || target >= current.length || this.busy()) {
      return;
    }

    const ids = current.map((c) => c.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];

    this.busy.set(true);
    this.reorderError.set(null);
    this.service.reorder(ids).subscribe({
      next: () => this.busy.set(false),
      error: () => {
        // The service already rolled the list back to its previous order.
        this.reorderError.set(
          'Não foi possível salvar a nova ordem. A lista voltou ao estado anterior.',
        );
        this.busy.set(false);
      },
    });
  }

  /**
   * Turn an API failure into something an admin can act on. The 409 case is the
   * one that matters day to day: it is the typo guard becoming visible.
   */
  private messageFor(error: unknown, name: string): string {
    if (error instanceof HttpErrorResponse) {
      if (error.status === 409) {
        return `Já existe uma categoria chamada "${name}".`;
      }
      if (error.status === 400) {
        return 'Nome inválido. Use um nome não vazio.';
      }
    }
    return 'Não foi possível salvar. Tente de novo.';
  }
}
