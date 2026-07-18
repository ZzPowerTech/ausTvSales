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

  it('keeps the list sorted by display_order, then name', () => {
    service.list().subscribe();
    controller.expectOne(`${base}/categories`).flush([CAIXAS, VIP]);

    expect(service.categories().map((c) => c.name)).toEqual(['VIP', 'Caixas']);
    expect(service.loaded()).toBeTrue();
  });

  it('exposes a byId lookup for resolving names on the item screen', () => {
    service.list().subscribe();
    controller.expectOne(`${base}/categories`).flush([CAIXAS, VIP]);

    expect(service.byId().get(1)?.name).toBe('Caixas');
    expect(service.byId().get(99)).toBeUndefined();
  });

  it('adds a created category to local state', () => {
    service.list().subscribe();
    controller.expectOne(`${base}/categories`).flush([VIP]);

    service.create({ name: 'Caixas' }).subscribe();
    controller.expectOne(`${base}/categories`).flush(CAIXAS);

    expect(service.categories().map((c) => c.name)).toEqual(['VIP', 'Caixas']);
  });

  it('replaces the renamed category in place', () => {
    service.list().subscribe();
    controller.expectOne(`${base}/categories`).flush([CAIXAS]);

    service.update(1, { name: 'Caixas de Natal' }).subscribe();
    controller
      .expectOne(`${base}/categories/1`)
      .flush({ ...CAIXAS, name: 'Caixas de Natal' });

    expect(service.categories()[0].name).toBe('Caixas de Natal');
  });

  it('sends the complete id set to the atomic reorder endpoint', () => {
    service.reorder([2, 1]).subscribe();

    const req = controller.expectOne(`${base}/categories/reorder`);
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual({ order: [2, 1] });

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
      .flush({ message: 'Bad Request' }, { status: 400, statusText: 'Bad Request' });

    expect(service.categories()).toBe(before);
  });
});
