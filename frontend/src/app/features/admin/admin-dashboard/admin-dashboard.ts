import { Component, OnDestroy, OnInit, ChangeDetectorRef, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { Subscription, finalize, timeout } from 'rxjs';
import {
  AdminHistoryRow,
  AdminParticipant,
  AdminRoomStatus,
  AdminSocketService
} from '../../../core/services/admin-socket.service';
import { getBackendOrigin } from '../../../core/config/backend-url';
import { AuthService } from '../../../core/services/auth.service';
import { AviatorGameComponent } from '../../game/aviator/aviator-game.component';
import { SanitizedModeService } from '../../../core/services/sanitized-mode.service';

export interface AdminUser {
  id: number;
  username: string;
  phone_number?: string;
  balance: number;
  role: string;
  is_suspended: boolean;
  created_at: string;
  has_custom_withdrawal_popup?: boolean;
  custom_withdrawal_title?: string;
  custom_withdrawal_message?: string;
}

export interface AdminTransaction {
  id: number;
  user_id: number;
  username: string;
  phone_number?: string;
  type: 'deposit' | 'withdrawal';
  amount: number;
  status: 'completed' | 'failed' | 'pending';
  reference?: string;
  created_at: string;
}

export interface AdminLog {
  id: number;
  action: string;
  details: string;
  admin_username: string;
  created_at: string;
}

export interface ActiveUser {
  id: number;
  username: string;
  phone_number?: string;
  balance: number;
  role: string;
  is_suspended: boolean;
  total_deposits: number;
  total_wagers: number;
  has_custom_withdrawal_popup?: boolean;
  custom_withdrawal_title?: string;
  custom_withdrawal_message?: string;
  is_online: boolean;
  created_at: string;
}

export interface PendingWithdrawal {
  id: number;
  user_id: number;
  username: string;
  phone_number?: string;
  user_current_balance: number;
  balance?: number;
  amount: number;
  payment_method: string;
  account_details: string;
  status: string;
  user_total_deposits: number;
  total_deposits?: number;
  user_total_wagers: number;
  total_wagers?: number;
  has_custom_withdrawal_popup?: boolean;
  custom_withdrawal_title?: string;
  custom_withdrawal_message?: string;
  is_online: boolean;
  created_at: string;
}

@Component({
  selector: 'app-admin-dashboard',
  standalone: true,
  imports: [CommonModule, FormsModule, AviatorGameComponent],
  templateUrl: './admin-dashboard.html',
  styleUrl: './admin-dashboard.css'
})
export class AdminDashboardComponent implements OnInit, OnDestroy {
  private adminSocket = inject(AdminSocketService);
  private authService = inject(AuthService);
  public sanitizedMode = inject(SanitizedModeService);
  private http = inject(HttpClient);
  private router = inject(Router);
  private cdr = inject(ChangeDetectorRef);

  public toggleSanitizedMode(): void {
    this.sanitizedMode.toggleSanitizedMode();
    const next = this.sanitizedMode.isSanitizedMode();
    this.showAdminToast(
      next ? '🛡️ Sanitized View Mode activated for Game tab' : 'Normal View Mode restored for Game tab',
      next ? 'success' : 'info'
    );
  }

  public activeTab: 'game' | 'monitor' | 'withdrawal-settings' | 'active-users' | 'transactions' | 'users' | 'admins' | 'logs' = 'monitor';
  public mobileMenuOpen: boolean = false;
  public selectedMiniRoom: number = 1;

  public switchMiniRoom(room: number): void {
    if (room === 1 || room === 2 || room === 3) {
      this.selectedMiniRoom = room;
      this.cdr.markForCheck();
    }
  }

  public nextRound$ = this.adminSocket.nextRound$;
  public previousRound$ = this.adminSocket.previousRound$;
  public currentRound$ = this.adminSocket.currentRound$;
  public history$ = this.adminSocket.history$;
  public isConnected$ = this.adminSocket.isConnected$;
  public error$ = this.adminSocket.error$;

  // Overview Stats
  public stats = {
    totalUsers: 0,
    totalBets: 0,
    totalVolume: 0,
    totalPayout: 0,
    totalDeposits: 0,
    totalWithdrawals: 0,
    connectedPlayers: 0,
    onlineUsers: 0
  };

  // Active Users & Withdrawal Wager State
  public activeUsersList: ActiveUser[] = [];
  public pendingWithdrawalsList: PendingWithdrawal[] = [];
  public isLoadingActiveUsers: boolean = false;
  public withdrawalWagerRequirement: number = 2500;
  public withdrawalInitiationTitle: string = 'Withdrawal Notice';
  public withdrawalInitiationMessage: string = 'Your withdrawal request has been received and is awaiting review.';
  public isSavingWithdrawalWagerRequirement: boolean = false;
  public minimumDepositAmount: number = 999;
  public isSavingMinimumDeposit: boolean = false;

  // Crash Point Override State
  public customCrashPoint: number = 2.00;
  public isOverridingCrash: boolean = false;
  public overrideSuccessMsg: string | null = null;

  // Reset Total Deposits State
  public showResetDepositsModal: boolean = false;
  public isResettingDeposits: boolean = false;
  public resetDepositsSuccess: boolean = false;

  // Custom Notification Modal State
  public showNotifyModal: boolean = false;
  public selectedUserForNotif: ActiveUser | PendingWithdrawal | AdminUser | null = null;
  public selectedWithdrawalId: number | null = null;
  public notifActionType: 'complete' | 'reject' | 'custom' = 'complete';
  public notifTitle: string = '';
  public notifMessage: string = '';
  public isSendingNotif: boolean = false;

  // Premium In-App Confirmation Dialog State
  public confirmModal = {
    isOpen: false,
    title: '',
    message: '',
    confirmText: 'Confirm',
    cancelText: 'Cancel',
    type: 'primary' as 'danger' | 'warning' | 'primary',
    onConfirm: () => {}
  };

  // Premium In-App Prompt Dialog State
  public promptModal = {
    isOpen: false,
    title: '',
    message: '',
    placeholder: '',
    value: '',
    inputType: 'text',
    confirmText: 'Submit',
    onConfirm: (val: string) => {}
  };

  // Premium In-App Floating Glass Toast State
  public adminToast: {
    isOpen: boolean;
    title: string;
    message: string;
    type: 'success' | 'error' | 'info';
  } | null = null;
  private toastTimeout: any = null;

  public showAdminToast(message: string, type: 'success' | 'error' | 'info' = 'success', title?: string): void {
    if (this.toastTimeout) clearTimeout(this.toastTimeout);
    this.adminToast = {
      isOpen: true,
      title: title || (type === 'success' ? 'Success' : (type === 'error' ? 'Error' : 'Notice')),
      message,
      type
    };
    this.toastTimeout = setTimeout(() => {
      this.adminToast = null;
    }, 4000);
  }

  public openConfirmDialog(config: {
    title: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    type?: 'danger' | 'warning' | 'primary';
    onConfirm: () => void;
  }): void {
    this.confirmModal = {
      isOpen: true,
      title: config.title,
      message: config.message,
      confirmText: config.confirmText || 'Confirm',
      cancelText: config.cancelText || 'Cancel',
      type: config.type || 'primary',
      onConfirm: config.onConfirm
    };
  }

  public closeConfirmDialog(confirmed: boolean): void {
    if (confirmed && this.confirmModal.onConfirm) {
      this.confirmModal.onConfirm();
    }
    this.confirmModal.isOpen = false;
  }

  public openPromptDialog(config: {
    title: string;
    message: string;
    placeholder?: string;
    defaultValue?: string;
    inputType?: string;
    confirmText?: string;
    onConfirm: (val: string) => void;
  }): void {
    this.promptModal = {
      isOpen: true,
      title: config.title,
      message: config.message,
      placeholder: config.placeholder || '',
      value: config.defaultValue || '',
      inputType: config.inputType || 'text',
      confirmText: config.confirmText || 'Submit',
      onConfirm: config.onConfirm
    };
  }

  public closePromptDialog(confirmed: boolean): void {
    if (confirmed && this.promptModal.onConfirm) {
      this.promptModal.onConfirm(this.promptModal.value);
    }
    this.promptModal.isOpen = false;
  }


  // Transactions State
  public transactionsList: AdminTransaction[] = [];
  public txTypeFilter: 'deposit' | 'withdrawal' = 'deposit';
  public txSearchQuery: string = '';
  public txStatusFilter: string = 'all';
  public isLoadingTransactions: boolean = false;
  private transactionRequestVersion = 0;
  private realtimeSubscriptions: Subscription[] = [];
  private realtimeRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingRealtimeRefresh = {
    dashboard: false,
    transactions: false,
    users: false,
    admins: false,
    activeUsers: false,
    logs: false,
    withdrawalSettings: false
  };

  // User Management State
  public userList: AdminUser[] = [];
  public searchQuery: string = '';
  public roleFilter: string = 'all';
  public isLoadingUsers: boolean = false;

  // Admins List & New Admin Form State
  public adminsList: AdminUser[] = [];
  public isLoadingAdmins: boolean = false;
  public showCreateAdminModal: boolean = false;
  public newAdminUsername: string = '';
  public newAdminPhone: string = '';
  public newAdminPassword: string = '';

  // Role change loading state (per user id)
  public isSettingRole: number | null = null;

  // Admin Logs State
  public adminLogs: AdminLog[] = [];

  /** True for superadmin — used to show/hide the Admins tab */
  public get isSuperAdmin(): boolean {
    const role = this.authService.currentUser$.getValue()?.role;
    return role === 'superadmin';
  }

  public ngOnInit(): void {
    const token = this.authService.getToken();
    if (!token) {
      this.router.navigate(['/login']);
      return;
    }

    // The adminGuard already verified admin/superadmin role before this component loads.
    // We only redirect if the user is explicitly set to a non-admin role (not null/loading).
    const user = this.authService.currentUser$.getValue();
    if (user && user.role !== 'admin' && user.role !== 'superadmin') {
      this.router.navigate(['/play']);
      return;
    }

    this.adminSocket.connect(token);
    this.fetchOverview();
    this.sanitizedMode.fetchStatus();
    // Load expensive lists only when their tab is opened. Previously every
    // dashboard visit fetched users, transactions, admins, logs, and settings
    // even though the monitor is the default screen.
    this.subscribeToRealtimeUpdates();
  }


  public ngOnDestroy(): void {
    this.realtimeSubscriptions.forEach(subscription => subscription.unsubscribe());
    if (this.realtimeRefreshTimer !== null) clearTimeout(this.realtimeRefreshTimer);
    this.adminSocket.disconnect();
  }

  private subscribeToRealtimeUpdates(): void {
    this.realtimeSubscriptions.push(
      this.adminSocket.transactionUpdate$.subscribe(event => {
        if (event) this.queueRealtimeRefresh({ transactions: true, dashboard: true, activeUsers: true, logs: true });
      }),
      this.adminSocket.dashboardStatsUpdated$.subscribe(event => {
        if (event) this.queueRealtimeRefresh({ dashboard: true });
      }),
      this.adminSocket.walletUpdated$.subscribe(event => {
        if (event) this.queueRealtimeRefresh({ dashboard: true, users: true, activeUsers: true });
      }),
      this.adminSocket.transactionsUpdated$.subscribe(event => {
        if (event) this.queueRealtimeRefresh({ transactions: true, dashboard: true, activeUsers: true });
      }),
      this.adminSocket.depositsUpdated$.subscribe(event => {
        if (event) this.queueRealtimeRefresh({ transactions: true, dashboard: true, activeUsers: true });
      }),
      this.adminSocket.withdrawalsUpdated$.subscribe(event => {
        if (event) this.queueRealtimeRefresh({ transactions: true, dashboard: true, activeUsers: true });
      }),
      this.adminSocket.userUpdated$.subscribe(event => {
        if (event) this.queueRealtimeRefresh({ users: true, admins: this.isSuperAdmin, activeUsers: true, dashboard: true });
      }),
      this.adminSocket.activityUpdated$.subscribe(event => {
        if (!event) return;
        this.queueRealtimeRefresh({
          logs: true,
          withdrawalSettings: event.action === 'withdrawal_settings_updated' || event.action === 'deposit_settings_updated'
        });
      })
    );
  }

  private queueRealtimeRefresh(refresh: Partial<typeof this.pendingRealtimeRefresh>): void {
    Object.assign(this.pendingRealtimeRefresh, refresh);
    if (this.realtimeRefreshTimer !== null) return;

    // A single money mutation emits several specific events. Debounce their
    // burst so a busy game cannot start overlapping table requests.
    this.realtimeRefreshTimer = setTimeout(() => {
      const requested = { ...this.pendingRealtimeRefresh };
      Object.keys(this.pendingRealtimeRefresh).forEach(key => {
        this.pendingRealtimeRefresh[key as keyof typeof this.pendingRealtimeRefresh] = false;
      });
      this.realtimeRefreshTimer = null;

      console.log(`[${new Date().toISOString()}] [PAYMENT_LOG] Admin UI updated`, requested);
      if (requested.dashboard && this.activeTab === 'monitor') this.fetchOverviewStats();
      if (requested.transactions && this.activeTab === 'transactions') this.fetchTransactions();
      if (requested.users && this.activeTab === 'users') this.fetchUsers();
      if (requested.admins && this.isSuperAdmin && this.activeTab === 'admins') this.fetchAdmins();
      if (requested.activeUsers && this.activeTab === 'active-users') this.fetchActiveUsers();
      if (requested.logs && this.activeTab === 'logs') this.fetchLogs();
      if (requested.withdrawalSettings && this.activeTab === 'withdrawal-settings') this.fetchWithdrawalSettings();
      if (requested.withdrawalSettings && this.activeTab === 'withdrawal-settings') this.fetchDepositSettings();
    }, 500);
  }

  public toggleMobileMenu(): void {
    this.mobileMenuOpen = !this.mobileMenuOpen;
  }

  public setTab(tab: 'game' | 'monitor' | 'withdrawal-settings' | 'active-users' | 'transactions' | 'users' | 'admins' | 'logs'): void {
    // Admins tab is superadmin-only
    if (tab === 'admins' && !this.isSuperAdmin) return;
    this.activeTab = tab;
    this.mobileMenuOpen = false;
    // Rows already held render immediately and a refresh only goes out once the
    // data has aged, so switching tabs no longer waits on a network round trip.
    if (tab === 'monitor' && this.isStale('dashboard')) this.fetchOverviewStats();
    if (tab === 'withdrawal-settings') this.fetchWithdrawalSettings();
    if (tab === 'withdrawal-settings') this.fetchDepositSettings();
    if (tab === 'active-users') {
      this.fetchActiveUsers();
      this.fetchWithdrawalSettings();
    }
    if (tab === 'transactions' && this.isStale('transactions')) this.fetchTransactions();
    if (tab === 'users' && this.isStale('users')) this.fetchUsers();
    if (tab === 'admins' && this.isStale('admins')) this.fetchAdmins();
    if (tab === 'logs' && this.isStale('logs')) this.fetchLogs();
  }

  private get baseUrl(): string {
    return getBackendOrigin();
  }

  public fetchActiveUsers(): void {
    const token = this.authService.getToken();
    if (!token) return;

    this.isLoadingActiveUsers = true;
    this.http.get<{ activeUsers: ActiveUser[]; pendingWithdrawals: PendingWithdrawal[] }>(
      `${this.baseUrl}/api/admin/active-users`,
      { headers: { Authorization: `Bearer ${token}` } }
    ).subscribe({
      next: (res) => {
        this.activeUsersList = res.activeUsers || [];
        this.pendingWithdrawalsList = res.pendingWithdrawals || [];
        this.isLoadingActiveUsers = false;
      },
      error: () => {
        this.isLoadingActiveUsers = false;
      }
    });
  }

  public fetchWithdrawalSettings(): void {
    const token = this.authService.getToken();
    if (!token) return;

    this.http.get<{ minimum_total_wager: number; initiation_title: string; initiation_message: string }>(
      `${this.baseUrl}/api/admin/withdrawal-settings`,
      { headers: { Authorization: `Bearer ${token}` } }
    ).subscribe({
      next: (res) => {
        this.withdrawalWagerRequirement = Number(res.minimum_total_wager) || 0;
        this.withdrawalInitiationTitle = res.initiation_title || this.withdrawalInitiationTitle;
        this.withdrawalInitiationMessage = res.initiation_message || this.withdrawalInitiationMessage;
      }
    });
  }

  public fetchDepositSettings(): void {
    const token = this.authService.getToken();
    if (!token) return;

    this.http.get<{ minimum_deposit: number }>(
      `${this.baseUrl}/api/admin/deposit-settings`,
      { headers: { Authorization: `Bearer ${token}` } }
    ).subscribe({
      next: (res) => {
        this.minimumDepositAmount = Number(res.minimum_deposit) || this.minimumDepositAmount;
        this.cdr.markForCheck();
      }
    });
  }

  public saveMinimumDeposit(): void {
    const minimumDeposit = Math.round(Number(this.minimumDepositAmount));
    if (!Number.isFinite(minimumDeposit) || minimumDeposit < 1) {
      this.showAdminToast('Enter a minimum deposit of at least KES 1.', 'error');
      return;
    }
    if (minimumDeposit > 1000000) {
      this.showAdminToast('Minimum deposit cannot exceed KES 1,000,000.', 'error');
      return;
    }

    const token = this.authService.getToken();
    if (!token) return;

    if (this.isSavingMinimumDeposit) return;
    this.isSavingMinimumDeposit = true;
    this.http.put<{ minimum_deposit: number }>(
      `${this.baseUrl}/api/admin/deposit-settings`,
      { minimum_deposit: minimumDeposit },
      { headers: { Authorization: `Bearer ${token}` } }
    ).pipe(
      timeout(8000),
      finalize(() => {
        this.isSavingMinimumDeposit = false;
        this.cdr.markForCheck();
      })
    ).subscribe({
      next: (res) => {
        this.minimumDepositAmount = Number(res.minimum_deposit);
        this.showAdminToast(`Minimum deposit set to KES ${this.minimumDepositAmount.toLocaleString()}.`, 'success');
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.showAdminToast(err?.error?.error || 'Failed to save the minimum deposit.', 'error');
        this.cdr.markForCheck();
      }
    });
  }

  public saveWithdrawalWagerRequirement(): void {
    const minimumTotalWager = Number(this.withdrawalWagerRequirement);
    if (!Number.isFinite(minimumTotalWager) || minimumTotalWager < 0) {
      alert('Enter a wager requirement of zero or more.');
      return;
    }
    if (!this.withdrawalInitiationTitle.trim() || !this.withdrawalInitiationMessage.trim()) {
      alert('Enter both a popup title and a popup message.');
      return;
    }

    const token = this.authService.getToken();
    if (!token) return;

    if (this.isSavingWithdrawalWagerRequirement) return;
    this.isSavingWithdrawalWagerRequirement = true;
    this.http.put<{ minimum_total_wager: number; initiation_title: string; initiation_message: string }>(
      `${this.baseUrl}/api/admin/withdrawal-settings`,
      {
        minimum_total_wager: minimumTotalWager,
        initiation_title: this.withdrawalInitiationTitle,
        initiation_message: this.withdrawalInitiationMessage
      },
      { headers: { Authorization: `Bearer ${token}` } }
    ).pipe(
      timeout(8000),
      finalize(() => {
        this.isSavingWithdrawalWagerRequirement = false;
        this.cdr.markForCheck();
      })
    ).subscribe({
      next: (res) => {
        this.withdrawalWagerRequirement = Number(res.minimum_total_wager);
        this.withdrawalInitiationTitle = res.initiation_title;
        this.withdrawalInitiationMessage = res.initiation_message;
        this.showAdminToast('Withdrawal settings and popup template saved.', 'success');
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.showAdminToast(err?.error?.error || 'Failed to save withdrawal wager requirement.', 'error');
        this.cdr.markForCheck();
      }
    });
  }

  public openWithdrawalModal(wd: PendingWithdrawal, action: 'complete' | 'reject'): void {
    const isReject = action === 'reject';
    this.openConfirmDialog({
      title: isReject ? 'Reject Withdrawal' : 'Complete Withdrawal',
      message: `Are you sure you want to ${action} withdrawal #${wd.id} for player "${wd.username}" (${wd.amount} KES)?`,
      confirmText: isReject ? 'Reject Withdrawal' : 'Complete Withdrawal',
      type: isReject ? 'danger' : 'primary',
      onConfirm: () => this.processWithdrawal(wd.id, action)
    });
  }

  private processWithdrawal(withdrawalId: number, action: 'complete' | 'reject'): void {
    const token = this.authService.getToken();
    if (!token || this.isSendingNotif) return;

    this.isSendingNotif = true;
    this.http.post<{ message: string; status: string }>(
      `${this.baseUrl}/api/admin/withdrawals/process`,
      { withdrawal_id: withdrawalId, action },
      { headers: { Authorization: `Bearer ${token}` } }
    ).pipe(
      timeout(8000),
      finalize(() => {
        this.isSendingNotif = false;
        this.cdr.markForCheck();
      })
    ).subscribe({
      next: (res) => {
        this.showAdminToast(res.message, 'success');
        this.fetchActiveUsers();
        this.fetchOverviewStats();
        this.invalidate('logs');
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.showAdminToast(err?.error?.error || 'Failed to process withdrawal.', 'error');
        this.cdr.markForCheck();
      }
    });
  }

  public openPlayerWithdrawalPopupModal(user: ActiveUser | AdminUser): void {
    // Never inherit an in-flight flag from a previous attempt. If anything ever
    // left this set — closing the modal mid-request, an early return, a failed
    // send — the button opened reading "Saving..." and stayed that way for the
    // life of the console, which is what made it look permanently hung.
    this.isSendingNotif = false;
    this.selectedUserForNotif = user;
    this.selectedWithdrawalId = null;
    this.notifActionType = 'custom';
    this.notifTitle = user.custom_withdrawal_title || this.withdrawalInitiationTitle || 'Withdrawal Notice';
    this.notifMessage = user.custom_withdrawal_message || this.withdrawalInitiationMessage || 'Please review your withdrawal requirements before proceeding.';
    this.showNotifyModal = true;
  }

  /**
   * Flips the popup state on the row in both lists so the badge updates without
   * a round trip. The save previously refreshed only the active-users list,
   * which is no longer where this control lives.
   */
  private applyPopupStateLocally(userId: number, enabled: boolean, title: string, message: string): void {
    const patch = (row: { id: number } & Record<string, any>) => {
      if (row.id !== userId && row['user_id'] !== userId) return;
      row['has_custom_withdrawal_popup'] = enabled;
      row['custom_withdrawal_title'] = enabled ? title : undefined;
      row['custom_withdrawal_message'] = enabled ? message : undefined;
    };
    this.userList.forEach(patch);
    this.activeUsersList.forEach(patch);
    if (this.activeTab === 'active-users') this.fetchActiveUsers();
  }

  public savePersonalWithdrawalPopup(enabled: boolean = true): void {
    // A second click while the first request is in flight would save twice.
    if (this.isSendingNotif) return;
    if (!this.selectedUserForNotif) return;
    const token = this.authService.getToken();
    if (!token) return;

    const targetUserId = (this.selectedUserForNotif as any).user_id || (this.selectedUserForNotif as any).id;
    if (!targetUserId) {
      this.showAdminToast('Could not determine target user ID.', 'error');
      return;
    }

    const title = this.notifTitle.trim();
    const message = this.notifMessage.trim();

    this.isSendingNotif = true;
    this.http.post<{ success: boolean; message: string }>(
      `${this.baseUrl}/api/admin/users/${targetUserId}/withdrawal-popup`,
      { title, message, enabled },
      { headers: { Authorization: `Bearer ${token}` } }
    ).pipe(
      // Guarantees the button leaves its "Saving..." state on success, error,
      // cancellation, or timeout, rather than relying on handlers to remember.
      timeout(8000),
      finalize(() => {
        this.isSendingNotif = false;
        this.cdr.markForCheck();
      })
    ).subscribe({
      next: (res) => {
        this.showAdminToast(res.message, 'success');
        this.applyPopupStateLocally(targetUserId, enabled, title, message);
        this.closeNotifyModal();
        this.invalidate('logs');
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.showAdminToast(err?.error?.error || 'Failed to save personal withdrawal popup.', 'error');
        this.cdr.markForCheck();
      }
    });
  }

  public clearPersonalWithdrawalPopup(): void {
    if (this.isSendingNotif) return;
    if (!this.selectedUserForNotif) return;
    const token = this.authService.getToken();
    if (!token) return;

    const targetUserId = (this.selectedUserForNotif as any).user_id || (this.selectedUserForNotif as any).id;
    if (!targetUserId) return;

    this.isSendingNotif = true;
    this.http.post<{ success: boolean; message: string }>(
      `${this.baseUrl}/api/admin/users/${targetUserId}/withdrawal-popup`,
      { enabled: false },
      { headers: { Authorization: `Bearer ${token}` } }
    ).pipe(
      timeout(8000),
      finalize(() => {
        this.isSendingNotif = false;
        this.cdr.markForCheck();
      })
    ).subscribe({
      next: (res) => {
        this.showAdminToast(res.message, 'success');
        this.applyPopupStateLocally(targetUserId, false, '', '');
        this.closeNotifyModal();
        this.invalidate('logs');
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.showAdminToast(err?.error?.error || 'Failed to clear personal withdrawal popup.', 'error');
        this.cdr.markForCheck();
      }
    });
  }

  public closeNotifyModal(): void {
    this.showNotifyModal = false;
    this.isSendingNotif = false;
    this.selectedUserForNotif = null;
    this.selectedWithdrawalId = null;
    this.notifTitle = '';
    this.notifMessage = '';
  }

  public getSelectedUserBalance(): number {
    if (!this.selectedUserForNotif) return 0;
    if ('balance' in this.selectedUserForNotif && this.selectedUserForNotif.balance !== undefined) {
      return this.selectedUserForNotif.balance;
    }
    if ('user_current_balance' in this.selectedUserForNotif) {
      return this.selectedUserForNotif.user_current_balance;
    }
    return 0;
  }

  public getSelectedUserDeposits(): number {
    if (!this.selectedUserForNotif) return 0;
    if ('total_deposits' in this.selectedUserForNotif && this.selectedUserForNotif.total_deposits !== undefined) {
      return this.selectedUserForNotif.total_deposits;
    }
    if ('user_total_deposits' in this.selectedUserForNotif) {
      return this.selectedUserForNotif.user_total_deposits;
    }
    return 0;
  }

  public getSelectedUserWagers(): number {
    if (!this.selectedUserForNotif) return 0;
    if ('total_wagers' in this.selectedUserForNotif && this.selectedUserForNotif.total_wagers !== undefined) {
      return this.selectedUserForNotif.total_wagers;
    }
    if ('user_total_wagers' in this.selectedUserForNotif) {
      return this.selectedUserForNotif.user_total_wagers;
    }
    return 0;
  }

  public isSelectedUserCustomPopupActive(): boolean {
    if (!this.selectedUserForNotif) return false;
    return Boolean(this.selectedUserForNotif.has_custom_withdrawal_popup);
  }

  public submitNotificationAction(): void {
    if (!this.selectedUserForNotif || !this.notifMessage.trim()) {
      this.showAdminToast('Please enter a message to send.', 'error');
      return;
    }

    const token = this.authService.getToken();
    if (!token) return;

    this.isSendingNotif = true;

    if (this.selectedWithdrawalId !== null && (this.notifActionType === 'complete' || this.notifActionType === 'reject')) {
      // Process Pending Withdrawal
      this.http.post<{ message: string; status: string }>(
        `${this.baseUrl}/api/admin/withdrawals/process`,
        {
          withdrawal_id: this.selectedWithdrawalId,
          action: this.notifActionType,
          custom_title: this.notifTitle,
          custom_message: this.notifMessage
        },
        { headers: { Authorization: `Bearer ${token}` } }
      ).pipe(
        timeout(8000),
        finalize(() => {
          this.isSendingNotif = false;
          this.cdr.markForCheck();
        })
      ).subscribe({
        next: (res) => {
          this.showAdminToast(`${res.message}. Notification sent to player.`, 'success');
          this.closeNotifyModal();
          this.fetchActiveUsers();
          this.fetchOverviewStats();
          this.invalidate('logs');
          this.cdr.markForCheck();
        },
        error: (err) => {
          this.showAdminToast(err?.error?.error || 'Failed to process withdrawal.', 'error');
          this.cdr.markForCheck();
        }
      });
    } else {
      // Send Direct Custom Pop-Up Notification to Active Player
      const targetUserId = (this.selectedUserForNotif as any).user_id || (this.selectedUserForNotif as any).id;
      if (!targetUserId) {
        this.showAdminToast('Could not determine target user ID.', 'error');
        this.isSendingNotif = false;
        this.cdr.markForCheck();
        return;
      }

      this.http.post<{ message: string }>(
        `${this.baseUrl}/api/admin/notifications/send`,
        {
          target_user_id: targetUserId,
          title: this.notifTitle || 'Withdrawal Notice',
          message: this.notifMessage
        },
        { headers: { Authorization: `Bearer ${token}` } }
      ).pipe(
        timeout(8000),
        finalize(() => {
          this.isSendingNotif = false;
          this.cdr.markForCheck();
        })
      ).subscribe({
        next: (res) => {
          this.showAdminToast('Notification delivered live to player screen.', 'success');
          this.closeNotifyModal();
          this.invalidate('logs');
          this.cdr.markForCheck();
        },
        error: (err) => {
          this.showAdminToast(err?.error?.error || 'Failed to send notification.', 'error');
          this.cdr.markForCheck();
        }
      });
    }
  }

  /** When each table was last filled, so a tab switch need not re-query. */
  private lastLoadedAt: Record<string, number> = {};
  private static readonly STALE_AFTER_MS = 20000;

  private isStale(key: string): boolean {
    const at = this.lastLoadedAt[key];
    return !at || (Date.now() - at) > AdminDashboardComponent.STALE_AFTER_MS;
  }

  /**
   * Marks a table for refresh. It only goes out now if that tab is on screen —
   * otherwise the next visit picks it up. Every mutation used to fire a logs
   * request regardless, competing with the table the admin was looking at.
   */
  private invalidate(key: 'users' | 'transactions' | 'logs' | 'admins' | 'dashboard'): void {
    this.lastLoadedAt[key] = 0;
    if (key === 'logs' && this.activeTab === 'logs') this.fetchLogs();
    if (key === 'users' && this.activeTab === 'users') this.fetchUsers();
    if (key === 'transactions' && this.activeTab === 'transactions') this.fetchTransactions();
    if (key === 'dashboard' && this.activeTab === 'monitor') this.fetchOverviewStats();
  }

  private markLoaded(...keys: string[]): void {
    const now = Date.now();
    keys.forEach(key => { this.lastLoadedAt[key] = now; });
  }

  /**
   * Fills stats, users, transactions and logs in one round trip. The tables were
   * never slow because of the database — each query measures about a tenth of a
   * second — they were slow because every tab cost its own request.
   */
  public fetchOverview(): void {
    const token = this.authService.getToken();
    if (!token) return;

    this.http.get<any>(`${this.baseUrl}/api/admin/overview`, { headers: { Authorization: `Bearer ${token}` } }).subscribe({
      next: (res) => {
        if (res?.stats) this.stats = { ...this.stats, ...res.stats };
        if (Array.isArray(res?.users)) this.userList = res.users;
        if (Array.isArray(res?.logs)) this.adminLogs = res.logs;
        if (Array.isArray(res?.transactions)) {
          this.allAdminTransactions = res.transactions;
          this.transactionsList = res.transactions.filter((tx: AdminTransaction) => tx.type === this.txTypeFilter);
        }
        this.markLoaded('dashboard', 'users', 'transactions', 'logs');
        this.isLoadingUsers = false;
        this.isLoadingTransactions = false;
      },
      error: () => {
        // Fall back to the individual endpoints if the bootstrap is unavailable.
        this.fetchOverviewStats();
      }
    });
  }

  /** Latest unfiltered transaction page, so type switches are instant. */
  private allAdminTransactions: AdminTransaction[] = [];

  public fetchOverviewStats(): void {
    const token = this.authService.getToken();
    if (!token) return;

    this.http.get<any>(`${this.baseUrl}/api/admin/stats`, { headers: { Authorization: `Bearer ${token}` } }).subscribe({
      next: (res) => {
        this.stats = { ...this.stats, ...res };
      }
    });
  }

  public fetchTransactions(): void {
    const token = this.authService.getToken();
    if (!token) return;

    // A user can switch between Deposits and Withdrawals before an earlier
    // request finishes. Keep an older response from replacing the rows for
    // the tab that is currently selected.
    const requestVersion = ++this.transactionRequestVersion;
    const requestedType = this.txTypeFilter;
    this.isLoadingTransactions = true;
    const url = `${this.baseUrl}/api/admin/transactions?type=${requestedType}&search=${encodeURIComponent(this.txSearchQuery)}&status=${this.txStatusFilter}`;
    this.http.get<{ transactions: AdminTransaction[] }>(url, { headers: { Authorization: `Bearer ${token}` } }).subscribe({
      next: (res) => {
        if (requestVersion !== this.transactionRequestVersion || requestedType !== this.txTypeFilter) return;
        // Defensive filtering also ensures a tab never renders a row from the
        // other transaction type if an unexpected response is received.
        this.transactionsList = (res.transactions || []).filter(tx => tx.type === requestedType);
        this.isLoadingTransactions = false;
      },
      error: () => {
        if (requestVersion !== this.transactionRequestVersion || requestedType !== this.txTypeFilter) return;
        this.isLoadingTransactions = false;
      }
    });
  }

  public setTransactionType(type: 'deposit' | 'withdrawal'): void {
    if (this.txTypeFilter === type) return;
    this.txTypeFilter = type;
    this.fetchTransactions();
  }

  public fetchUsers(): void {
    const token = this.authService.getToken();
    if (!token) return;

    this.isLoadingUsers = true;
    const url = `${this.baseUrl}/api/admin/users?search=${encodeURIComponent(this.searchQuery)}&role=${this.roleFilter}`;
    this.http.get<{ users: AdminUser[] }>(url, { headers: { Authorization: `Bearer ${token}` } }).subscribe({
      next: (res) => {
        this.userList = res.users;
        this.isLoadingUsers = false;
      },
      error: () => {
        this.isLoadingUsers = false;
      }
    });
  }

  public fetchAdmins(): void {
    const token = this.authService.getToken();
    if (!token) return;

    this.isLoadingAdmins = true;
    this.http.get<{ admins: AdminUser[] }>(`${this.baseUrl}/api/admin/admins`, { headers: { Authorization: `Bearer ${token}` } }).subscribe({
      next: (res) => {
        this.adminsList = res.admins;
        this.isLoadingAdmins = false;
      },
      error: () => {
        this.isLoadingAdmins = false;
      }
    });
  }

  public createAdmin(): void {
    if (!this.newAdminUsername || !this.newAdminPassword || this.newAdminPassword.length < 6) {
      this.showAdminToast('Please provide a valid username and password (min 6 characters).', 'error');
      return;
    }

    const token = this.authService.getToken();
    if (!token) return;

    this.http.post<{ message: string }>(
      `${this.baseUrl}/api/admin/create-admin`,
      { username: this.newAdminUsername, phone_number: this.newAdminPhone, password: this.newAdminPassword },
      { headers: { Authorization: `Bearer ${token}` } }
    ).subscribe({
      next: (res) => {
        alert(res.message);
        this.showCreateAdminModal = false;
        this.newAdminUsername = '';
        this.newAdminPhone = '';
        this.newAdminPassword = '';
        this.fetchAdmins();
        this.invalidate('logs');
      },
      error: (err) => {
        this.showAdminToast(err?.error?.error || 'Failed to create admin', 'error');
      }
    });
  }

  public toggleSuspend(user: AdminUser): void {
    const token = this.authService.getToken();
    if (!token) return;

    const action = user.is_suspended ? 'activate' : 'suspend';
    this.openConfirmDialog({
      title: user.is_suspended ? 'Activate User Account' : 'Suspend User Account',
      message: `Are you sure you want to ${action} user "${user.username}"?`,
      confirmText: user.is_suspended ? 'Activate Account' : 'Suspend Account',
      type: user.is_suspended ? 'primary' : 'warning',
      onConfirm: () => {
        this.http.post(
          `${this.baseUrl}/api/admin/users/${user.id}/suspend`,
          { suspend: !user.is_suspended },
          { headers: { Authorization: `Bearer ${token}` } }
        ).subscribe({
          next: () => {
            user.is_suspended = !user.is_suspended;
            this.showAdminToast(`User "${user.username}" ${user.is_suspended ? 'suspended' : 'activated'} successfully.`, 'success');
            this.invalidate('logs');
          },
          error: (err) => this.showAdminToast(err?.error?.error || 'Failed to update status', 'error')
        });
      }
    });
  }

  public adjustBalance(user: AdminUser): void {
    this.openPromptDialog({
      title: `Adjust Balance: ${user.username}`,
      message: `Current balance is ${user.balance.toFixed(2)} KES. Enter adjustment amount (e.g. 500 to credit, -200 to deduct):`,
      placeholder: 'e.g. 500',
      inputType: 'number',
      confirmText: 'Apply Adjustment',
      onConfirm: (amountStr) => {
        const amount = parseFloat(amountStr);
        if (isNaN(amount)) {
          this.showAdminToast('Please enter a valid numeric amount.', 'error');
          return;
        }
        const token = this.authService.getToken();
        this.http.post<{ newBalance: number }>(
          `${this.baseUrl}/api/admin/users/${user.id}/balance`,
          { amount },
          { headers: { Authorization: `Bearer ${token}` } }
        ).subscribe({
          next: (res) => {
            user.balance = res.newBalance;
            this.showAdminToast(`Balance for ${user.username} updated to ${res.newBalance.toFixed(2)} KES.`, 'success');
            this.invalidate('logs');
          },
          error: (err) => this.showAdminToast(err?.error?.error || 'Failed to update balance', 'error')
        });
      }
    });
  }

  public resetPassword(user: AdminUser): void {
    this.openPromptDialog({
      title: `Reset Password: ${user.username}`,
      message: 'Enter a new password for this user (minimum 6 characters):',
      placeholder: 'New password',
      inputType: 'password',
      confirmText: 'Reset Password',
      onConfirm: (newPass) => {
        if (!newPass || newPass.length < 6) {
          this.showAdminToast('Password must be at least 6 characters.', 'error');
          return;
        }
        const token = this.authService.getToken();
        this.http.post(
          `${this.baseUrl}/api/admin/users/${user.id}/reset-password`,
          { newPassword: newPass },
          { headers: { Authorization: `Bearer ${token}` } }
        ).subscribe({
          next: () => {
            this.showAdminToast(`Password reset successfully for ${user.username}.`, 'success');
            this.invalidate('logs');
          },
          error: (err) => this.showAdminToast(err?.error?.error || 'Failed to reset password', 'error')
        });
      }
    });
  }

  public deleteUser(user: AdminUser): void {
    this.openConfirmDialog({
      title: 'Permanently Delete User',
      message: `Are you sure you want to permanently delete account "${user.username}"? This action cannot be undone.`,
      confirmText: 'Delete User',
      type: 'danger',
      onConfirm: () => {
        const token = this.authService.getToken();
        this.http.delete(`${this.baseUrl}/api/admin/users/${user.id}`, { headers: { Authorization: `Bearer ${token}` } }).subscribe({
          next: () => {
            this.showAdminToast(`User "${user.username}" deleted.`, 'success');
            // Drop the row immediately; no round trip needed to show the result.
            this.userList = this.userList.filter(row => row.id !== user.id);
            this.invalidate('dashboard');
            this.invalidate('logs');
          },
          error: (err) => this.showAdminToast(err?.error?.error || 'Failed to delete user.', 'error')
        });
      }
    });
  }

  /** Superadmin only — promote or demote a user's role */
  public setUserRole(user: AdminUser, role: 'user' | 'admin'): void {
    if (!this.isSuperAdmin) return;
    this.openConfirmDialog({
      title: `Change Role: ${user.username}`,
      message: `Promote / Demote "${user.username}" to "${role.toUpperCase()}"?`,
      confirmText: `Set Role to ${role.toUpperCase()}`,
      type: role === 'admin' ? 'primary' : 'warning',
      onConfirm: () => {
        const token = this.authService.getToken();
        this.isSettingRole = user.id;
        this.http.post<{ message: string }>(
          `${this.baseUrl}/api/admin/users/${user.id}/set-role`,
          { role },
          { headers: { Authorization: `Bearer ${token}` } }
        ).subscribe({
          next: () => {
            user.role = role;
            this.isSettingRole = null;
            this.showAdminToast(`User role updated to ${role}.`, 'success');
            this.invalidate('logs');
          },
          error: (err) => {
            this.isSettingRole = null;
            this.showAdminToast(err?.error?.error || 'Failed to update role.', 'error');
          }
        });
      }
    });
  }

  /** Superadmin only — remove an admin account */
  public deleteAdmin(admin: AdminUser): void {
    if (!this.isSuperAdmin) return;
    this.openConfirmDialog({
      title: 'Remove Administrator',
      message: `Remove administrator privileges and delete account "${admin.username}"?`,
      confirmText: 'Remove Admin',
      type: 'danger',
      onConfirm: () => {
        const token = this.authService.getToken();
        this.http.delete(`${this.baseUrl}/api/admin/users/${admin.id}`, { headers: { Authorization: `Bearer ${token}` } }).subscribe({
          next: () => {
            this.adminsList = this.adminsList.filter(a => a.id !== admin.id);
            this.showAdminToast(`Administrator "${admin.username}" removed.`, 'success');
            this.invalidate('logs');
          },
          error: (err) => this.showAdminToast(err?.error?.error || 'Failed to remove admin.', 'error')
        });
      }
    });
  }

  public exportUsersCSV(): void {
    if (this.userList.length === 0) return;
    const headers = ['ID', 'Username', 'Phone', 'Role', 'Balance', 'Status', 'Created At'];
    const rows = this.userList.map(u => [
      u.id,
      `"${u.username}"`,
      `"${u.phone_number || ''}"`,
      u.role,
      u.balance,
      u.is_suspended ? 'Suspended' : 'Active',
      `"${u.created_at}"`
    ]);

    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `users_export_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  public fetchLogs(): void {
    const token = this.authService.getToken();
    if (!token) return;

    this.http.get<{ logs: AdminLog[] }>(`${this.baseUrl}/api/admin/logs`, { headers: { Authorization: `Bearer ${token}` } }).subscribe({
      next: (res) => {
        this.adminLogs = res.logs;
      }
    });
  }


  public formatCountdown(ms: number): string {
    const seconds = Math.max(0, Math.ceil(ms / 1000));
    return `${seconds}s`;
  }

  public formatMultiplier(value: number | null): string {
    return value === null ? '--' : `${value.toFixed(2)}x`;
  }

  // ---- Room 1 (primary engine) — unchanged behaviour ---------------------
  public overrideCrashPoint(): void {
    const val = Number(this.customCrashPoint);
    if (!Number.isFinite(val) || val < 1.00) {
      this.showAdminToast('Please enter a valid multiplier of 1.00x or higher.', 'error');
      return;
    }
    this.adminSocket.overrideCrashPoint(val, 1);
    this.overrideSuccessMsg = `Next crash point set to ${val.toFixed(2)}x`;
    setTimeout(() => { this.overrideSuccessMsg = null; }, 3000);
  }

  public resetCrashPoint(): void {
    this.adminSocket.resetCrashPoint(1);
    this.overrideSuccessMsg = 'Crash point reset to Provably Fair algorithm';
    setTimeout(() => { this.overrideSuccessMsg = null; }, 3000);
  }

  // ---- Rooms 2 and 3 — their own window and set control ------------------
  public readonly secondaryRooms: number[] = [2, 3];
  public roomCrashInput: Record<number, number> = { 2: 2.00, 3: 2.00 };
  public roomOverrideMsg: Record<number, string | null> = { 2: null, 3: null };

  /** Live status for one room out of the payload the socket already carries. */
  public roomStatus(rooms: AdminRoomStatus[] | undefined, room: number): AdminRoomStatus | null {
    return rooms?.find(entry => entry.room === room) || null;
  }

  private flashRoomMessage(room: number, message: string): void {
    this.roomOverrideMsg[room] = message;
    setTimeout(() => { this.roomOverrideMsg[room] = null; }, 3000);
  }

  public overrideRoomCrash(room: number): void {
    const val = Number(this.roomCrashInput[room]);
    if (!Number.isFinite(val) || val < 1.00) {
      this.showAdminToast('Please enter a valid multiplier of 1.00x or higher.', 'error');
      return;
    }
    this.adminSocket.overrideCrashPoint(val, room);
    this.flashRoomMessage(room, `Room ${room}: next crash set to ${val.toFixed(2)}x`);
  }

  public resetRoomCrash(room: number): void {
    this.adminSocket.resetCrashPoint(room);
    this.flashRoomMessage(room, `Room ${room}: reset to Provably Fair algorithm`);
  }

  public quickSetRoomCrash(room: number, val: number): void {
    this.roomCrashInput[room] = val;
    this.overrideRoomCrash(room);
  }

  public quickSetCrashPoint(val: number): void {
    this.customCrashPoint = val;
    this.overrideCrashPoint();
  }

  public backToGame(): void {
    this.router.navigate(['/play']);
  }


  public openResetDepositsModal(): void {
    this.showResetDepositsModal = true;
    this.resetDepositsSuccess = false;
  }

  public closeResetDepositsModal(): void {
    this.showResetDepositsModal = false;
  }

  public confirmResetDeposits(): void {
    const token = this.authService.getToken();
    if (!token) {
      this.showAdminToast('Authentication token missing. Please log in.', 'error');
      return;
    }

    this.isResettingDeposits = true;
    this.http.post<{ success: boolean; message: string; totalDeposits: number }>(
      `${this.baseUrl}/api/admin/deposits/reset`,
      {},
      { headers: { Authorization: `Bearer ${token}` } }
    ).subscribe({
      next: (res) => {
        this.isResettingDeposits = false;
        this.showResetDepositsModal = false;
        this.resetDepositsSuccess = true;
        this.stats.totalDeposits = 0;
        this.fetchOverviewStats();
        this.fetchTransactions();
        this.invalidate('logs');
        this.showAdminToast('Total deposits table has been reset to 0.00 KES successfully.', 'success');
      },
      error: (err) => {
        this.isResettingDeposits = false;
        this.showAdminToast(err?.error?.error || 'Failed to reset deposits table', 'error');
      }
    });
  }

  public logout(): void {
    this.authService.logout();
    this.router.navigate(['/login']);
  }
}
