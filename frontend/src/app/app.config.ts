import { ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import {
  provideHttpClient,
  withInterceptors,
  withXhr,
} from '@angular/common/http';
import { provideRouter, withComponentInputBinding } from '@angular/router';

import { routes } from './app.routes';
import { credentialsInterceptor } from './core/interceptors/credentials.interceptor';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    // withComponentInputBinding: binds route query params (e.g. ?error=) to
    // component inputs, used by the login screen.
    provideRouter(routes, withComponentInputBinding()),
    provideHttpClient(withXhr(), withInterceptors([credentialsInterceptor])),
  ],
};
