import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { map } from 'rxjs/operators';

import { AuthService } from '../services/auth.service';

/**
 * Blocks a route until a valid session is confirmed. Unauthenticated users are
 * sent to `/login`. Deny-by-default: every dashboard route should carry this.
 */
export const authGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  return auth
    .ensureLoaded()
    .pipe(map((user) => (user ? true : router.createUrlTree(['/login']))));
};
