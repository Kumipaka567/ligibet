import { TestBed } from '@angular/core/testing';
import { provideHttpClient, withInterceptors, HttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from './auth.service';
import { backendReadTimeoutInterceptor } from './backend-read-timeout.interceptor';
import { getBackendOrigin } from '../config/backend-url';

const user = { id: 7, username: 'test-player', balance: 500, role: 'user' as const };
describe('login and session connection recovery', () => {
  let auth: AuthService, http: HttpTestingController;
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    auth = TestBed.inject(AuthService);
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => { http.verify(); localStorage.clear(); vi.useRealTimers(); });
  const ready = (req: { url: string }) => req.url.endsWith('/healthz');
  const profile = (req: { url: string }) => req.url.endsWith('/auth/me');
  const login = (req: { url: string }) => req.url.endsWith('/auth/login');

  it('wakes an unavailable backend before sending credentials, then submits login only once', () => {
    let failure: any;
    auth.login({ username: 'test-player', password: 'test-password' }).subscribe({ error: error => failure = error });
    http.expectOne(ready).flush({ error: 'Starting' }, { status: 503, statusText: 'Unavailable' });
    http.expectNone(login);
    vi.advanceTimersByTime(2000);
    http.expectOne(ready).flush({ status: 'ok' });
    http.expectOne(login).flush({ error: 'Wrong password' }, { status: 401, statusText: 'Unauthorized' });
    vi.advanceTimersByTime(5000);
    http.expectNone(login);
    expect(failure.status).toBe(401);
  });

  it('shares concurrent readiness checks and stops retrying invalid server configuration', () => {
    let errors = 0;
    auth.prepareBackend().subscribe({ error: () => errors++ });
    auth.prepareBackend().subscribe({ error: () => errors++ });
    http.expectOne(ready).flush({ configuration: 'invalid' }, { status: 503, statusText: 'Unavailable' });
    vi.advanceTimersByTime(3000);
    http.expectNone(ready);
    expect(errors).toBe(2);
  });

  it('coalesces profile refresh bursts and preserves the session through a transient outage', () => {
    auth.setSession({ token: 'test-session', user });
    auth.loadCurrentUser().subscribe();
    auth.loadCurrentUser().subscribe();
    http.expectOne(profile).flush({ error: 'Unavailable' }, { status: 503, statusText: 'Unavailable' });
    expect(auth.getToken()).toBe('test-session');
    expect(auth.currentUser$.value).toEqual(user);
    expect(auth.isAuthenticated$.value).toBe(true);
    auth.loadCurrentUser().subscribe();
    http.expectOne(profile).flush({ user: { ...user, balance: 700 } });
    expect(auth.userBalance$.value).toBe(700);
  });

  it('ends invalid sessions but never lets an old account response log out a newly signed-in account', () => {
    auth.setSession({ token: 'old-session', user });
    auth.loadCurrentUser().subscribe();
    const old = http.expectOne(profile);
    auth.setSession({ token: 'new-session', user: { ...user, id: 8 } });
    old.flush({ error: 'Expired' }, { status: 403, statusText: 'Forbidden' });
    expect(auth.getToken()).toBe('new-session');
    expect(auth.currentUser$.value?.id).toBe(8);
    auth.loadCurrentUser().subscribe();
    http.expectOne(profile).flush({ error: 'Expired' }, { status: 401, statusText: 'Unauthorized' });
    expect(auth.getToken()).toBeNull();
  });

  it('cancels a hung profile query without deleting a valid saved session', () => {
    auth.setSession({ token: 'test-session', user });
    auth.loadCurrentUser().subscribe();
    const request = http.expectOne(profile);
    vi.advanceTimersByTime(15001);
    expect(request.cancelled).toBe(true);
    expect(auth.getToken()).toBe('test-session');
  });
});

describe('bounded backend read queries', () => {
  let client: HttpClient, http: HttpTestingController;
  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({ providers: [provideHttpClient(withInterceptors([backendReadTimeoutInterceptor])), provideHttpClientTesting()] });
    client = TestBed.inject(HttpClient);
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => { http.verify(); vi.useRealTimers(); });

  it('cancels a stalled backend query instead of leaving its subscriber loading forever', () => {
    let failure: any;
    const url = `${getBackendOrigin()}/api/admin/logs`;
    client.get(url).subscribe({ error: error => failure = error });
    const request = http.expectOne(url);
    vi.advanceTimersByTime(20001);
    expect(failure.name).toBe('TimeoutError');
    expect(request.cancelled).toBe(true);
    http.expectNone(url);
  });

  it('does not replay or cancel a save using the read timeout', () => {
    const url = `${getBackendOrigin()}/api/admin/withdrawal-settings`;
    client.put(url, { initiation_title: 'Test' }).subscribe();
    const request = http.expectOne(url);
    vi.advanceTimersByTime(20001);
    expect(request.cancelled).toBe(false);
    http.expectNone(url);
    request.flush({ success: true });
  });
});
