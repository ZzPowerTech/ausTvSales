import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { environment } from '../../../environments/environment';
import { Item } from '../models/item.model';
import { ItemsService } from './items.service';

const base = environment.apiBaseUrl;

const CAIXA: Item = {
  id: 1,
  itemId: 'caixaNatal2026',
  displayName: 'Caixa de Natal',
  categoryId: 1,
  active: true,
};

/**
 * Regression cover for the two state bugs found in review (same defects the
 * categories service had). The full behavioural suite lands with S4.3, when the
 * item screen exists to exercise it.
 */
describe('ItemsService', () => {
  let service: ItemsService;
  let controller: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(ItemsService);
    controller = TestBed.inject(HttpTestingController);
  });

  afterEach(() => controller.verify());

  it('does not mark the catalog loaded from a create alone', () => {
    service.create({ item_id: 'caixaNatal2026', display_name: 'Caixa de Natal', category_id: 1 }).subscribe();
    controller.expectOne(`${base}/items`).flush(CAIXA);

    expect(service.loaded()).toBeFalse();

    controller.expectOne(`${base}/items`).flush([CAIXA]);
    expect(service.loaded()).toBeTrue();
  });

  it('keeps an updated item that was never in local state', () => {
    let returned: Item | undefined;
    service.update(1, { active: false }).subscribe((i) => (returned = i));

    const deactivated = { ...CAIXA, active: false };
    controller.expectOne(`${base}/items/1`).flush(deactivated);
    controller.expectOne(`${base}/items`).flush([deactivated]);

    expect(returned).toEqual(deactivated);
    expect(service.items()).toEqual([deactivated]);
  });
});
