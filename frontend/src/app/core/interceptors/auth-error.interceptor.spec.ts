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
import { signal } from '@angular/core';
import { Router } from '@angular/router';

import { AuthUser } from '../models/auth-user.model';
import { environment } from '../../../environments/environment';
import { AuthService } from '../services/auth.service';
import { authErrorInterceptor } from './auth-error.interceptor';

const USER: AuthUser = {
  discordId: '111111111111111111',
  username: 'Murilo',
  avatar: null,
};

describe('authErrorInterceptor', () => {
  let http: HttpClient;
  let controller: HttpTestingController;
  let navigate: jasmine.Spy;
  let reset: jasmine.Spy;
  let user: ReturnType<typeof signal<AuthUser | null | undefined>>;

  const base = environment.apiBaseUrl;

  beforeEach(() => {
    navigate = jasmine.createSpy('navigate').and.resolveTo(true);
    user = signal<AuthUser | null | undefined>(USER);
    reset = jasmine.createSpy('reset').and.callFake(() => user.set(null));

    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([authErrorInterceptor])),
        provideHttpClientTesting(),
        { provide: Router, useValue: { navigate } },
        { provide: AuthService, useValue: { reset, user } },
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

  it('tears down only once when parallel requests all 401', (done) => {
    // Regression: the S4.3 screen loads categories and items together. Without
    // an idempotence guard each 401 fired its own navigate, cancelling the
    // other mid-flight.
    let errors = 0;
    const settle = (): void => {
      if (++errors === 2) {
        expect(reset).toHaveBeenCalledTimes(1);
        expect(navigate).toHaveBeenCalledTimes(1);
        done();
      }
    };

    http.get(`${base}/categories`).subscribe({ error: settle });
    http.get(`${base}/items`).subscribe({ error: settle });

    const unauthorized = {
      status: 401,
      statusText: 'Unauthorized',
    };
    controller
      .expectOne(`${base}/categories`)
      .flush({ message: 'Unauthorized' }, unauthorized);
    controller
      .expectOne(`${base}/items`)
      .flush({ message: 'Unauthorized' }, unauthorized);
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
