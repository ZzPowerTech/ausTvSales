import { TestBed } from '@angular/core/testing';
import {
  ActivatedRouteSnapshot,
  GuardResult,
  RouterStateSnapshot,
  UrlTree,
  provideRouter,
} from '@angular/router';
import { Observable, of } from 'rxjs';

import { AuthUser } from '../models/auth-user.model';
import { AuthService } from '../services/auth.service';
import { authGuard } from './auth.guard';

const USER: AuthUser = {
  discordId: '111111111111111111',
  username: 'Murilo',
  avatar: null,
};

function runGuard(): Observable<GuardResult> {
  return TestBed.runInInjectionContext(
    () =>
      authGuard(
        {} as ActivatedRouteSnapshot,
        {} as RouterStateSnapshot,
      ) as Observable<GuardResult>,
  );
}

describe('authGuard', () => {
  let ensureLoaded: jasmine.Spy;

  beforeEach(() => {
    ensureLoaded = jasmine.createSpy('ensureLoaded');
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: AuthService, useValue: { ensureLoaded } },
      ],
    });
  });

  it('allows navigation for an authenticated user', (done) => {
    ensureLoaded.and.returnValue(of(USER));
    runGuard().subscribe((result) => {
      expect(result).toBe(true);
      done();
    });
  });

  it('redirects to /login when signed-out', (done) => {
    ensureLoaded.and.returnValue(of(null));
    runGuard().subscribe((result) => {
      expect(result).not.toBe(true);
      expect((result as UrlTree).toString()).toBe('/login');
      done();
    });
  });
});
