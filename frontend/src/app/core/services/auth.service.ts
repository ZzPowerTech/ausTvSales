import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, of } from 'rxjs';
import { catchError, map, shareReplay, tap } from 'rxjs/operators';

import { environment } from '../../../environments/environment';
import { AuthUser } from '../models/auth-user.model';

/**
 * Holds the authenticated dashboard user (signals) and drives the Discord login
 * flow. The session itself lives in an httpOnly cookie owned by the backend —
 * this service never touches a token, it only asks the API "who am I?".
 */
@Injectable({
  providedIn: 'root',
})
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = environment.apiBaseUrl;

  /** `undefined` = not yet resolved; `null` = resolved as signed-out. */
  private readonly userSignal = signal<AuthUser | null | undefined>(undefined);

  readonly user = this.userSignal.asReadonly();
  readonly isAuthenticated = computed(() => this.userSignal() != null);

  /** In-flight/cached `/auth/me` call, so a page load resolves it only once. */
  private meRequest?: Observable<AuthUser | null>;

  /** Resolve the current session once, caching the result for the guard. */
  ensureLoaded(): Observable<AuthUser | null> {
    if (this.userSignal() !== undefined) {
      return of(this.userSignal() ?? null);
    }
    this.meRequest ??= this.http
      .get<AuthUser>(`${this.baseUrl}/auth/me`)
      .pipe(
        catchError(() => of(null)),
        tap((user) => this.userSignal.set(user)),
        shareReplay(1),
      );
    return this.meRequest;
  }

  /** Redirect the browser to the backend, which starts the OAuth handshake. */
  login(): void {
    window.location.href = `${this.baseUrl}/auth/discord/login`;
  }

  /** Clear the session server-side, then reset local state. */
  logout(): Observable<void> {
    return this.http
      .post<void>(`${this.baseUrl}/auth/logout`, {})
      .pipe(
        catchError(() => of(undefined)),
        map(() => undefined),
        tap(() => this.reset()),
      );
  }

  /**
   * Drop the local session state without calling the API.
   *
   * Used by `authErrorInterceptor` when the server has already rejected us with
   * a 401: the cookie is gone or expired, so asking the backend to log us out
   * would just be a second failing round-trip. Clearing `meRequest` matters as
   * much as the signal — otherwise the cached `/auth/me` observable would keep
   * replaying the stale user to the next guard run.
   */
  reset(): void {
    this.userSignal.set(null);
    this.meRequest = undefined;
  }
}
