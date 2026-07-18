import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { environment } from '../../../environments/environment';
import { Category } from '../../core/models/category.model';
import { CategoriesPageComponent } from './categories-page.component';

const base = environment.apiBaseUrl;

const CAIXAS: Category = { id: 1, name: 'Caixas', displayOrder: 0 };
const VIP: Category = { id: 2, name: 'VIP', displayOrder: 1 };

describe('CategoriesPageComponent', () => {
  let fixture: ComponentFixture<CategoriesPageComponent>;
  let component: CategoriesPageComponent;
  let controller: HttpTestingController;

  /** Boot the component and answer its initial `GET /categories`. */
  function boot(rows: Category[]): void {
    fixture = TestBed.createComponent(CategoriesPageComponent);
    component = fixture.componentInstance;
    controller.expectOne(`${base}/categories`).flush(rows);
    fixture.detectChanges();
  }

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const rowNames = (): string[] =>
    Array.from(el().querySelectorAll('.row__name')).map(
      (n) => n.textContent?.trim() ?? '',
    );

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [CategoriesPageComponent],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    controller = TestBed.inject(HttpTestingController);
  });

  afterEach(() => controller.verify());

  it('lists categories in the order the API returned them', () => {
    boot([CAIXAS, VIP]);
    expect(rowNames()).toEqual(['Caixas', 'VIP']);
  });

  it('shows an empty state once loaded with no categories', () => {
    boot([]);
    expect(el().querySelector('.empty')?.textContent).toContain(
      'Nenhuma categoria cadastrada',
    );
  });

  it('creates a category and clears the field', () => {
    boot([CAIXAS]);
    component.newName.set('VIP');

    component.create();
    controller.expectOne(`${base}/categories`).flush(VIP);
    controller.expectOne(`${base}/categories`).flush([CAIXAS, VIP]);
    fixture.detectChanges();

    expect(component.newName()).toBe('');
    expect(rowNames()).toEqual(['Caixas', 'VIP']);
  });

  it('shows the 409 from a duplicate name on the create field', () => {
    boot([CAIXAS]);
    component.newName.set('caixas');

    component.create();
    controller
      .expectOne(`${base}/categories`)
      .flush({ message: 'Conflict' }, { status: 409, statusText: 'Conflict' });
    fixture.detectChanges();

    // The typo guard has to be visible to the person typing.
    expect(component.createError()).toBe(
      'Já existe uma categoria chamada "caixas".',
    );
    expect(el().querySelector('.form__error')?.textContent).toContain(
      'Já existe uma categoria chamada',
    );
    // The typed value survives so it can be corrected, not retyped.
    expect(component.newName()).toBe('caixas');
  });

  it('renames a category inline', () => {
    boot([CAIXAS]);
    component.startEditing(CAIXAS);
    component.editingName.set('Caixas de Natal');

    component.saveEditing();
    const renamed = { ...CAIXAS, name: 'Caixas de Natal' };
    controller.expectOne(`${base}/categories/1`).flush(renamed);
    controller.expectOne(`${base}/categories`).flush([renamed]);
    fixture.detectChanges();

    expect(component.editingId()).toBeNull();
    expect(rowNames()).toEqual(['Caixas de Natal']);
  });

  it('sends the complete id set when moving a row down', () => {
    boot([CAIXAS, VIP]);

    component.move(0, 1);
    const req = controller.expectOne(`${base}/categories/reorder`);
    expect(req.request.body).toEqual({ order: [2, 1] });

    req.flush([
      { ...VIP, displayOrder: 0 },
      { ...CAIXAS, displayOrder: 1 },
    ]);
    fixture.detectChanges();
    expect(rowNames()).toEqual(['VIP', 'Caixas']);
  });

  it('rolls the order back when the reorder fails', () => {
    boot([CAIXAS, VIP]);

    component.move(0, 1);
    // Optimistic: the UI has already swapped before the response lands.
    fixture.detectChanges();
    expect(rowNames()).toEqual(['VIP', 'Caixas']);

    controller
      .expectOne(`${base}/categories/reorder`)
      .flush(
        { message: 'Bad Request' },
        { status: 400, statusText: 'Bad Request' },
      );
    fixture.detectChanges();

    expect(rowNames()).toEqual(['Caixas', 'VIP']);
    expect(component.reorderError()).toContain('voltou ao estado anterior');
  });

  it('does not move past the ends of the list', () => {
    boot([CAIXAS, VIP]);

    component.move(0, -1);
    component.move(1, 1);

    // No request at all: the guard runs before touching the API.
    controller.expectNone(`${base}/categories/reorder`);
  });

  it('disables the move buttons at the extremes', () => {
    boot([CAIXAS, VIP]);
    const buttons = Array.from(
      el().querySelectorAll<HTMLButtonElement>('.button--icon'),
    );

    // [up(0), down(0), up(1), down(1)]
    expect(buttons[0].disabled).toBeTrue();
    expect(buttons[1].disabled).toBeFalse();
    expect(buttons[2].disabled).toBeFalse();
    expect(buttons[3].disabled).toBeTrue();
  });

  it('offers a retry when the initial load fails', () => {
    fixture = TestBed.createComponent(CategoriesPageComponent);
    component = fixture.componentInstance;
    controller
      .expectOne(`${base}/categories`)
      .flush({ message: 'Boom' }, { status: 500, statusText: 'Server Error' });
    fixture.detectChanges();

    expect(el().querySelector('.notice--error')).not.toBeNull();

    component.load();
    controller.expectOne(`${base}/categories`).flush([CAIXAS]);
    fixture.detectChanges();

    expect(component.listError()).toBeNull();
    expect(rowNames()).toEqual(['Caixas']);
  });
});
