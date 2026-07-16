import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideHttpClient, withXhr } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';

import { environment } from '../../../environments/environment';
import { AuthUser } from '../models/auth-user.model';
import { AuthService } from './auth.service';

const USER: AuthUser = {
  discordId: '111111111111111111',
  username: 'Murilo',
  avatar: null,
};

describe('AuthService', () => {
  let service: AuthService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(withXhr()), provideHttpClientTesting()],
    });
    service = TestBed.inject(AuthService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('resolves the current user and flags authenticated', () => {
    service.ensureLoaded().subscribe((user) => expect(user).toEqual(USER));

    const req = httpMock.expectOne(`${environment.apiBaseUrl}/auth/me`);
    expect(req.request.method).toBe('GET');
    req.flush(USER);

    expect(service.isAuthenticated()).toBe(true);
    expect(service.user()).toEqual(USER);
  });

  it('treats a 401 as signed-out', () => {
    service.ensureLoaded().subscribe((user) => expect(user).toBeNull());

    httpMock
      .expectOne(`${environment.apiBaseUrl}/auth/me`)
      .flush(null, { status: 401, statusText: 'Unauthorized' });

    expect(service.isAuthenticated()).toBe(false);
    expect(service.user()).toBeNull();
  });

  it('only calls /auth/me once even across multiple guards', () => {
    service.ensureLoaded().subscribe();
    service.ensureLoaded().subscribe();

    const req = httpMock.expectOne(`${environment.apiBaseUrl}/auth/me`);
    req.flush(USER);
    // A second request would leave an unmatched call; verify must stay clean.
    expect(() => httpMock.verify()).not.toThrow();
  });

  it('clears state on logout', () => {
    service.ensureLoaded().subscribe();
    httpMock.expectOne(`${environment.apiBaseUrl}/auth/me`).flush(USER);

    service.logout().subscribe();
    httpMock
      .expectOne(`${environment.apiBaseUrl}/auth/logout`)
      .flush(null, { status: 204, statusText: 'No Content' });

    expect(service.isAuthenticated()).toBe(false);
    expect(service.user()).toBeNull();
  });
});
