import {
  HttpClient,
  provideHttpClient,
  withInterceptors,
} from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';

import { environment } from '../../../environments/environment';
import { AuthService } from '../services/auth.service';
import { authErrorInterceptor } from './auth-error.interceptor';

describe('authErrorInterceptor', () => {
  let http: HttpClient;
  let controller: HttpTestingController;
  let navigate: jasmine.Spy;
  let reset: jasmine.Spy;

  const base = environment.apiBaseUrl;

  beforeEach(() => {
    navigate = jasmine.createSpy('navigate').and.resolveTo(true);
    reset = jasmine.createSpy('reset');

    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([authErrorInterceptor])),
        provideHttpClientTesting(),
        { provide: Router, useValue: { navigate } },
        { provide: AuthService, useValue: { reset } },
      ],
    });

    http = TestBed.inject(HttpClient);
    controller = TestBed.inject(HttpTestingController);
  });

  afterEach(() => controller.verify());

  it('clears the session and redirects to login on a 401', (done) => {
    http.get(`${base}/categories`).subscribe({
      error: () => {
        expect(reset).toHaveBeenCalled();
        expect(navigate).toHaveBeenCalledWith(['/login'], {
          queryParams: { error: 'session_expired' },
        });
        done();
      },
    });

    controller
      .expectOne(`${base}/categories`)
      .flush({ message: 'Unauthorized' }, { status: 401, statusText: 'Unauthorized' });
  });

  it('ignores a 401 from /auth/me so the boot probe does not double-navigate', (done) => {
    // The guard already turns this into a redirect via AuthService.ensureLoaded;
    // reacting here too would fire a second, competing navigation.
    http.get(`${base}/auth/me`).subscribe({
      error: () => {
        expect(reset).not.toHaveBeenCalled();
        expect(navigate).not.toHaveBeenCalled();
        done();
      },
    });

    controller
      .expectOne(`${base}/auth/me`)
      .flush({ message: 'Unauthorized' }, { status: 401, statusText: 'Unauthorized' });
  });

  it('leaves non-401 errors alone', (done) => {
    http.get(`${base}/categories`).subscribe({
      error: () => {
        expect(reset).not.toHaveBeenCalled();
        expect(navigate).not.toHaveBeenCalled();
        done();
      },
    });

    controller
      .expectOne(`${base}/categories`)
      .flush({ message: 'Boom' }, { status: 500, statusText: 'Server Error' });
  });

  it('re-throws the error so callers can still handle it', (done) => {
    http.get(`${base}/categories`).subscribe({
      error: (error: { status: number }) => {
        expect(error.status).toBe(401);
        done();
      },
    });

    controller
      .expectOne(`${base}/categories`)
      .flush({ message: 'Unauthorized' }, { status: 401, statusText: 'Unauthorized' });
  });
});
