import { TestBed } from '@angular/core/testing';
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminPinService, adminPinInterceptor } from './admin-pin.service';

describe('Admin PIN isolation', () => {
  let pin: AdminPinService;
  let client: HttpClient;
  let http: HttpTestingController;
  const unlock = (tag: 'R' | 'G') => pin.unlock({ tag, pinToken: tag + '-private-token', expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString() });

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({ providers: [provideHttpClient(withInterceptors([adminPinInterceptor])), provideHttpClientTesting()] });
    pin = TestBed.inject(AdminPinService);
    client = TestBed.inject(HttpClient);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => { pin.clear(); http.verify(); vi.clearAllTimers(); vi.useRealTimers(); });

  it('adds PIN credentials only to admin API calls and clears on expiry', () => {
    unlock('R');
    client.get('/api/admin/users').subscribe();
    const admin = http.expectOne('/api/admin/users');
    expect(admin.request.headers.get('X-Admin-Pin')).toBe('R-private-token');
    admin.flush({ users: [] });
    client.get('/api/auth/me').subscribe();
    const player = http.expectOne('/api/auth/me');
    expect(player.request.headers.has('X-Admin-Pin')).toBe(false);
    player.flush({ user: {} });
    client.get('https://untrusted.example/api/admin/users').subscribe();
    const external = http.expectOne('https://untrusted.example/api/admin/users');
    expect(external.request.headers.has('X-Admin-Pin')).toBe(false);
    external.flush({});
    vi.advanceTimersByTime(15 * 60 * 1000);
    expect(pin.tag).toBeNull();
    expect(pin.token).toBeNull();
  });

  it('discards old phone responses after switching initials or locking', () => {
    unlock('R');
    const receive = vi.fn();
    client.get('/api/admin/users').subscribe(receive);
    const old = http.expectOne('/api/admin/users');
    unlock('G');
    old.flush({ users: [{ phone_number: '0712345678' }] });
    expect(receive).not.toHaveBeenCalled();
    client.get('/api/admin/support/tickets').subscribe(receive);
    const ticket = http.expectOne('/api/admin/support/tickets');
    pin.clear();
    ticket.flush({ tickets: [{ phone_number: '0712345678' }] });
    expect(receive).not.toHaveBeenCalled();
  });

  it('discards late requests and errors after another client was claimed', () => {
    const receive = vi.fn(), error = vi.fn();
    client.get('/api/admin/users').subscribe({ next: receive, error });
    const old = http.expectOne('/api/admin/users');
    pin.changed$.next(pin.epoch + 1);
    old.flush({ error: 'old response' }, { status: 503, statusText: 'Unavailable' });
    expect(receive).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('claims without PIN headers and accepts safe acknowledgements after live ownership invalidation', () => {
    unlock('R');
    const receive = vi.fn();
    client.post('/api/admin/transactions/501/claim-tag', { tag: 'S' }).subscribe(receive);
    const claim = http.expectOne('/api/admin/transactions/501/claim-tag');
    expect(claim.request.headers.has('X-Admin-Pin')).toBe(false);
    pin.refresh();
    claim.flush({ transactionId: 501, tag: 'S', phone_number: '0712345678', owner_key: 'private' });
    expect(receive).toHaveBeenCalledWith({ message: 'Client claimed.', transactionId: 501, tag: 'S' });
  });

  it('finishes PIN setup after its live revocation event without exposing secret fields', () => {
    unlock('R');
    const receive = vi.fn();
    client.post('/api/admin/pin/configure', {}).subscribe(receive);
    const setup = http.expectOne('/api/admin/pin/configure');
    pin.clear();
    setup.flush({ configuredTags: ['R'], pin_hash: 'secret' });
    expect(receive).toHaveBeenCalledWith({ message: 'PINs saved.', configuredTags: ['R'] });
  });
});
