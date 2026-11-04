import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { adminPinInterceptor } from './core/services/admin-pin.service';
import { backendReadTimeoutInterceptor } from './core/services/backend-read-timeout.interceptor';

import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    provideHttpClient(withInterceptors([adminPinInterceptor, backendReadTimeoutInterceptor]))
  ]
};
