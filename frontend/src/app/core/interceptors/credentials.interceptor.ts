import { HttpInterceptorFn } from '@angular/common/http';

/**
 * Sends the session cookie with every API call. Required in development, where
 * the Angular dev server and the API sit on different origins (cross-site), so
 * the browser only attaches cookies when `withCredentials` is set. Harmless in
 * production, where both share the sales.austv.net origin.
 */
export const credentialsInterceptor: HttpInterceptorFn = (req, next) =>
  next(req.clone({ withCredentials: true }));
