import { ChangeDetectorRef } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router } from '@angular/router';
import { BehaviorSubject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminDashboardComponent, AdminUser, ActiveUser, PendingWithdrawal } from './admin-dashboard';
import { AdminSocketService } from '../../../core/services/admin-socket.service';
import { AuthService } from '../../../core/services/auth.service';
import { SanitizedModeService } from '../../../core/services/sanitized-mode.service';
import { adminPinInterceptor } from '../../../core/services/admin-pin.service';

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
      connect: vi.fn(), disconnect: vi.fn(), maskClientData: vi.fn(),
      nextRound$: new BehaviorSubject({}), previousRound$: new BehaviorSubject({}),
      currentRound$: new BehaviorSubject({ onlineUsers: 0, connectedPlayers: 0 }),
      history$: new BehaviorSubject([]), isConnected$: new BehaviorSubject(false),
      error$: new BehaviorSubject(null),
      ...Object.fromEntries([
        'transactionUpdate$', 'dashboardStatsUpdated$', 'walletUpdated$',
        'transactionsUpdated$', 'depositsUpdated$', 'withdrawalsUpdated$',
        'userUpdated$', 'activityUpdated$', 'predatorTextUpdate$', 'accessRevoked$', 'depositInitiated$', 'onlinePlayers$', 'supportTicketUpdated$', 'supportTicketsDeleted$', 'clientClaimed$', 'leaderboardUpdated$', 'claimTagsUpdated$', 'pinChanged$', 'timedCrashTimeoutUpdated$'
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
        provideHttpClient(withInterceptors([adminPinInterceptor])), provideHttpClientTesting(),
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
    http.expectOne(request => request.url.endsWith('/api/admin/online-players/summary')).flush({
      onlineUsers: 0, connectedPlayers: 0, topPlayers: [], version: 0, updatedAt: '2026-10-05T12:00:00Z'
    });
    http.expectOne(request => request.url.endsWith('/api/admin/support/tickets')).flush({ tickets: [] });
    http.expectOne(request => request.url.endsWith('/api/admin/withdrawal-settings')).flush({ minimum_total_wager: 2500 });
  }, 30000);

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

  it('deletes only marked Support conversations after confirmation and closes a removed conversation', () => {
    const first = { id: 21, category: 'general', status: 'open', messages: [] };
    const keep = { id: 22, category: 'general', status: 'open', messages: [] };
    component.supportTickets = [first, keep];
    component.selectTicket(first);
    component.markSupportTicket(21);
    const confirm = vi.spyOn(component as any, 'openConfirmDialog');
    component.deleteMarkedSupportConversations();
    http.expectNone(req => req.method === 'DELETE');
    (confirm.mock.calls[0][0] as { onConfirm: () => void }).onConfirm();
    const request = http.expectOne(req => req.method === 'DELETE' && req.url.endsWith('/support/tickets'));
    expect(request.request.body).toEqual({ ticket_ids: [21] });
    request.flush({ deletedIds: [21] });
    expect(component.supportTickets.map(ticket => ticket.id)).toEqual([22]);
    expect(component.selectedTicket).toBeNull();
    expect(component.markedSupportTicketIds.size).toBe(0);
    expect(component.isDeletingSupport).toBe(false);
  });

  it('deletes marked individual Support messages and preserves the other messages and conversation', () => {
    const removed = '000000000000000000000001', kept = '000000000000000000000002';
    const ticket = { id: 21, messages: [{ _id: removed, text: 'Delete' }, { _id: kept, text: 'Keep' }] };
    component.supportTickets = [ticket];
    component.selectTicket(ticket);
    component.markSupportMessage(removed);
    const confirm = vi.spyOn(component as any, 'openConfirmDialog');
    component.deleteMarkedSupportMessages();
    (confirm.mock.calls[0][0] as { onConfirm: () => void }).onConfirm();
    const request = http.expectOne(req => req.method === 'DELETE' && req.url.endsWith('/support/tickets/21/messages'));
    expect(request.request.body).toEqual({ message_ids: [removed] });
    request.flush({ ticket: { ...ticket, messages: [ticket.messages[1]] }, deletedMessageIds: [removed] });
    expect(component.selectedTicket.messages.map((message: any) => message._id)).toEqual([kept]);
    expect(component.supportTickets.length).toBe(1);
    expect(component.markedSupportMessageIds.size).toBe(0);
  });

  it('limits Support selection and deletion to superadmin and clears message marks when switching conversations', () => {
    component.supportTickets = [{ id: 21, category: 'general', messages: [{ _id: 'first' }] }, { id: 22, category: 'appeal', messages: [] }];
    component.selectTicket(component.supportTickets[0]);
    auth.currentUser$.next({ id: 1, role: 'admin' });
    const confirm = vi.spyOn(component as any, 'openConfirmDialog');
    component.markAllSupportTickets();
    component.markAllSupportMessages();
    component.markSupportTicket(21);
    component.markSupportMessage('first');
    component.deleteMarkedSupportConversations();
    component.deleteMarkedSupportMessages();
    expect(component.markedSupportTicketIds.size).toBe(0);
    expect(component.markedSupportMessageIds.size).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
    auth.currentUser$.next({ id: 1, role: 'superadmin' });
    component.supportCategoryFilter = 'general';
    component.markAllSupportTickets();
    expect([...component.markedSupportTicketIds]).toEqual([21]);
    component.markAllSupportMessages();
    expect(component.allSupportMessagesMarked).toBe(true);
    component.selectTicket(component.supportTickets[1]);
    expect(component.markedSupportMessageIds.size).toBe(0);
  });

  it('retains Support messages and marks when deletion is rejected', () => {
    const ticket = { id: 21, messages: [{ _id: '000000000000000000000001', text: 'Keep on failure' }] };
    component.selectTicket(ticket);
    component.markSupportMessage(ticket.messages[0]._id);
    const confirm = vi.spyOn(component as any, 'openConfirmDialog');
    component.deleteMarkedSupportMessages();
    (confirm.mock.calls[0][0] as { onConfirm: () => void }).onConfirm();
    http.expectOne(req => req.method === 'DELETE').flush({ error: 'Unavailable' }, { status: 503, statusText: 'Unavailable' });
    expect(component.selectedTicket.messages).toEqual(ticket.messages);
    expect(component.markedSupportMessageIds.size).toBe(1);
    expect(component.isDeletingSupport).toBe(false);
  });

  it('applies live Support deletions and prevents stale fetches from restoring removed conversations or messages', () => {
    const removed = '000000000000000000000001', kept = '000000000000000000000002';
    const oldTicket = { id: 21, messages: [{ _id: removed, text: 'Old' }, { _id: kept, text: 'Keep' }] };
    component.supportTickets = [oldTicket, { id: 22, messages: [] }];
    component.selectTicket(oldTicket);
    component.activeTab = 'support';
    component.fetchSupportTickets();
    const request = http.expectOne(req => req.url.endsWith('/support/tickets'));
    socket.supportTicketUpdated$.next({ ticket: { ...oldTicket, messages: [oldTicket.messages[1]] }, deletedMessageIds: [removed] });
    socket.supportTicketsDeleted$.next({ ticketIds: [22] });
    request.flush({ tickets: [oldTicket, { id: 22, messages: [] }] });
    expect(component.supportTickets.map(ticket => ticket.id)).toEqual([21]);
    expect(component.selectedTicket.messages.map((message: any) => message._id)).toEqual([kept]);
    socket.supportTicketUpdated$.next({ ticket: { id: 22, messages: [] } });
    expect(component.supportTickets.length).toBe(1);
  });

  it('deletes a completed transaction only after confirmation and leaves balances and totals unchanged', () => {
    const tx: any = { id: 91, user_id: 7, type: 'deposit', status: 'completed', amount: 500 };
    component.transactionsList = [tx];
    component.userList = [user({ balance: 650 })];
    component.stats.totalDeposits = 500;
    const confirm = vi.spyOn(component as any, 'openConfirmDialog');
    component.deleteCompletedTransaction(tx);
    http.expectNone(req => req.method === 'DELETE');
    (confirm.mock.calls[0][0] as { onConfirm: () => void }).onConfirm();
    expect(component.deletingTransactionId).toBe(91);
    http.expectOne(req => req.method === 'DELETE' && req.url.endsWith('/transactions/91')).flush({ transactionId: 91 });
    expect(component.transactionsList).toEqual([]);
    expect(component.userList[0].balance).toBe(650);
    expect(component.stats.totalDeposits).toBe(500);
    expect(component.deletingTransactionId).toBeNull();
  });

  it('does not allow ordinary admins or pending transactions to enter the delete flow and retains a rejected row', () => {
    const tx: any = { id: 91, user_id: 7, type: 'deposit', status: 'completed', amount: 500 };
    const confirm = vi.spyOn(component as any, 'openConfirmDialog');
    auth.currentUser$.next({ id: 1, role: 'admin' });
    component.deleteCompletedTransaction(tx);
    auth.currentUser$.next({ id: 1, role: 'superadmin' });
    component.deleteCompletedTransaction({ ...tx, status: 'pending' });
    expect(confirm).not.toHaveBeenCalled();
    component.transactionsList = [tx];
    component.deleteCompletedTransaction(tx);
    (confirm.mock.calls[0][0] as { onConfirm: () => void }).onConfirm();
    http.expectOne(req => req.method === 'DELETE').flush({ error: 'Not permitted' }, { status: 403, statusText: 'Forbidden' });
    expect(component.transactionsList).toEqual([tx]);
    expect(component.deletingTransactionId).toBeNull();
  });

  it('removes live deletions and prevents an older in-flight response from restoring the row', () => {
    const tx: any = { id: 91, user_id: 7, type: 'deposit', status: 'completed', amount: 500 };
    component.transactionsList = [tx];
    component.fetchTransactions();
    const request = http.expectOne(req => req.url.includes('/api/admin/transactions?'));
    socket.transactionsUpdated$.next({ action: 'transaction_deleted', transactionId: 91, userId: null });
    expect(component.transactionsList).toEqual([]);
    request.flush({ transactions: [tx] });
    expect(component.transactionsList).toEqual([]);
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
    vi.advanceTimersByTime(300);
    const latestRequest = http.expectOne(request => request.url.includes('search=%2B254%20712%20345%20678'));
    latestRequest.flush({ users: [user()] });
    expect(component.isLoadingUsers).toBe(false);
  });

  it('coalesces a statistics event burst into one request', () => {
    socket.dashboardStatsUpdated$.next({ action: 'bet_placed', userId: 7 });
    socket.dashboardStatsUpdated$.next({ action: 'bet_cashout', userId: 7 });
    http.expectNone(request => request.url.endsWith('/api/admin/stats'));
    vi.advanceTimersByTime(150);
    http.expectOne(request => request.url.endsWith('/api/admin/stats')).flush({ totalBets: 1 });
  });

  it('does not reload audit history for game activity, but refreshes it after an admin change', () => {
    component.activeTab = 'logs';
    socket.activityUpdated$.next({ action: 'bet_cashout', userId: 7 });
    vi.advanceTimersByTime(150);
    http.expectNone(request => request.url.endsWith('/api/admin/logs'));
    socket.activityUpdated$.next({ action: 'user_role_updated', userId: 7 });
    vi.advanceTimersByTime(150);
    http.expectOne(request => request.url.endsWith('/api/admin/logs')).flush({ logs: [] });
  });

  it('reports a failed user search and clears the error when the admin retries', () => {
    component.fetchUsers();
    http.expectOne(request => request.url.includes('/api/admin/users?'))
      .flush({ error: 'Unavailable' }, { status: 503, statusText: 'Unavailable' });
    expect(component.isLoadingUsers).toBe(false);
    expect(component.userLoadError).toContain('retry');
    component.fetchUsers();
    expect(component.userLoadError).toBe('');
    http.expectOne(request => request.url.includes('/api/admin/users?')).flush({ users: [user()] });
    expect(component.userList[0].id).toBe(7);
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

  it('bounds player and withdrawal rendering with large lists while preserving all records', () => {
    component.activeUsersList = Array.from({ length: 2000 }, (_, i) => ({
      ...user({ id: i + 1, username: `player_${i + 1}` }),
      total_deposits: 500, total_wagers: 200, is_online: i < 3
    }));
    component.pendingWithdrawalsList = Array.from({ length: 1142 }, (_, i) => ({
      id: i + 1, user_id: i + 1, username: `player_${i + 1}`, amount: 50,
      user_current_balance: 100, user_total_deposits: 500, user_total_wagers: 200,
      status: 'pending', is_online: false, created_at: '2026-10-05T07:40:25.000Z'
    } as PendingWithdrawal));
    expect(component.visibleActiveUsers).toHaveLength(25);
    expect(component.visiblePendingWithdrawals).toHaveLength(25);
    expect(component.activeUserTotalPages).toBe(80);
    expect(component.withdrawalTotalPages).toBe(46);
    const visible = component.visibleActiveUsers;
    expect(component.visibleActiveUsers).toBe(visible);
    component.changeActiveUserPage(1);
    component.changeWithdrawalPage(1);
    expect(component.visibleActiveUsers[0].id).toBe(26);
    expect(component.visiblePendingWithdrawals[0].id).toBe(26);
    component.changeWithdrawalPage(100);
    expect(component.visiblePendingWithdrawals).toHaveLength(17);
    expect(component.visiblePendingWithdrawals.at(-1)?.id).toBe(1142);
  });

  it('searches the entire player list and resets the page when phone or presence filters change', () => {
    component.activeUsersList = Array.from({ length: 2000 }, (_, i) => ({
      ...user({ id: i + 1, username: `player_${i + 1}`, phone_number: '07' + String(i + 1).padStart(8, '0') }),
      total_deposits: 500, total_wagers: 200, is_online: i < 3
    }));
    component.changeActiveUserPage(20);
    component.activeUserSearchQuery = '+254 700 002 000';
    component.resetActiveUserPage();
    expect(component.visibleActiveUsers.map(row => row.id)).toEqual([2000]);
    expect(component.activeUserPage).toBe(1);
    component.activeUserSearchQuery = '';
    component.activeUserPresenceFilter = 'online';
    component.resetActiveUserPage();
    expect(component.visibleActiveUsers.map(row => row.id)).toEqual([1, 2, 3]);
  });

  it('preserves the current page during live wallet changes and clamps pages as the queue shrinks', () => {
    component.activeUsersList = Array.from({ length: 30 }, (_, i) => ({
      ...user({ id: i + 1 }), total_deposits: 500, total_wagers: 200, is_online: false
    }));
    component.changeActiveUserPage(1);
    const originalRow = component.visibleActiveUsers[0];
    socket.walletUpdated$.next({ action: 'balance_adjusted', userId: 26, balance: 900, occurredAt: 'now' });
    expect(component.activeUserPage).toBe(2);
    expect(component.visibleActiveUsers[0].balance).toBe(900);
    expect(component.trackById(0, component.visibleActiveUsers[0])).toBe(component.trackById(0, originalRow));
    component.activeUsersList = component.activeUsersList.slice(0, 10);
    expect(component.activeUserPage).toBe(1);
    expect(component.visibleActiveUsers).toHaveLength(10);
  });

  it('coalesces overlapping activity refreshes and cancels requests when leaving the component', () => {
    component.activeTab = 'active-users';
    component.fetchActiveUsers();
    const first = http.expectOne(request => request.url.endsWith('/api/admin/active-users'));
    component.fetchActiveUsers();
    component.fetchActiveUsers();
    http.expectNone(request => request.url.endsWith('/api/admin/active-users'));
    first.flush({ activeUsers: [], pendingWithdrawals: [] });
    const followUp = http.expectOne(request => request.url.endsWith('/api/admin/active-users'));
    fixture.destroy();
    expect(followUp.cancelled).toBe(true);
  });

  it('reuses fresh activity data on tab switches and reports failed refreshes', () => {
    component.fetchActiveUsers();
    http.expectOne(request => request.url.endsWith('/api/admin/active-users')).flush({ activeUsers: [], pendingWithdrawals: [] });
    component.setTab('active-users');
    http.expectNone(request => request.url.endsWith('/api/admin/active-users'));
    http.expectOne(request => request.url.endsWith('/api/admin/withdrawal-settings')).flush({ minimum_total_wager: 2500 });
    component.fetchActiveUsers();
    http.expectOne(request => request.url.endsWith('/api/admin/active-users'))
      .flush({}, { status: 503, statusText: 'Unavailable' });
    expect(component.isLoadingActiveUsers).toBe(false);
    expect(component.activeUsersError).toContain('Could not load player activity');
  });

  const onlinePlayer = (id: number) => ({
    ...user({ id, username: `player_${id}` }), phone_number: '07' + String(id).padStart(8, '0'), is_online: true
  });
  const onlineSummary = (version: number, count = 3) => ({
    onlineUsers: count, connectedPlayers: count * 2, topPlayers: count ? [onlinePlayer(1)] : [],
    version, updatedAt: '2026-10-05T12:00:00Z'
  });
  const onlineResult = (version = 1, players = [onlinePlayer(1)]) => ({
    ...onlineSummary(version, players.length), players, total: players.length, page: 1, totalPages: 1
  });

  it('opens only the bounded online-player endpoint without loading withdrawals or wager settings', () => {
    component.openOnlinePlayers();
    expect(component.activeTab).toBe('online-users');
    http.expectNone(request => request.url.endsWith('/api/admin/active-users'));
    http.expectNone(request => request.url.endsWith('/api/admin/withdrawal-settings'));
    const request = http.expectOne(request => request.url.includes('/api/admin/online-players?'));
    expect(request.request.url).toContain('pageSize=25');
    request.flush(onlineResult());
    expect(component.visibleOnlinePlayers.map(player => player.id)).toEqual([1]);
  });

  it('keeps the distinct-player count authoritative across room ticks, stale summaries and statistics responses', () => {
    socket.onlinePlayers$.next(onlineSummary(5, 3));
    socket.currentRound$.next({ onlineUsers: 1, connectedPlayers: 8 });
    socket.onlinePlayers$.next(onlineSummary(4, 9));
    component.fetchOverviewStats();
    http.expectOne(request => request.url.endsWith('/api/admin/stats')).flush({ onlineUsers: 99, connectedPlayers: 101 });
    expect(component.onlinePlayersSummary?.onlineUsers).toBe(3);
    expect(component.stats.onlineUsers).toBe(3);
    expect(component.onlinePlayersSummary?.topPlayers[0].phone_number).toBe('0700000001');
    for (let i = 0; i < 100; i++) socket.currentRound$.next({ onlineUsers: i, connectedPlayers: i });
    expect(component.stats.onlineUsers).toBe(3);
    http.expectNone(request => request.url.includes('/api/admin/online-players?'));
  });

  it('debounces online phone searches, cancels stale requests and filters cached rows immediately', () => {
    component.openOnlinePlayers();
    const first = http.expectOne(request => request.url.includes('/api/admin/online-players?'));
    component.onlinePlayerRows = [onlinePlayer(1), onlinePlayer(2)];
    component.onlineSearchQuery = '+254 700 000 002';
    component.searchOnlinePlayers();
    expect(first.cancelled).toBe(true);
    expect(component.visibleOnlinePlayers.map(player => player.id)).toEqual([2]);
    vi.advanceTimersByTime(150);
    http.expectOne(request => request.url.includes('search=%2B254%20700%20000%20002'))
      .flush(onlineResult(2, [onlinePlayer(2)]));
    expect(component.isSearchingOnlinePlayers).toBe(false);
  });

  it('removes an offline player immediately and refreshes presence without financial aggregation', () => {
    component.activeTab = 'online-users';
    component.onlinePlayerRows = [onlinePlayer(1)];
    socket.userUpdated$.next({ action: 'user_offline', userId: 1, is_online: false });
    socket.dashboardStatsUpdated$.next({ action: 'user_offline', userId: 1 });
    socket.onlinePlayers$.next(onlineSummary(2, 0));
    expect(component.visibleOnlinePlayers).toEqual([]);
    expect(component.stats.onlineUsers).toBe(0);
    vi.advanceTimersByTime(250);
    http.expectNone(request => request.url.endsWith('/api/admin/stats'));
    http.expectNone(request => request.url.endsWith('/api/admin/active-users'));
    http.expectOne(request => request.url.includes('/api/admin/online-players?')).flush(onlineResult(2, []));
  });

  it('serializes presence event bursts and cancels the follow-up online request on destruction', () => {
    component.openOnlinePlayers();
    const first = http.expectOne(request => request.url.includes('/api/admin/online-players?'));
    socket.onlinePlayers$.next(onlineSummary(2));
    socket.onlinePlayers$.next(onlineSummary(3));
    vi.advanceTimersByTime(250);
    http.expectNone(request => request.url.includes('/api/admin/online-players?'));
    first.flush(onlineResult(1));
    const followUp = http.expectOne(request => request.url.includes('/api/admin/online-players?'));
    fixture.destroy();
    expect(followUp.cancelled).toBe(true);
  });

  it('reports malformed or failed online responses inline without inventing a player list', () => {
    component.openOnlinePlayers();
    http.expectOne(request => request.url.includes('/api/admin/online-players?')).flush({});
    expect(component.onlinePlayersError).toContain('verified online-player list');
    expect(component.isLoadingOnlinePlayers).toBe(false);
    component.fetchOnlinePlayers();
    http.expectOne(request => request.url.includes('/api/admin/online-players?'))
      .flush({}, { status: 503, statusText: 'Unavailable' });
    expect(component.onlinePlayersError).toContain('could not be checked');
  });

  it('evaluates PayHero 3-tier indicator colors correctly for all threshold values', () => {
    component.payHeroBalance = 250;
    expect(component.payHeroTier).toBe('safe');
    component.payHeroBalance = 200;
    expect(component.payHeroTier).toBe('safe');
    component.payHeroBalance = 199.99;
    expect(component.payHeroTier).toBe('warning');
    component.payHeroBalance = 100;
    expect(component.payHeroTier).toBe('warning');
    component.payHeroBalance = 99.5;
    expect(component.payHeroTier).toBe('danger');
    component.payHeroBalance = 0;
    expect(component.payHeroTier).toBe('danger');
    component.payHeroBalance = null;
    expect(component.payHeroTier).toBe('unknown');
  });

  it('triggers admin notification sound on deposit initiation and completion', () => {
    const playInitiatedSpy = vi.spyOn(component, 'playDepositInitiatedSound');
    const playCompletedSpy = vi.spyOn(component, 'playDepositCompletedSound');

    socket.depositInitiated$.next({
      userId: 7,
      username: 'test_player',
      phone: '0712345678',
      amount: 1500,
      timestamp: new Date().toISOString()
    });
    expect(playInitiatedSpy).toHaveBeenCalled();

    socket.transactionUpdate$.next({
      id: 99,
      user_id: 7,
      username: 'test_player',
      type: 'deposit',
      amount: 1500,
      status: 'completed',
      created_at: new Date().toISOString()
    });
    expect(playCompletedSpy).toHaveBeenCalled();
  });

  it('pages user accounts and transactions smoothly to prevent dashboard hanging', () => {
    component.userList = Array.from({ length: 70 }, (_, i) => ({
      ...user({ id: i + 1, username: `user_${i + 1}` })
    }));
    expect(component.totalUserPages).toBe(3);
    expect(component.pagedUsers.length).toBe(25);
    expect(component.userPageStart).toBe(1);
    expect(component.userPageEnd).toBe(25);

    component.changeUserPage(1);
    expect(component.userPage).toBe(2);
    expect(component.pagedUsers.length).toBe(25);
    expect(component.userPageStart).toBe(26);
    expect(component.userPageEnd).toBe(50);

    component.transactionsList = Array.from({ length: 60 }, (_, i) => ({
      id: i + 1,
      user_id: 7,
      username: 'player',
      type: 'deposit' as const,
      amount: 100,
      status: 'completed',
      created_at: new Date().toISOString()
    }));
    expect(component.totalTxPages).toBe(3);
    expect(component.pagedTransactions.length).toBe(25);

    component.changeTxPage(1);
    expect(component.txPage).toBe(2);
    expect(component.pagedTransactions.length).toBe(25);

    component.setTab('users');
    expect(component.activeTab).toBe('users');
    component.setTab('transactions');
    expect(component.activeTab).toBe('transactions');
    http.expectOne(request => request.url.includes('/api/admin/transactions?')).flush({ transactions: component.transactionsList });
  });

  it('claims without a PIN and prevents superadmin from reclaiming another initial', () => {
    const tx: any = {
      id: 501,
      user_id: 7,
      username: 'player',
      type: 'deposit',
      amount: 2500,
      status: 'completed',
      admin_tag: null,
      created_at: new Date().toISOString()
    };
    component.transactionsList = [tx];

    component.claimTransactionTag(tx, 'S');
    expect(component.pinDialogOpen).toBe(false);
    http.expectNone(r => r.url.endsWith('/api/admin/pin/unlock'));
    const flushPhoneRefresh = () => {
      http.expectOne(r => r.url.endsWith('/api/admin/overview')).flush({ users: [], stats: {}, logs: [] });
      http.expectOne(r => r.url.endsWith('/api/admin/support/tickets')).flush({ tickets: [] });
      http.expectOne(r => r.url.endsWith('/api/admin/online-players/summary')).flush({ onlineUsers: 0, connectedPlayers: 0, topPlayers: [], version: 0 });
    };
    expect(tx.admin_tag).toBe('S');

    const req = http.expectOne(r => r.url.endsWith('/api/admin/transactions/501/claim-tag'));
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ tag: 'S' });
    expect(req.request.headers.has('X-Admin-Pin')).toBe(false);
    req.flush({ message: 'Claimed', transactionId: 501, tag: 'S' });
    flushPhoneRefresh();

    expect(tx.admin_tag).toBe('S');

    // Attempting to claim again does nothing (immutable)
    component.claimTransactionTag(tx, 'G');
    expect(tx.admin_tag).toBe('S');
    http.expectNone(r => r.url.endsWith('/api/admin/transactions/501/claim-tag'));
  });

  it('keeps the ledger stable and completes a claim when the live event arrives before its HTTP response', () => {
    component.activeTab = 'transactions';
    const tx: any = { id: 501, user_id: 7, username: '0712345678', phone_number: '0712345678',
      type: 'deposit', amount: 500, status: 'completed', admin_tag: null, created_at: 'now' };
    component.transactionsList = [tx];
    socket.connect.mockClear();
    socket.disconnect.mockClear();
    component.claimTransactionTag(tx, 'R');
    const claim = http.expectOne(r => r.url.endsWith('/api/admin/transactions/501/claim-tag'));
    socket.clientClaimed$.next({ userId: 7, tag: 'R', transactionId: 501 });
    expect(component.transactionsList.length).toBe(1);
    expect(component.transactionsList[0].admin_tag).toBe('R');
    expect(component.transactionsList[0].phone_number).toBe('071*****78');
    expect(component.pinDialogOpen).toBe(false);
    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(socket.connect).not.toHaveBeenCalled();
    http.expectOne(r => r.url.endsWith('/api/admin/overview')).flush({ users: [], stats: {}, logs: [] });
    http.expectOne(r => r.url.endsWith('/api/admin/support/tickets')).flush({ tickets: [] });
    http.expectOne(r => r.url.endsWith('/api/admin/online-players/summary')).flush({ onlineUsers: 0, connectedPlayers: 0, topPlayers: [], version: 0 });
    http.expectOne(r => r.url.includes('/api/admin/transactions?')).flush({ transactions: [{ ...tx, phone_number: '071*****78' }] });
    claim.flush({ message: 'Claimed', transactionId: 501, tag: 'R' });
    expect(component.claimingTagTxId).toBeNull();
    expect(component.adminToast?.message).toContain('claimed');
    http.expectNone(r => r.url.endsWith('/api/admin/overview'));
  });

  it('keeps claims PIN-free after successfully saving the four PINs', () => {
    component.pinSetupOpen = true;
    component.ownerKeyInput = 'private-key';
    component.setupPins = { R: '1357', G: '2468', S: '3690', V: '4826' };
    socket.connect.mockClear();
    socket.disconnect.mockClear();
    component.saveAdminPins();
    http.expectOne(r => r.url.endsWith('/api/admin/pin/configure')).flush({ configuredTags: ['R', 'G', 'S', 'V'] });
    expect(component.pinSetupOpen).toBe(false);
    expect(component.pinBusy).toBe(false);
    expect(socket.disconnect).not.toHaveBeenCalled();
    const tx: any = { id: 502, user_id: 8, type: 'deposit', status: 'completed', admin_tag: null };
    component.claimTransactionTag(tx, 'G');
    expect(component.pinDialogOpen).toBe(false);
    const claim = http.expectOne(r => r.url.endsWith('/api/admin/transactions/502/claim-tag'));
    expect(claim.request.headers.has('X-Admin-Pin')).toBe(false);
    claim.flush({ transactionId: 502, tag: 'G' }, { status: 500, statusText: 'Error' });
    expect(component.claimingTagTxId).toBeNull();
    expect(tx.admin_tag).toBeNull();
  });

  it('prompts a customer on their existing number or a changed number and updates balance when confirmed', () => {
    const customer = user({ id: 42, username: '+254781925732', phone_number: '+254781925732', balance: 1250 });
    component.userList = [customer];
    component.transactionsList = [];

    component.openPromptForCustomer(customer, 500);
    expect(component.activeTab).toBe('prompt');
    expect(component.promptTargetUser?.id).toBe(42);
    expect(component.promptPhoneMode).toBe('existing');
    expect(component.promptPhoneInput).toBe('+254781925732');
    expect(component.promptAmount).toBe(500);

    http.expectOne(r => r.url.endsWith('/api/admin/payment-gateway')).flush({
      activeGateway: 'payhero',
      gateways: [{ id: 'payhero', name: 'PayHero', configured: true }, { id: 'nexuspay', name: 'Nexus Pay', configured: true }]
    });
    http.expectOne(r => r.url.endsWith('/api/admin/deposit-settings')).flush({ minimum_deposit: 199 });
    http.expectOne(r => r.url.endsWith('/api/admin/payhero/balance')).flush({
      configured: true, balance: 450, accountId: 12571, updatedAt: '2026-11-21T12:00:00.000Z'
    });
    http.expectOne(r => r.url.includes('/api/admin/transactions?')).flush({ transactions: [] });

    // Change phone number if needed
    component.onPromptPhoneInputChange('0710714498');
    expect(component.promptPhoneMode).toBe('custom');

    component.submitAdminPrompt();
    expect(component.adminPromptStatus).toBe('sending');

    const promptReq = http.expectOne(r => r.url.endsWith('/api/admin/payment-prompt'));
    expect(promptReq.request.body).toEqual({ userId: 42, phone: '0710714498', amount: 500 });
    promptReq.flush({
      success: true,
      message: 'STK push sent.',
      checkoutRequestId: 'ws_CO_42',
      activeGateway: 'payhero',
      amount: 500,
      promptedPhone: '254710714498',
      targetUserId: 42,
      targetUsername: '+254781925732'
    });

    expect(component.adminPromptStatus).toBe('waiting');
    http.expectOne(r => r.url.includes('/api/admin/transactions?')).flush({ transactions: [] });
    http.expectOne(r => r.url.includes('/api/admin/payhero/balance')).flush({
      configured: true, balance: 448, accountId: 12571, updatedAt: '2026-11-21T12:00:05.000Z'
    });

    // Poll status and confirm deposit
    component.pollAdminPromptStatusNow();
    const statusReq = http.expectOne(r => r.url.endsWith('/api/admin/payment-prompt/status'));
    expect(statusReq.request.body).toEqual({ checkoutRequestId: 'ws_CO_42' });
    statusReq.flush({
      status: 'completed',
      receiptNumber: 'UKK5D2RP21',
      balance: 1750,
      targetUserId: 42,
      targetUsername: '+254781925732'
    });

    expect(component.adminPromptStatus).toBe('completed');
    expect(component.adminPromptReceipt).toBe('UKK5D2RP21');
    expect(component.userList[0].balance).toBe(1750);
    expect(component.promptTargetUser?.balance).toBe(1750);
    http.expectOne(r => r.url.includes('/api/admin/transactions?')).flush({ transactions: [] });
    http.expectOne(r => r.url.endsWith('/api/admin/stats')).flush({ totalDeposits: 500 });
  });

  it('adds and removes claiming admin initials and formats failed deposit diagnostics for admins', () => {
    expect(component.allowedAdminTags).toEqual(['S', 'G', 'R', 'V']);

    component.newClaimAdminTag = 'm';
    component.addClaimAdminTag();
    const addReq = http.expectOne(r => r.url.endsWith('/api/admin/claim-tags') && r.method === 'POST');
    expect(addReq.request.body).toEqual({ tag: 'M' });
    addReq.flush({ tag: 'M', tags: ['S', 'G', 'R', 'V', 'M'], message: 'Admin initial M added.' });
    expect(component.allowedAdminTags).toEqual(['S', 'G', 'R', 'V', 'M']);
    expect(component.newClaimAdminTag).toBe('');
    const lbReqs1 = http.match(r => r.url.includes('/api/admin/leaderboard'));
    lbReqs1[lbReqs1.length - 1].flush({
      success: true, date: '2026-11-22', startDate: '2026-11-07', serverTime: 'now',
      adminTags: ['S', 'G', 'R', 'V', 'M'], totalDayClaims: 0, totalDayVolume: 0, overallAvgTicket: 0, leadingAdmin: null, scoringFormula: '', leaderboard: []
    });

    component.removeClaimAdminTag('M');
    const delReq = http.expectOne(r => r.url.endsWith('/api/admin/claim-tags/M') && r.method === 'DELETE');
    delReq.flush({ tag: 'M', tags: ['S', 'G', 'R', 'V'], message: 'Admin initial M removed.' });
    expect(component.allowedAdminTags).toEqual(['S', 'G', 'R', 'V']);
    const lbReqs2 = http.match(r => r.url.includes('/api/admin/leaderboard'));
    lbReqs2[lbReqs2.length - 1].flush({
      success: true, date: '2026-11-22', startDate: '2026-11-07', serverTime: 'now',
      adminTags: ['S', 'G', 'R', 'V'], totalDayClaims: 0, totalDayVolume: 0, overallAvgTicket: 0, leadingAdmin: null, scoringFormula: '', leaderboard: []
    });

    expect(component.getDepositDiagnosticTitle({
      category: 'provider_funds', label: 'Gateway insufficient funds', provider: 'payhero', code: null, detail: 'Low service wallet balance'
    })).toBe('PayHero insufficient funds');
    expect(component.getDepositDiagnosticTitle({
      category: 'customer_blocked', label: 'Customer blocked', provider: 'nexuspay', code: null, detail: 'Blacklisted'
    })).toBe('Blocked by Nexus');
    expect(component.getDepositDiagnosticTitle({
      category: 'wrong_pin', label: 'Wrong PIN', provider: 'payhero', code: '2001', detail: 'Wrong PIN'
    })).toBe('Wrong PIN');
    expect(component.getDepositDiagnosticTitle({
      category: 'customer_funds', label: 'Insufficient funds', provider: 'payhero', code: '1', detail: 'Balance is insufficient'
    })).toBe('Insufficient funds');

    // Ordinary admins cannot add or remove claiming admin initials
    auth.currentUser$.next({ id: 2, username: 'ordinary-admin', balance: 0, role: 'admin' });
    component.newClaimAdminTag = 'Z';
    component.addClaimAdminTag();
    component.removeClaimAdminTag('V');
    http.expectNone(r => r.url.includes('/api/admin/claim-tags'));
  });

  it('loads, toggles, and saves uniform automated chat support settings and tokenizes links safely', () => {
    // Ordinary admins can also manage automated chat support
    auth.currentUser$.next({ id: 2, username: 'ordinary-admin', balance: 0, role: 'admin' });
    component.setTab('support');

    http.expectOne(r => r.url.endsWith('/api/admin/support/tickets')).flush({ tickets: [] });
    const getReq = http.expectOne(r => r.method === 'GET' && r.url.endsWith('/api/admin/support/automation'));
    getReq.flush({
      settings: {
        enabled: false,
        wager_activation_message: 'Deposit KES {amount}. Type .start.',
        start_amount_mode: 'fixed',
        start_fixed_amount: 1500,
        start_prompt_message: 'Prompt of KES {amount} sent.',
        link_url: 'https://t.me/help',
        link_message: 'Open: {link}'
      }
    });
    expect(component.automatedSupportSettings.enabled).toBe(false);
    expect(component.automatedSupportSettings.start_fixed_amount).toBe(1500);
    expect(component.getAutomatedWagerPreview()).toBe('Deposit KES 1,500. Type .start.');
    expect(component.hasAmountPlaceholder(component.automatedSupportSettings.wager_activation_message)).toBe(true);

    component.automatedSupportSettings.start_fixed_amount = 3500;
    expect(component.getAutomatedWagerPreview()).toBe('Deposit KES 3,500. Type .start.');

    component.toggleAutomatedSupportEnabled();
    const putReq = http.expectOne(r => r.method === 'PUT' && r.url.endsWith('/api/admin/support/automation'));
    expect(putReq.request.body.enabled).toBe(true);
    expect(putReq.request.body.start_amount_mode).toBe('fixed');
    expect(putReq.request.body.start_fixed_amount).toBe(3500);
    expect(putReq.request.body.link_url).toBe('https://t.me/help');
    putReq.flush({
      message: 'Automated chat support enabled and settings saved.',
      settings: { ...putReq.request.body }
    });
    expect(component.automatedSupportSettings.enabled).toBe(true);

    const segments = component.tokenizeSupportMessage('Visit https://example.com/help now.');
    expect(segments).toEqual([
      { text: 'Visit ' },
      { text: 'https://example.com/help', url: 'https://example.com/help' },
      { text: ' now.' }
    ]);
  });
});
