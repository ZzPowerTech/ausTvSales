import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { forkJoin } from 'rxjs';

import { ITEM_ID_PATTERN, Item } from '../../core/models/item.model';
import { CategoriesService } from '../../core/services/categories.service';
import { ItemsService } from '../../core/services/items.service';

/** Status filter over the catalog. */
type StatusFilter = 'all' | 'active' | 'inactive';

/**
 * Item management (spec S4.3): register an item minutes before a crate drops,
 * without touching SQL.
 *
 * `item_id` is the opaque business key and is **immutable after creation** —
 * historical sales reference it by foreign key, so the edit form locks it
 * rather than hiding it, making the constraint visible instead of surprising.
 */
@Component({
  selector: 'app-items-page',
  imports: [],
  templateUrl: './items-page.component.html',
  styleUrl: './catalog-page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ItemsPageComponent {
  private readonly items = inject(ItemsService);
  private readonly categories = inject(CategoriesService);

  readonly allItems = this.items.items;
  readonly loaded = this.items.loaded;
  readonly categoryList = this.categories.categories;
  readonly categoriesById = this.categories.byId;

  // --- create form -------------------------------------------------------
  readonly newItemId = signal('');
  readonly newDisplayName = signal('');
  readonly newCategoryId = signal<number | null>(null);

  // --- filters -----------------------------------------------------------
  readonly filterCategoryId = signal<number | null>(null);
  readonly filterStatus = signal<StatusFilter>('all');

  // --- editing -----------------------------------------------------------
  readonly editingId = signal<number | null>(null);
  readonly editingName = signal('');
  readonly editingCategoryId = signal<number | null>(null);

  /** Item awaiting deactivation confirmation, if any. */
  readonly pendingDeactivation = signal<Item | null>(null);

  /** Last created item — drives the reward-command helper. */
  readonly justCreated = signal<Item | null>(null);
  readonly commandCopied = signal(false);

  readonly createError = signal<string | null>(null);
  readonly editError = signal<string | null>(null);
  readonly listError = signal<string | null>(null);
  readonly busy = signal(false);

  /**
   * Client-side mirror of the backend regex. The server stays the authority;
   * this only spares the admin a round-trip on an obvious typo.
   */
  readonly itemIdValid = computed(() =>
    ITEM_ID_PATTERN.test(this.newItemId().trim()),
  );

  readonly canCreate = computed(
    () =>
      this.itemIdValid() &&
      this.newDisplayName().trim().length > 0 &&
      this.newCategoryId() !== null &&
      !this.busy(),
  );

  /** Filtering is client-side: the catalog is dozens of rows, not thousands. */
  readonly visibleItems = computed(() => {
    const categoryId = this.filterCategoryId();
    const status = this.filterStatus();
    return this.allItems().filter((item) => {
      const matchesCategory =
        categoryId === null || item.categoryId === categoryId;
      const matchesStatus =
        status === 'all' || (status === 'active' ? item.active : !item.active);
      return matchesCategory && matchesStatus;
    });
  });

  /**
   * The reward line to paste into the Genesis crate config, with the real
   * `item_id` already filled in. Typing it by hand is where the mistake happens
   * today, and the cost of that mistake is a rejected sale in production.
   * Format from `plugin.yml`:
   * `/<command> add <player_nick> <item_id> <total_price> <qtd>`.
   */
  readonly rewardCommand = computed(() => {
    const item = this.justCreated();
    return item ? `austv-sales add %player% ${item.itemId} %price% 1` : '';
  });

  constructor() {
    this.load();
  }

  load(): void {
    this.listError.set(null);
    // Categories are needed to name and filter items, so both must land.
    forkJoin([this.items.list(), this.categories.list()]).subscribe({
      error: () =>
        this.listError.set(
          'Não foi possível carregar o catálogo. Verifique a conexão e tente de novo.',
        ),
    });
  }

  create(): void {
    const itemId = this.newItemId().trim();
    const displayName = this.newDisplayName().trim();
    const categoryId = this.newCategoryId();
    if (!this.canCreate() || categoryId === null) {
      return;
    }
    this.busy.set(true);
    this.createError.set(null);

    this.items
      .create({
        item_id: itemId,
        display_name: displayName,
        category_id: categoryId,
      })
      .subscribe({
        next: (created) => {
          this.justCreated.set(created);
          this.commandCopied.set(false);
          this.newItemId.set('');
          this.newDisplayName.set('');
          this.newCategoryId.set(null);
          this.busy.set(false);
        },
        error: (error: unknown) => {
          this.createError.set(this.messageFor(error, itemId));
          this.busy.set(false);
        },
      });
  }

  startEditing(item: Item): void {
    this.editingId.set(item.id);
    this.editingName.set(item.displayName);
    this.editingCategoryId.set(item.categoryId);
    this.editError.set(null);
  }

  cancelEditing(): void {
    this.editingId.set(null);
    this.editError.set(null);
  }

  saveEditing(): void {
    const id = this.editingId();
    const displayName = this.editingName().trim();
    const categoryId = this.editingCategoryId();
    if (id === null || !displayName || categoryId === null || this.busy()) {
      return;
    }
    this.busy.set(true);
    this.editError.set(null);

    // `item_id` is deliberately absent: the backend's UpdateItemDto rejects it.
    this.items
      .update(id, { display_name: displayName, category_id: categoryId })
      .subscribe({
        next: () => {
          this.editingId.set(null);
          this.busy.set(false);
        },
        error: (error: unknown) => {
          this.editError.set(this.messageFor(error, displayName));
          this.busy.set(false);
        },
      });
  }

  /** Deactivation is destructive to future sales, so it always confirms. */
  askToDeactivate(item: Item): void {
    this.pendingDeactivation.set(item);
  }

  cancelDeactivation(): void {
    this.pendingDeactivation.set(null);
  }

  confirmDeactivation(): void {
    const item = this.pendingDeactivation();
    if (!item || this.busy()) {
      return;
    }
    this.setActive(item, false);
    this.pendingDeactivation.set(null);
  }

  /** Re-activating needs no confirmation: it only widens what is accepted. */
  activate(item: Item): void {
    this.setActive(item, true);
  }

  private setActive(item: Item, active: boolean): void {
    this.busy.set(true);
    this.items.update(item.id, { active }).subscribe({
      next: () => this.busy.set(false),
      error: () => {
        this.listError.set(
          `Não foi possível ${active ? 'ativar' : 'desativar'} "${item.displayName}". Tente de novo.`,
        );
        this.busy.set(false);
      },
    });
  }

  categoryName(categoryId: number): string {
    return this.categoriesById().get(categoryId)?.name ?? '—';
  }

  async copyCommand(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.rewardCommand());
      this.commandCopied.set(true);
    } catch {
      // Clipboard can be blocked (permissions, insecure origin). The command
      // stays selectable on screen, so this is a degraded path, not a failure.
      this.commandCopied.set(false);
    }
  }

  dismissCreated(): void {
    this.justCreated.set(null);
  }

  private messageFor(error: unknown, subject: string): string {
    if (error instanceof HttpErrorResponse) {
      if (error.status === 409) {
        return `Já existe um item com o identificador "${subject}".`;
      }
      if (error.status === 422) {
        return 'A categoria selecionada não existe mais. Recarregue e tente de novo.';
      }
      if (error.status === 400) {
        return 'Dados inválidos. Confira os campos e tente de novo.';
      }
    }
    return 'Não foi possível salvar. Tente de novo.';
  }
}
