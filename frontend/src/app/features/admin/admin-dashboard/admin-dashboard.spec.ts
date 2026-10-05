import { ChangeDetectorRef } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router } from '@angular/router';
import { BehaviorSubject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminDashboardComponent, AdminUser, ActiveUser, PendingWithdrawal } from './admin-dashboard';
import { AdminSocketService } from '../../../core/services/admin-socket.service';
import { AuthService } from '../../../core/services/auth.service';
import { SanitizedModeService } from '../../../core/services/sanitized-mode.service';

const user = (patch: Partial<AdminUser> = {}): AdminUser => ({
  id: 7, username: 'player', phone_number: '0712345678', balance: 100,
  role: 'user', is_suspended: false, is_online: false,
  created_at: '2026-10-05T07:40:25.123Z', ...patch
});

describe('Admin dashboard live account management', () => {
  let fixture: ComponentFixture<AdminDashboardComponent>;
  let component: AdminDashboardComponent;
  let http: HttpTestingController;
  let socket: any;
  let auth: any;

  beforeEach(async () => {
    socket = {
      connect: vi.fn(), disconnect: vi.fn(),
      nextRound$: new BehaviorSubject({}), previousRound$: new BehaviorSubject({}),
      currentRound$: new BehaviorSubject({ onlineUsers: 0, connectedPlayers: 0 }),
      history$: new BehaviorSubject([]), isConnected$: new BehaviorSubject(false),
      error$: new BehaviorSubject(null),
      ...Object.fromEntries([
        'transactionUpdate$', 'dashboardStatsUpdated$', 'walletUpdated$',
        'transactionsUpdated$', 'depositsUpdated$', 'withdrawalsUpdated$',
        'userUpdated$', 'activityUpdated$', 'predatorTextUpdate$', 'accessRevoked$', 'depositInitiated$'
      ].map(key => [key, new BehaviorSubject(null)]))
    };
    auth = {
      getToken: vi.fn(() => 'test-token'),
      currentUser$: new BehaviorSubject({ id: 1, username: 'owner', balance: 0, role: 'superadmin' }),
      logout: vi.fn()
    };
    await TestBed.configureTestingModule({
      imports: [AdminDashboardComponent],
      providers: [
        provideHttpClient(), provideHttpClientTesting(),
        { provide: AdminSocketService, useValue: socket },
        { provide: AuthService, useValue: auth },
        { provide: Router, useValue: { navigate: vi.fn() } },
        { provide: SanitizedModeService, useValue: {
          fetchStatus: vi.fn(), predatorCustomText: () => '',
          applyPredatorTextUpdate: vi.fn(), isSanitizedMode: () => false
        } }
      ]
    }).overrideComponent(AdminDashboardComponent, {
      set: { template: '{{ userList[0]?.balance }}|{{ stats.totalDeposits }}', imports: [] }
    }).compileComponents();
    fixture = TestBed.createComponent(AdminDashboardComponent);
    component = fixture.componentInstance;
    http = TestBed.inject(HttpTestingController);
    vi.useFakeTimers();
    fixture.detectChanges();
    http.expectOne(request => request.url.endsWith('/api/admin/overview')).flush({ users: [], stats: {}, logs: [] });
    http.expectOne(request => request.url.endsWith('/api/admin/payhero/balance')).flush({
      configured: true, balance: 466.8, accountId: 12571, updatedAt: '2026-10-05T12:00:00.000Z'
    });
  });

  afterEach(() => {
    fixture.destroy();
    vi.clearAllTimers();
    vi.useRealTimers();
    http.verify({ ignoreCancelled: true });
  });

  it('patches wallet balances across users, players and withdrawal dialogs immediately', () => {
    component.userList = [user()];
    component.activeUsersList = [{ ...user(), total_deposits: 50, total_wagers: 20, is_online: true } as ActiveUser];
    const withdrawal = {
      id: 99, user_id: 7, username: 'player', user_current_balance: 100,
      amount: 50, payment_method: 'mpesa', account_details: '', status: 'pending',
      user_total_deposits: 50, user_total_wagers: 20, is_online: true,
      created_at: '2026-10-05T09:00:00.000Z'
    } as PendingWithdrawal;
    component.pendingWithdrawalsList = [withdrawal];
    component.selectedUserForNotif = withdrawal;
    const changeDetector = (component as unknown as { cdr: ChangeDetectorRef }).cdr;
    const mark = vi.spyOn(changeDetector, 'markForCheck');

    socket.walletUpdated$.next({ action: 'deposit_completed', userId: 7, balance: 600, occurredAt: 'now' });

    expect(component.userList[0].balance).toBe(600);
    expect(component.activeUsersList[0].balance).toBe(600);
    expect(component.pendingWithdrawalsList[0].user_current_balance).toBe(600);
    expect(component.pendingWithdrawalsList[0].id).toBe(99);
    expect(component.pendingWithdrawalsList[0].created_at).toBe('2026-10-05T09:00:00.000Z');
    expect(component.getSelectedUserBalance()).toBe(600);
    expect(mark).toHaveBeenCalled();
  });

  it('refreshes shared statistics while the users tab is open', () => {
    component.activeTab = 'users';
    socket.depositsUpdated$.next({ action: 'deposit_completed', userId: 7, occurredAt: 'now' });
    vi.advanceTimersByTime(150);
    http.expectOne(request => request.url.endsWith('/api/admin/stats')).flush({ totalDeposits: 2500 });
    http.expectOne(request => request.url.includes('/api/admin/users?')).flush({ users: [user()] });
    expect(component.stats.totalDeposits).toBe(2500);
  });

  it('keeps a recent wallet event when an older user request finishes', () => {
    component.userList = [user()];
    component.fetchUsers();
    const request = http.expectOne(request => request.url.includes('/api/admin/users?'));
    socket.walletUpdated$.next({ action: 'balance_adjusted', userId: 7, balance: 900, occurredAt: 'now' });
    request.flush({ users: [user({ balance: 100 })] });
    expect(component.userList[0].balance).toBe(900);
  });

  it('updates presence immediately and filters online players locally', () => {
    component.userList = [user(), user({ id: 8, username: 'second' })];
    component.activeUsersList = [{ ...user(), total_deposits: 0, total_wagers: 0, is_online: false } as ActiveUser];
    component.userPresenceFilter = 'online';
    component.activeUserPresenceFilter = 'online';
    socket.userUpdated$.next({ action: 'user_online', userId: 7, is_online: true, occurredAt: 'now' });
    expect(component.displayedUsers.map(row => row.id)).toEqual([7]);
    expect(component.filteredActiveUsers.map(row => row.id)).toEqual([7]);
    expect(component.displayedUsers[0].created_at).toBe('2026-10-05T07:40:25.123Z');
  });

  it('filters phone variants instantly and cancels stale remote searches', () => {
    component.userList = [user(), user({ id: 8, phone_number: '0799999999' })];
    component.fetchUsers();
    const earlierRequest = http.expectOne(request => request.url.includes('/api/admin/users?'));
    component.searchQuery = '+254 712 345 678';
    component.searchUsers();
    expect(component.displayedUsers.map(row => row.id)).toEqual([7]);
    expect(earlierRequest.cancelled).toBe(true);
    vi.advanceTimersByTime(150);
    const latestRequest = http.expectOne(request => request.url.includes('search=%2B254%20712%20345%20678'));
    latestRequest.flush({ users: [user()] });
    expect(component.isLoadingUsers).toBe(false);
  });

  it('inserts a new deposit immediately and removes it when the status filter no longer matches', () => {
    component.txStatusFilter = 'pending';
    const transaction = {
      id: 20, user_id: 7, username: 'player', type: 'deposit', amount: 500,
      status: 'pending', reference: 'LIVE20', created_at: '2026-10-05T09:00:00.000Z'
    };
    socket.transactionUpdate$.next(transaction);
    expect(component.transactionsList[0].reference).toBe('LIVE20');
    socket.transactionUpdate$.next({ ...transaction, status: 'completed' });
    expect(component.transactionsList).toEqual([]);
    http.expectOne(request => request.url.includes('/api/admin/payhero/balance')).flush({ configured: true, balance: 465.8, updatedAt: '2026-10-05T12:01:00.000Z' });
    http.expectOne(request => request.url.includes('/api/admin/payhero/balance')).flush({ configured: true, balance: 465.8, updatedAt: '2026-10-05T12:01:01.000Z' });
  });

  it('promotes a user and synchronizes both account lists without a reload', () => {
    const player = user();
    component.userList = [player];
    component.setUserRole(player, 'admin');
    expect(component.confirmModal.confirmText).toBe('Promote to admin');
    component.closeConfirmDialog(true);
    expect(component.isSettingRole).toBe(7);
    const request = http.expectOne(request => request.url.endsWith('/api/admin/users/7/set-role'));
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ role: 'admin' });
    request.flush({ message: 'Role updated' });
    expect(component.userList[0].role).toBe('admin');
    expect(component.adminsList[0].id).toBe(7);
    expect(component.isSettingRole).toBeNull();
  });

  it('keeps the original role and clears loading when promotion is rejected', () => {
    const player = user();
    component.userList = [player];
    component.setUserRole(player, 'admin');
    component.closeConfirmDialog(true);
    http.expectOne(request => request.url.endsWith('/api/admin/users/7/set-role'))
      .flush({ error: 'Only the owner may promote users.' }, { status: 403, statusText: 'Forbidden' });
    expect(component.userList[0].role).toBe('user');
    expect(component.isSettingRole).toBeNull();
    expect(component.adminToast?.message).toBe('Only the owner may promote users.');
  });

  it('does not offer role changes to ordinary users or for the superadmin', () => {
    auth.currentUser$.next({ id: 1, username: 'player', balance: 0, role: 'user' });
    component.setUserRole(user(), 'admin');
    expect(component.confirmModal.isOpen).toBe(false);
    auth.currentUser$.next({ id: 1, username: 'owner', balance: 0, role: 'superadmin' });
    component.setUserRole(user({ role: 'superadmin' }), 'user');
    expect(component.confirmModal.isOpen).toBe(false);
  });

  it('recovers statistics and the visible ledger after reconnecting', () => {
    component.activeTab = 'transactions';
    socket.isConnected$.next(false);
    socket.isConnected$.next(true);
    http.expectOne(request => request.url.includes('/api/admin/payhero/balance')).flush({ configured: true, balance: 465.8, updatedAt: '2026-10-05T12:01:00.000Z' });
    vi.advanceTimersByTime(150);
    http.expectOne(request => request.url.endsWith('/api/admin/stats')).flush({ totalDeposits: 800 });
    http.expectOne(request => request.url.includes('/api/admin/transactions?')).flush({ transactions: [] });
    expect(component.stats.totalDeposits).toBe(800);
  });

  it('coalesces event bursts without losing an earlier settings invalidation', () => {
    component.activeTab = 'withdrawal-settings';
    socket.activityUpdated$.next({ action: 'deposit_settings_updated', userId: null, occurredAt: 'now' });
    socket.activityUpdated$.next({ action: 'balance_adjusted', userId: 7, occurredAt: 'now' });
    vi.advanceTimersByTime(150);
    http.expectOne(request => request.url.endsWith('/api/admin/withdrawal-settings'))
      .flush({ minimum_total_wager: 2500, initiation_title: 'Notice', initiation_message: 'Received' });
    http.expectOne(request => request.url.endsWith('/api/admin/deposit-settings')).flush({ minimum_deposit: 1500 });
    expect(component.minimumDepositAmount).toBe(1500);
  });

  it('serializes statistics refreshes during sustained wallet traffic', () => {
    socket.dashboardStatsUpdated$.next({ action: 'deposit_completed', userId: 7, occurredAt: 'first' });
    vi.advanceTimersByTime(150);
    const firstRequest = http.expectOne(request => request.url.endsWith('/api/admin/stats'));
    socket.dashboardStatsUpdated$.next({ action: 'deposit_completed', userId: 7, occurredAt: 'second' });
    vi.advanceTimersByTime(150);
    http.expectNone(request => request.url.endsWith('/api/admin/stats'));
    firstRequest.flush({ totalDeposits: 500 });
    expect(component.stats.totalDeposits).toBe(500);
    http.expectOne(request => request.url.endsWith('/api/admin/stats')).flush({ totalDeposits: 700 });
    expect(component.stats.totalDeposits).toBe(700);
  });

  it('keeps a user request running while queueing one follow-up realtime refresh', () => {
    component.activeTab = 'users';
    component.fetchUsers();
    const firstRequest = http.expectOne(request => request.url.includes('/api/admin/users?'));
    socket.walletUpdated$.next({ action: 'balance_adjusted', userId: 7, balance: 400, occurredAt: 'now' });
    vi.advanceTimersByTime(150);
    expect(firstRequest.cancelled).toBe(false);
    http.expectNone(request => request.url.includes('/api/admin/users?'));
    http.expectOne(request => request.url.endsWith('/api/admin/stats')).flush({});
    firstRequest.flush({ users: [user()] });
    expect(component.userList[0].balance).toBe(400);
    http.expectOne(request => request.url.includes('/api/admin/users?')).flush({ users: [user({ balance: 400 })] });
    expect(component.isLoadingUsers).toBe(false);
  });

  it('keeps the provider account, real zero and check time when service tokens are verified', () => {
    component.fetchPayHeroBalance(true);
    http.expectOne(request => request.url.includes('/api/admin/payhero/balance')).flush({
      configured: true, balance: 0, accountId: 12571, updatedAt: '2026-10-05T12:01:00.000Z'
    });
    expect(component.payHeroBalance).toBe(0);
    expect(component.payHeroAccountId).toBe(12571);
    expect(component.payHeroLastUpdated).toBe('2026-10-05T12:01:00.000Z');
    expect(component.payHeroError).toBeNull();
  });

  it('clears the old balance when PayHero cannot verify the wallet', () => {
    component.fetchPayHeroBalance(true);
    http.expectOne(request => request.url.includes('/api/admin/payhero/balance')).flush({
      configured: true, balance: null, error: 'PayHero is unavailable.'
    });
    expect(component.payHeroBalance).toBeNull();
    expect(component.payHeroAccountId).toBeNull();
    expect(component.payHeroLastUpdated).toBeNull();
    expect(component.payHeroError).toBe('PayHero is unavailable.');
  });

  it('shows an unavailable state for network failure and recovers on a successful refresh', () => {
    component.fetchPayHeroBalance(true);
    http.expectOne(request => request.url.includes('/api/admin/payhero/balance'))
      .flush({}, { status: 503, statusText: 'Unavailable' });
    expect(component.payHeroBalance).toBeNull();
    expect(component.payHeroError).toContain('Could not reach the server');
    component.fetchPayHeroBalance(true);
    http.expectOne(request => request.url.includes('/api/admin/payhero/balance')).flush({
      configured: true, balance: 465.8, accountId: 12571, updatedAt: '2026-10-05T12:01:00.000Z'
    });
    expect(component.payHeroBalance).toBe(465.8);
    expect(component.payHeroError).toBeNull();
  });

  it('does not invent a verification time for an incomplete response', () => {
    component.fetchPayHeroBalance(true);
    http.expectOne(request => request.url.includes('/api/admin/payhero/balance')).flush({ configured: true, balance: 900 });
    expect(component.payHeroBalance).toBeNull();
    expect(component.payHeroLastUpdated).toBeNull();
  });

  it('queues a fresh check after the provider processes a deposit while an earlier check is running', () => {
    component.fetchPayHeroBalance(true);
    const earlier = http.expectOne(request => request.url.includes('/api/admin/payhero/balance'));
    socket.dashboardStatsUpdated$.next({ action: 'payhero_service_wallet_changed', userId: null, occurredAt: 'now' });
    socket.dashboardStatsUpdated$.next({ action: 'payhero_service_wallet_changed', userId: null, occurredAt: 'now' });
    http.expectNone(request => request.url.includes('/api/admin/payhero/balance'));
    earlier.flush({ configured: true, balance: 466.8, updatedAt: '2026-10-05T12:01:00.000Z' });
    http.expectOne(request => request.url.includes('/api/admin/payhero/balance')).flush({
      configured: true, balance: 465.8, updatedAt: '2026-10-05T12:01:01.000Z'
    });
    expect(component.payHeroBalance).toBe(465.8);
    expect(component.isLoadingPayHeroBalance).toBe(false);
  });

  it('periodically checks service tokens and cancels pending checks on destruction', () => {
    vi.advanceTimersByTime(30000);
    const request = http.expectOne(request => request.url.includes('/api/admin/payhero/balance'));
    fixture.destroy();
    expect(request.cancelled).toBe(true);
    vi.advanceTimersByTime(60000);
    http.expectNone(request => request.url.includes('/api/admin/payhero/balance'));
  });
});
