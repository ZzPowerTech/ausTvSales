import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';

import { AuthService } from '../services/auth.service';

/**
 * Ends the session cleanly when the API rejects a call with 401.
 *
 * Without this, an expired cookie leaves the dashboard in a broken half-state:
 * the guard already ran at navigation time, so nothing re-checks the session and
 * the screen just stops working with no explanation.
 *
 * `GET /auth/me` is deliberately exempt. There, a 401 is the *normal* answer for
 * "not signed in" and is already handled by `AuthService.ensureLoaded()`; the
 * guard turns it into a redirect. Reacting here as well would fire a second,
 * competing navigation during boot.
 */
export const authErrorInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  return next(req).pipe(
    catchError((error: unknown) => {
      const isSessionProbe = req.url.endsWith('/auth/me');
      if (error instanceof HttpErrorResponse && error.status === 401 && !isSessionProbe) {
        auth.reset();
        void router.navigate(['/login'], {
          queryParams: { error: 'session_expired' },
        });
      }
      return throwError(() => error);
    }),
  );
};
