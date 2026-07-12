import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { environment } from '../../../environments/environment';
import { Sale } from '../models/sale.model';

/**
 * Thin HTTP client for the `austv-sales` backend API.
 *
 * Endpoints will be filled in as dashboard features are implemented in
 * later sprints (see `.specs/project/PROJECT.md`).
 */
@Injectable({
  providedIn: 'root',
})
export class ApiService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = environment.apiBaseUrl;

  /** Fetches sale events from the API. */
  getSales(): Observable<Sale[]> {
    return this.http.get<Sale[]>(`${this.baseUrl}/sales`);
  }
}
