import { Injectable, inject } from '@angular/core';
import { HttpEvent, HttpInterceptorFn, HttpResponse } from '@angular/common/http';
import { BehaviorSubject, EMPTY, catchError, filter } from 'rxjs';
import { getBackendOrigin } from '../config/backend-url';

export type AdminInitial = 'R' | 'G' | 'S' | 'V';

@Injectable({ providedIn: 'root' })
export class AdminPinService {
  public readonly changed$ = new BehaviorSubject<number>(0);
  public tag: AdminInitial | null = null;
  public token: string | null = null;
  public expiresAt = 0;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  public get epoch(): number { return this.changed$.value; }
  public refresh(): void { this.changed$.next(this.epoch + 1); }

  public unlock(session: { tag: AdminInitial; pinToken: string; expiresAt: string }): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.tag = session.tag;
    this.token = session.pinToken;
    this.expiresAt = Date.parse(session.expiresAt);
    this.expiryTimer = setTimeout(() => this.clear(), Math.max(0, this.expiresAt - Date.now()));
    this.changed$.next(this.epoch + 1);
  }

  public clear(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    this.tag = null;
    this.token = null;
    this.expiresAt = 0;
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
  const protectedRequest = pin.token ? request.clone({ setHeaders: { 'X-Admin-Pin': pin.token } }) : request;
  // A response started under a previous PIN must never refill the dashboard after a switch or lock.
  return next(protectedRequest).pipe(
    filter((event: HttpEvent<unknown>) => !(event instanceof HttpResponse) || epoch === pin.epoch),
    catchError(error => { if (epoch !== pin.epoch) return EMPTY; throw error; })
  );
};
