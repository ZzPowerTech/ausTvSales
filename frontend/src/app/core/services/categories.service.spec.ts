import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { environment } from '../../../environments/environment';
import { Category } from '../models/category.model';
import { CategoriesService } from './categories.service';

const base = environment.apiBaseUrl;

const CAIXAS: Category = { id: 1, name: 'Caixas', displayOrder: 1 };
const VIP: Category = { id: 2, name: 'VIP', displayOrder: 0 };

describe('CategoriesService', () => {
  let service: CategoriesService;
  let controller: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(CategoriesService);
    controller = TestBed.inject(HttpTestingController);
  });

  afterEach(() => controller.verify());

  it('stores the list exactly as the API ordered it', () => {
    service.list().subscribe();
    // The server owns the ordering rule; the client must not re-sort.
    controller.expectOne(`${base}/categories`).flush([VIP, CAIXAS]);

    expect(service.categories().map((c) => c.name)).toEqual(['VIP', 'Caixas']);
    expect(service.loaded()).toBeTrue();
  });

  it('exposes a byId lookup for resolving names on the item screen', () => {
    service.list().subscribe();
    controller.expectOne(`${base}/categories`).flush([CAIXAS, VIP]);

    expect(service.byId().get(1)?.name).toBe('Caixas');
    expect(service.byId().get(99)).toBeUndefined();
  });

  it('re-reads the list after a create, and returns the created entity', () => {
    let returned: Category | undefined;
    service.create({ name: 'Caixas' }).subscribe((c) => (returned = c));

    controller.expectOne(`${base}/categories`).flush(CAIXAS);
    // The refetch is what establishes the order, not a client-side splice.
    controller.expectOne(`${base}/categories`).flush([VIP, CAIXAS]);

    expect(returned).toEqual(CAIXAS);
    expect(service.categories().map((c) => c.name)).toEqual(['VIP', 'Caixas']);
  });

  it('does not mark the catalog loaded from a create alone', () => {
    // Regression: `loaded` used to be set by every mutation, so a create that
    // landed before the initial list made one row look like the whole catalog.
    service.create({ name: 'Caixas' }).subscribe();
    controller.expectOne(`${base}/categories`).flush(CAIXAS);

    expect(service.loaded()).toBeFalse();

    controller.expectOne(`${base}/categories`).flush([CAIXAS]);
    expect(service.loaded()).toBeTrue();
  });

  it('keeps an updated category that was never in local state', () => {
    // Regression: mapping over an empty local list silently dropped the row.
    let returned: Category | undefined;
    service
      .update(1, { name: 'Caixas de Natal' })
      .subscribe((c) => (returned = c));

    const renamed = { ...CAIXAS, name: 'Caixas de Natal' };
    controller.expectOne(`${base}/categories/1`).flush(renamed);
    controller.expectOne(`${base}/categories`).flush([renamed]);

    expect(returned).toEqual(renamed);
    expect(service.categories()).toEqual([renamed]);
  });

  it('sends the complete id set to the atomic reorder endpoint', () => {
    service.reorder([2, 1]).subscribe();

    const req = controller.expectOne(`${base}/categories/reorder`);
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ order: [2, 1] });

    // The response is already the full reordered list — no refetch needed.
    req.flush([
      { ...VIP, displayOrder: 0 },
      { ...CAIXAS, displayOrder: 1 },
    ]);
    expect(service.categories().map((c) => c.name)).toEqual(['VIP', 'Caixas']);
  });

  it('does not mutate local state when the reorder fails', () => {
    service.list().subscribe();
    controller.expectOne(`${base}/categories`).flush([VIP, CAIXAS]);
    const before = service.categories();

    service.reorder([1, 2]).subscribe({ error: () => undefined });
    controller
      .expectOne(`${base}/categories/reorder`)
      .flush(
        { message: 'Bad Request' },
        { status: 400, statusText: 'Bad Request' },
      );

    expect(service.categories()).toBe(before);
  });
});
