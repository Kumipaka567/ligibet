import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from './auth.service';
import { WithdrawalNoticeService } from './withdrawal-notice.service';
import { withdrawalErrorPopup } from './withdrawal-feedback';
import { PlayerDashboardComponent } from '../../features/dashboard/player-dashboard.component';
import { AviatorGameComponent } from '../../features/game/aviator/aviator-game.component';

const configured = { title: 'Configured personal title', message: 'Configured personal message', type: 'rejected' };

describe('withdrawal error transport', () => {
  let auth: AuthService;
  let http: HttpTestingController;
  const notices = { show: vi.fn() };
  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(),
      { provide: WithdrawalNoticeService, useValue: notices }] });
    auth = TestBed.inject(AuthService);
    http = TestBed.inject(HttpTestingController);
    notices.show.mockClear();
  });
  afterEach(() => { http.verify(); localStorage.clear(); });

  it('keeps the configured 403 popup, status and wallet balance instead of flattening the response', () => {
    auth.userBalance$.next(500);
    let failure: any;
    auth.withdraw(100).subscribe({ error: error => failure = error });
    http.expectOne(req => req.url.endsWith('/wallet/withdraw')).flush({
      error: 'Generic disabled message', withdrawal_blocked: true, popup: configured
    }, { status: 403, statusText: 'Forbidden' });
    expect(failure.status).toBe(403);
    expect(withdrawalErrorPopup(failure)).toEqual(configured);
    expect(auth.userBalance$.value).toBe(500);
    expect(notices.show).not.toHaveBeenCalled();
  });

  it('preserves notification-only errors and still handles plain validation errors', () => {
    let failure: unknown;
    auth.withdraw(100).subscribe({ error: error => failure = error });
    http.expectOne(req => req.url.endsWith('/wallet/withdraw')).flush({ error: configured.message, notification: configured },
      { status: 403, statusText: 'Forbidden' });
    expect(withdrawalErrorPopup(failure)).toEqual(configured);
    expect(withdrawalErrorPopup('Insufficient funds').title).toBe('Insufficient Funds');
  });
});

describe('configured player withdrawal popups', () => {
  it.each(['dashboard', 'aviator'])('%s shows only the configured popup and closes the withdrawal form', screen => {
    const failure = Object.assign(new Error('Generic disabled message'), { popup: configured });
    const component: any = Object.create(screen === 'dashboard' ? PlayerDashboardComponent.prototype : AviatorGameComponent.prototype);
    Object.assign(component, {
      authService: { withdraw: () => throwError(() => failure) }, withdrawAmount: 100, withdrawVal: signal(100),
      userBalance: signal(500), isWithdrawing: signal(false), isSubmittingWithdrawal: signal(false),
      withdrawNotice: signal(null), showWithdrawModal: signal(true), showWalletModal: signal(true),
      withdrawalPopup: signal(null), walletTab: signal('withdraw'), transactionHistoryTab: signal('withdrawal'),
      showWithdrawalNotification: vi.fn(), showToast: vi.fn(), loadTransactionsHistory: vi.fn()
    });
    component.submitWithdraw();
    if (screen === 'dashboard') {
      expect(component.withdrawalPopup()).toEqual(configured);
      expect(component.showWithdrawModal()).toBe(false);
      expect(component.isWithdrawing()).toBe(false);
    } else {
      expect(component.showWithdrawalNotification).toHaveBeenCalledOnce();
      expect(component.showWithdrawalNotification).toHaveBeenCalledWith(expect.objectContaining(configured));
      expect(component.showWalletModal()).toBe(false);
      expect(component.isSubmittingWithdrawal()).toBe(false);
    }
    expect(component.showToast).not.toHaveBeenCalled();
  });

  it('the dashboard retains the configured global popup on an accepted pending request', () => {
    const component: any = Object.create(PlayerDashboardComponent.prototype);
    Object.assign(component, {
      authService: { withdraw: () => of({ status: 'pending', popup: configured }), isAdmin: () => false },
      withdrawAmount: 100, isWithdrawing: signal(false), withdrawNotice: signal(null),
      showWithdrawModal: signal(true), withdrawalPopup: signal(null)
    });
    component.submitWithdraw();
    expect(component.withdrawalPopup()).toEqual(configured);
    expect(component.showWithdrawModal()).toBe(false);
  });
});
