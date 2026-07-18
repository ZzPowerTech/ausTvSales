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
 *
 * Tearing down is **idempotent**: a screen that loads categories and items in
 * parallel gets two 401s at once, and without the guard below each would fire
 * its own `navigate`, cancelling the other mid-flight.
 */
export const authErrorInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  return next(req).pipe(
    catchError((error: unknown) => {
      const isSessionProbe = req.url.endsWith('/auth/me');
      const isUnauthorized =
        error instanceof HttpErrorResponse && error.status === 401;
      // `null` means the session was already torn down by an earlier 401;
      // `undefined` (still resolving) and a real user both need handling.
      const alreadySignedOut = auth.user() === null;

      if (isUnauthorized && !isSessionProbe && !alreadySignedOut) {
        auth.reset();
        void router.navigate(['/login'], {
          queryParams: { error: 'session_expired' },
        });
      }
      return throwError(() => error);
    }),
  );
};
