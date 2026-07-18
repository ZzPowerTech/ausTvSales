import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { environment } from '../../../environments/environment';
import { Category } from '../../core/models/category.model';
import { Item } from '../../core/models/item.model';
import { ItemsPageComponent } from './items-page.component';

const base = environment.apiBaseUrl;

const CAIXAS: Category = { id: 1, name: 'Caixas', displayOrder: 0 };
const VIPS: Category = { id: 2, name: 'VIP', displayOrder: 1 };

const NATAL: Item = {
  id: 10,
  itemId: 'caixaNatal2026',
  displayName: 'Caixa de Natal',
  categoryId: 1,
  active: true,
};
const GOLD: Item = {
  id: 11,
  itemId: 'vipGold',
  displayName: 'VIP Gold',
  categoryId: 2,
  active: false,
};

describe('ItemsPageComponent', () => {
  let fixture: ComponentFixture<ItemsPageComponent>;
  let component: ItemsPageComponent;
  let controller: HttpTestingController;

  /** Boot and answer the parallel `GET /items` + `GET /categories`. */
  function boot(items: Item[], categories: Category[] = [CAIXAS, VIPS]): void {
    fixture = TestBed.createComponent(ItemsPageComponent);
    component = fixture.componentInstance;
    controller.expectOne(`${base}/items`).flush(items);
    controller.expectOne(`${base}/categories`).flush(categories);
    fixture.detectChanges();
  }

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const visibleIds = (): string[] =>
    Array.from(el().querySelectorAll('.row__id')).map(
      (n) => n.textContent?.trim() ?? '',
    );

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [ItemsPageComponent],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    controller = TestBed.inject(HttpTestingController);
  });

  afterEach(() => controller.verify());

  it('lists items with their category name and status', () => {
    boot([NATAL, GOLD]);

    expect(visibleIds()).toEqual(['caixaNatal2026', 'vipGold']);
    const text = el().textContent ?? '';
    expect(text).toContain('Caixas');
    expect(text).toContain('Ativo');
    expect(text).toContain('Inativo');
  });

  it('rejects an item_id with spaces before any round-trip', () => {
    boot([]);
    component.newItemId.set('caixa natal');
    component.newDisplayName.set('Caixa');
    component.newCategoryId.set(1);
    fixture.detectChanges();

    expect(component.itemIdValid()).toBeFalse();
    expect(component.canCreate()).toBeFalse();

    component.create();
    // The guard runs first: nothing is sent.
    controller.expectNone(`${base}/items`);
  });

  it('creates an item and offers the reward command with the id filled in', () => {
    boot([]);
    component.newItemId.set('caixaNatal2026');
    component.newDisplayName.set('Caixa de Natal');
    component.newCategoryId.set(1);

    component.create();
    controller.expectOne(`${base}/items`).flush(NATAL);
    controller.expectOne(`${base}/items`).flush([NATAL]);
    fixture.detectChanges();

    // This is the line that gets pasted into the Genesis crate config; typing
    // it by hand is where the production-breaking typo happens.
    expect(component.rewardCommand()).toBe(
      'austv-sales add %player% caixaNatal2026 %price% 1',
    );
    expect(el().querySelector('.helper__command')?.textContent).toContain(
      'caixaNatal2026',
    );
    expect(component.newItemId()).toBe('');
  });

  it('shows the 409 from a duplicate item_id on the form', () => {
    boot([]);
    component.newItemId.set('caixaNatal2026');
    component.newDisplayName.set('Caixa de Natal');
    component.newCategoryId.set(1);

    component.create();
    controller
      .expectOne(`${base}/items`)
      .flush({ message: 'Conflict' }, { status: 409, statusText: 'Conflict' });
    fixture.detectChanges();

    expect(component.createError()).toBe(
      'Já existe um item com o identificador "caixaNatal2026".',
    );
  });

  it('explains a 422 when the chosen category no longer exists', () => {
    boot([]);
    component.newItemId.set('vipGold');
    component.newDisplayName.set('VIP Gold');
    component.newCategoryId.set(99);

    component.create();
    controller.expectOne(`${base}/items`).flush(
      { message: 'Unprocessable' },
      { status: 422, statusText: 'Unprocessable Entity' },
    );
    fixture.detectChanges();

    expect(component.createError()).toContain('categoria selecionada não existe');
  });

  it('filters by category and by status', () => {
    boot([NATAL, GOLD]);

    component.filterCategoryId.set(1);
    fixture.detectChanges();
    expect(visibleIds()).toEqual(['caixaNatal2026']);

    component.filterCategoryId.set(null);
    component.filterStatus.set('inactive');
    fixture.detectChanges();
    expect(visibleIds()).toEqual(['vipGold']);

    component.filterStatus.set('active');
    fixture.detectChanges();
    expect(visibleIds()).toEqual(['caixaNatal2026']);
  });

  it('never sends item_id on an update — it is immutable', () => {
    boot([NATAL]);
    component.startEditing(NATAL);
    component.editingName.set('Caixa de Natal 2026');

    component.saveEditing();
    const req = controller.expectOne(`${base}/items/10`);
    expect(req.request.body).toEqual({
      display_name: 'Caixa de Natal 2026',
      category_id: 1,
    });
    expect(Object.keys(req.request.body as object)).not.toContain('item_id');

    req.flush({ ...NATAL, displayName: 'Caixa de Natal 2026' });
    controller
      .expectOne(`${base}/items`)
      .flush([{ ...NATAL, displayName: 'Caixa de Natal 2026' }]);
  });

  it('locks the item_id field while editing', () => {
    boot([NATAL]);
    component.startEditing(NATAL);
    fixture.detectChanges();

    const locked = el().querySelector<HTMLInputElement>('#edit-id-10');
    expect(locked?.disabled).toBeTrue();
    expect(locked?.value).toBe('caixaNatal2026');
  });

  it('requires an explicit confirmation before deactivating', () => {
    boot([NATAL]);

    component.askToDeactivate(NATAL);
    fixture.detectChanges();

    // Asking must not write anything on its own.
    controller.expectNone(`${base}/items/10`);
    const warning = el().querySelector('.notice--warning');
    expect(warning?.textContent).toContain('rejeitadas');
    expect(warning?.textContent).toContain('caixaNatal2026');

    component.confirmDeactivation();
    const req = controller.expectOne(`${base}/items/10`);
    expect(req.request.body).toEqual({ active: false });

    req.flush({ ...NATAL, active: false });
    controller.expectOne(`${base}/items`).flush([{ ...NATAL, active: false }]);
  });

  it('cancels the deactivation without touching the API', () => {
    boot([NATAL]);

    component.askToDeactivate(NATAL);
    component.cancelDeactivation();
    fixture.detectChanges();

    expect(component.pendingDeactivation()).toBeNull();
    expect(el().querySelector('.notice--warning')).toBeNull();
    controller.expectNone(`${base}/items/10`);
  });

  it('re-activates without a confirmation step', () => {
    boot([GOLD]);

    component.activate(GOLD);
    const req = controller.expectOne(`${base}/items/11`);
    expect(req.request.body).toEqual({ active: true });

    req.flush({ ...GOLD, active: true });
    controller.expectOne(`${base}/items`).flush([{ ...GOLD, active: true }]);
  });

  it('warns when there is no category to assign an item to', () => {
    boot([], []);
    expect(el().textContent).toContain('Nenhuma categoria cadastrada');
  });
});
