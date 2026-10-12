import { Injectable, inject } from '@angular/core';
import { HttpErrorResponse, HttpEvent, HttpInterceptorFn, HttpResponse } from '@angular/common/http';
import { BehaviorSubject, EMPTY, catchError, filter, map } from 'rxjs';
import { getBackendOrigin } from '../config/backend-url';

export type AdminInitial = 'R' | 'G' | 'S' | 'V';

// Keep table rows visible while ownership changes; new server responses restore authorized numbers.
export function maskClientPhoneNumbers<T>(payload: T): T {
  const phonePattern = /(?<!\d)(?:\+?254[\s().-]*[17]|0[\s().-]*[17]|[17])(?:[\s().-]*\d){8}(?!\d)/g;
  const mask = (value: string) => {
    const digits = value.replace(/\D/g, '');
    return (value.startsWith('+') ? '+' : '') + digits.slice(0, -7) + '*****' + digits.slice(-2);
  };
  function visit(value: any, field = ''): any {
    if (typeof value === 'string') {
      if (/phone/i.test(field) && !value.includes('*') && value.replace(/\D/g, '').length >= 7) return mask(value);
      return value.replace(phonePattern, mask);
    }
    if (typeof value === 'number' && /phone/i.test(field)) return mask(String(value));
    if (Array.isArray(value)) return value.map(item => visit(item, field));
    if (value && typeof value === 'object' && !(value instanceof Date)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child, key)]));
    return value;
  }
  return visit(payload);
}

@Injectable({ providedIn: 'root' })
export class AdminPinService {
  public readonly changed$ = new BehaviorSubject<number>(0);
  public tag: AdminInitial | null = null;
  public token: string | null = null;
  public expiresAt = 0;
  public changeReason: 'identity' | 'ownership' = 'identity';
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  public get epoch(): number { return this.changed$.value; }
  public refresh(): void { this.changeReason = 'ownership'; this.changed$.next(this.epoch + 1); }

  public unlock(session: { tag: AdminInitial; pinToken: string; expiresAt: string }): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.tag = session.tag;
    this.token = session.pinToken;
    this.expiresAt = Date.parse(session.expiresAt);
    this.changeReason = 'identity';
    this.expiryTimer = setTimeout(() => this.clear(), Math.max(0, this.expiresAt - Date.now()));
    this.changed$.next(this.epoch + 1);
  }

  public clear(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    this.tag = null;
    this.token = null;
    this.expiresAt = 0;
    this.changeReason = 'identity';
    this.changed$.next(this.epoch + 1);
  }
}

export const adminPinInterceptor: HttpInterceptorFn = (request, next) => {
  const backend = new URL(getBackendOrigin());
  const target = new URL(request.url, backend);
  if (target.origin !== backend.origin || !/^\/api\/admin(?:\/|$)/.test(target.pathname)) return next(request);
  const pin = inject(AdminPinService);
  if (pin.token && pin.expiresAt <= Date.now()) pin.clear();
  const epoch = pin.epoch;
  const claim = request.method === 'POST' && /^\/api\/admin\/transactions\/\d+\/claim-tag$/.test(target.pathname);
  const setup = request.method === 'POST' && target.pathname === '/api/admin/pin/configure';
  const acknowledgement = claim || setup;
  const protectedRequest = claim ? request.clone({ headers: request.headers.delete('X-Admin-Pin') })
    : pin.token ? request.clone({ setHeaders: { 'X-Admin-Pin': pin.token } }) : request;
  // A response started under a previous PIN must never refill the dashboard after a switch or lock.
  return next(protectedRequest).pipe(
    map((event: HttpEvent<unknown>) => {
      if (!(event instanceof HttpResponse) || !acknowledgement) return event;
      // Live invalidation can arrive before the HTTP result. Pass only non-sensitive acknowledgement fields.
      const body = event.body as any;
      if (claim) return event.clone({ body: {
        message: 'Client claimed.', transactionId: Number(body?.transactionId ?? body?.transaction?.id),
        tag: ['R', 'G', 'S', 'V'].includes(body?.tag ?? body?.transaction?.admin_tag) ? body.tag ?? body.transaction.admin_tag : undefined
      } });
      return event.clone({ body: { message: 'PINs saved.', configuredTags: Array.isArray(body?.configuredTags)
        ? body.configuredTags.filter((tag: string) => ['R', 'G', 'S', 'V'].includes(tag)) : [] } });
    }),
    filter((event: HttpEvent<unknown>) => !(event instanceof HttpResponse) || acknowledgement || epoch === pin.epoch),
    catchError(error => {
      if (epoch !== pin.epoch) {
        if (!acknowledgement) return EMPTY;
        throw new HttpErrorResponse({ status: error.status, error: { error: 'Unable to complete this action. Refresh and try again.' } });
      }
      throw error;
    })
  );
};
