import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';

import { environment } from '../../../environments/environment';
import { Sale } from '../models/sale.model';
import { ApiService } from './api.service';

describe('ApiService', () => {
  let service: ApiService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(ApiService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('should request sales from the configured API base URL', () => {
    const mockSales: Sale[] = [
      {
        sale_id: 'a1b2c3',
        item_id: 'caixaNatal2026',
        player_uuid: 'uuid-123',
        nickname_at_purchase: 'Player1',
        total_price: 9.99,
        qtd: 1,
        purchased_at: '2026-07-12T00:00:00.000Z',
        historical_import: false,
      },
    ];

    service.getSales().subscribe((sales) => {
      expect(sales).toEqual(mockSales);
    });

    const req = httpMock.expectOne(`${environment.apiBaseUrl}/sales`);
    expect(req.request.method).toBe('GET');
    req.flush(mockSales);
  });
});
