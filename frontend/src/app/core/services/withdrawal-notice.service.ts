import { Injectable, signal } from '@angular/core';

/** A confirmed withdrawal, rendered as a slide-down notification. */
export interface WithdrawalNotice {
  reference: string;
  amount: number;
  phone: string;
  balance: number;
  at: Date;
  codePrefix?: string;
  appName?: string;
}

/**
 * Carries a confirmed admin withdrawal from the point the API answers to the
 * notification component mounted at the app root, so every withdrawal entry
 * point (wallet, dashboard, Aviator) raises the same notice without each one
 * having to know the component exists.
 */
@Injectable({ providedIn: 'root' })
export class WithdrawalNoticeService {
  /** The notice currently queued for display, or null when nothing is pending. */
  readonly notice = signal<WithdrawalNotice | null>(null);

  show(notice: WithdrawalNotice): void {
    this.notice.set(notice);
  }

  dismiss(): void {
    this.notice.set(null);
  }
}
