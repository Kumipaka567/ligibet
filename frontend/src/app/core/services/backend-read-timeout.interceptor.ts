import { HttpInterceptorFn } from '@angular/common/http';
import { timeout } from 'rxjs';
import { getBackendOrigin } from '../config/backend-url';

/** Bound read waits. Never replay a save, login, payment or cashout request. */
export const backendReadTimeoutInterceptor: HttpInterceptorFn = (request, next) => {
  const response = next(request);
  return request.method === 'GET' && request.url.startsWith(`${getBackendOrigin()}/api/`)
    ? response.pipe(timeout({ each: 20000 })) : response;
};
