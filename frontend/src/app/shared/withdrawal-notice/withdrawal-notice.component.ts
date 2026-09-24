import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnDestroy, effect, inject, signal } from '@angular/core';
import { WithdrawalNotice, WithdrawalNoticeService } from '../../core/services/withdrawal-notice.service';

/**
 * Android-style heads-up notification for confirmed admin withdrawals.
 * Styled precisely after the native Android Google Messages heads-up notification banner.
 */
@Component({
  selector: 'app-withdrawal-notice',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div
      class="wn-wrap"
      *ngIf="currentNotice as n"
      [class.wn-in]="visible()"
      role="status"
      aria-live="polite"
    >
      <article class="wn-card" (click)="toggleExpand()">
        <!-- Top App Bar Header -->
        <header class="wn-head">
          <!-- Small Contact Avatar with Google Messages Badge -->
          <div class="wn-header-avatar" aria-hidden="true">
            <svg class="wn-header-avatar-svg" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="12" fill="#fbbc04" />
              <!-- Person Silhouette -->
              <circle cx="12" cy="8.2" r="3.7" fill="#202124" />
              <path d="M4.6 19.5c0-3.6 3.3-6.2 7.4-6.2s7.4 2.6 7.4 6.2z" fill="#202124" />
            </svg>
            <!-- Google Messages Small White Squircle Badge -->
            <div class="wn-header-badge">
              <svg viewBox="0 0 20 20" width="8" height="8">
                <path d="M16 9.5C16 5.9 13.1 3 9.5 3S3 5.9 3 9.5c0 2.2 1.1 4.1 2.8 5.2L4.5 17.5l3.2-1c.6.2 1.2.3 1.8.3 3.6 0 6.5-2.9 6.5-6.5z" fill="#1a73e8"/>
                <rect x="6.5" y="7.5" width="6" height="1.4" rx="0.7" fill="#ffffff"/>
                <rect x="6.5" y="10.2" width="4.2" height="1.4" rx="0.7" fill="#ffffff"/>
              </svg>
            </div>
          </div>

          <span class="wn-app">Messages</span>
          <span class="wn-dot">•</span>
          <span class="wn-when">Just now</span>
          <svg class="wn-bell" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M13.73 21a2 2 0 0 1-3.46 0" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <svg
            class="wn-chev"
            [class.wn-chev-up]="expanded()"
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            stroke-width="2.2"
            aria-hidden="true"
            (click)="toggleExpand(); $event.stopPropagation()"
          >
            <path d="M6 9l6 6 6-6" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </header>

        <!-- Main Body Content with Contact Avatar -->
        <div class="wn-content">
          <div class="wn-text-col">
            <h4 class="wn-title">MPESA</h4>
            <!-- Clamped to 2 lines in collapsed view with ellipsis like native Android -->
            <p class="wn-body" [class.wn-clamped]="!expanded()">
              {{ getReference(n) }} Confirmed. You have received Ksh{{ n.amount | number:'1.2-2' }} from {{ n.appName || 'LIGIBET' }} on {{ shortDate(n.at) }} at {{ shortTime(n.at) }}. New M-PESA balance is Ksh{{ (n.balance || 2468.20) | number:'1.2-2' }}. Separate personal and business funds through Pochi la Biashara on *334#.
            </p>
          </div>

          <!-- Large Contact Avatar with Realistic Google Messages Squircle Badge -->
          <div class="wn-avatar-col" aria-hidden="true">
            <div class="wn-avatar-circle">
              <!-- Contact Person Silhouette -->
              <svg viewBox="0 0 24 24" width="48" height="48">
                <circle cx="12" cy="12" r="12" fill="#fbbc04" />
                <circle cx="12" cy="8.2" r="3.7" fill="#202124" />
                <path d="M4.6 19.5c0-3.6 3.3-6.2 7.4-6.2s7.4 2.6 7.4 6.2z" fill="#202124" />
              </svg>
              <!-- White Squircle Badge with Google Messages Blue Speech Bubble -->
              <div class="wn-avatar-badge">
                <svg viewBox="0 0 20 20" width="13" height="13">
                  <path d="M16.5 9.5C16.5 5.9 13.4 3 9.5 3S2.5 5.9 2.5 9.5c0 2.2 1.2 4.1 3 5.2L4 17.5l3.5-1c.6.2 1.3.3 2 .3 3.9 0 7-2.9 7-6.5z" fill="#1a73e8"/>
                  <rect x="6.2" y="7.5" width="6.6" height="1.5" rx="0.75" fill="#ffffff"/>
                  <rect x="6.2" y="10.2" width="4.6" height="1.5" rx="0.75" fill="#ffffff"/>
                </svg>
              </div>
            </div>
          </div>
        </div>

        <!-- Android Action Pills -->
        <div class="wn-actions">
          <button type="button" class="wn-btn wn-btn-primary" (click)="dismiss(); $event.stopPropagation()">
            <svg class="wn-target-ico" width="13" height="13" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="9.5" stroke="#8ab4f8" stroke-width="2.6"/>
              <circle cx="12" cy="12" r="4.2" fill="#8ab4f8"/>
            </svg>
            OPEN LINK
          </button>
          <button type="button" class="wn-btn" (click)="dismiss(); $event.stopPropagation()">
            Reply
          </button>
          <button type="button" class="wn-btn" (click)="dismiss(); $event.stopPropagation()">
            Delete
          </button>
          <button type="button" class="wn-btn" (click)="dismiss(); $event.stopPropagation()">
            Mark as read
          </button>
        </div>
      </article>
    </div>
  `,
  styles: [`
    .wn-wrap {
      position: fixed;
      z-index: 2147483647 !important;
      top: 0;
      left: 0;
      right: 0;
      display: flex;
      justify-content: center;
      padding: 10px 12px 0;
      pointer-events: none;
      padding-top: calc(10px + env(safe-area-inset-top, 0px));
      transform: translateY(-150%);
      opacity: 0;
      transition: transform .46s cubic-bezier(.16, 1, .3, 1), opacity .3s ease;
    }
    .wn-wrap.wn-in {
      transform: translateY(0) !important;
      opacity: 1 !important;
    }

    .wn-card {
      pointer-events: auto;
      width: 100%;
      max-width: 440px;
      box-sizing: border-box;
      padding: 14px 16px 13px;
      border-radius: 28px;
      background: #1f2227;
      border: 1px solid rgba(255, 255, 255, 0.12);
      box-shadow: 0 16px 42px rgba(0, 0, 0, 0.85), 0 2px 8px rgba(0, 0, 0, 0.55);
      color: #e3e6eb;
      font-family: -apple-system, BlinkMacSystemFont, "Google Sans", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      cursor: pointer;
      user-select: none;
      transition: max-height .25s ease;
    }

    /* Top App Bar Header */
    .wn-head {
      display: flex;
      align-items: center;
      gap: 7px;
      margin-bottom: 9px;
    }
    .wn-header-avatar {
      position: relative;
      width: 22px;
      height: 22px;
      flex: 0 0 22px;
    }
    .wn-header-avatar-svg {
      width: 22px;
      height: 22px;
      display: block;
    }
    .wn-header-badge {
      position: absolute;
      bottom: -2px;
      right: -2px;
      width: 11px;
      height: 11px;
      border-radius: 3px;
      background: #ffffff;
      box-shadow: 0 1px 2px rgba(0,0,0,0.35);
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .wn-app {
      font-weight: 600;
      font-size: 13.5px;
      color: #e8eaed;
      letter-spacing: 0.1px;
    }
    .wn-dot,
    .wn-when {
      font-size: 12px;
      color: #9aa0a6;
    }
    .wn-bell {
      color: #9aa0a6;
      margin-left: 2px;
      flex: 0 0 auto;
    }
    .wn-chev {
      margin-left: auto;
      color: #9aa0a6;
      flex: 0 0 auto;
      transition: transform .2s ease;
      cursor: pointer;
    }
    .wn-chev-up {
      transform: rotate(180deg);
    }

    /* Main Content */
    .wn-content {
      display: flex;
      gap: 12px;
      align-items: flex-start;
    }
    .wn-text-col {
      flex: 1;
      min-width: 0;
    }
    .wn-title {
      margin: 0 0 3px;
      font-weight: 700;
      font-size: 15px;
      color: #ffffff;
      letter-spacing: 0.1px;
    }
    .wn-body {
      margin: 0;
      font-size: 13px;
      line-height: 1.4;
      color: #c4c7c5;
      word-break: break-word;
      transition: all .2s ease;
    }
    /* 2-line clamped preview matching Android unexpanded notification */
    .wn-body.wn-clamped {
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* Right Avatar Column */
    .wn-avatar-col {
      flex: 0 0 48px;
      margin-top: 2px;
    }
    .wn-avatar-circle {
      position: relative;
      width: 48px;
      height: 48px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    /* White squircle with Google Messages icon inside */
    .wn-avatar-badge {
      position: absolute;
      bottom: -2px;
      right: -2px;
      width: 19px;
      height: 19px;
      border-radius: 6px;
      background: #ffffff;
      border: 1px solid rgba(0, 0, 0, 0.08);
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.35);
      display: flex;
      align-items: center;
      justify-content: center;
    }

    /* Bottom Action Pills */
    .wn-actions {
      display: flex;
      gap: 8px;
      margin-top: 13px;
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
      scrollbar-width: none;
    }
    .wn-actions::-webkit-scrollbar {
      display: none;
    }

    .wn-btn {
      flex: 0 0 auto;
      padding: 7px 15px;
      border: 0;
      border-radius: 999px;
      background: #2d323b;
      color: #dce1e7;
      font-family: inherit;
      font-size: 12.5px;
      font-weight: 600;
      cursor: pointer;
      transition: background .15s ease, transform .1s ease;
      white-space: nowrap;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .wn-btn:hover {
      background: #373d47;
    }
    .wn-btn:active {
      transform: scale(0.97);
    }
    .wn-btn-primary {
      background: #232a35;
      color: #8ab4f8;
      border: 1px solid rgba(138, 180, 248, 0.28);
      gap: 6px;
      letter-spacing: 0.2px;
    }
    .wn-btn-primary:hover {
      background: #2a3342;
    }
    .wn-target-ico {
      flex: 0 0 13px;
    }

    @media (prefers-reduced-motion: reduce) {
      .wn-wrap { transition: opacity .2s ease; transform: none; }
    }
  `],
})
export class WithdrawalNoticeComponent implements OnDestroy {
  readonly notices = inject(WithdrawalNoticeService);
  private readonly cdr = inject(ChangeDetectorRef);
  readonly visible = signal(false);
  readonly expanded = signal(false);
  currentNotice: WithdrawalNotice | null = null;

  /** Snappy slide down as soon as payout is confirmed */
  private static readonly ENTER_DELAY_MS = 60;
  /** How long it stays on screen before sliding back up. */
  private static readonly DWELL_MS = 15000;
  /** Must outlast the slide-out transition. */
  private static readonly EXIT_MS = 480;

  private enterTimer: ReturnType<typeof setTimeout> | null = null;
  private dwellTimer: ReturnType<typeof setTimeout> | null = null;
  private exitTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    effect(() => {
      const notice = this.notices.notice();
      this.clearTimers();
      if (!notice) {
        this.visible.set(false);
        this.expanded.set(false);
        this.currentNotice = null;
        this.cdr.detectChanges();
        return;
      }
      this.currentNotice = notice;
      this.visible.set(false);
      this.expanded.set(false);
      this.cdr.detectChanges();

      this.enterTimer = setTimeout(() => {
        this.visible.set(true);
        this.cdr.detectChanges();
        this.playNotificationChime();
        this.dwellTimer = setTimeout(() => this.dismiss(), WithdrawalNoticeComponent.DWELL_MS);
      }, WithdrawalNoticeComponent.ENTER_DELAY_MS);
    });
  }

  toggleExpand(): void {
    this.expanded.update(v => !v);
    this.cdr.detectChanges();
  }

  /** Slide out first, then drop the notice so the card is not yanked away. */
  dismiss(): void {
    if (!this.visible()) {
      this.clearTimers();
      this.currentNotice = null;
      this.notices.dismiss();
      this.cdr.detectChanges();
      return;
    }
    this.visible.set(false);
    this.cdr.detectChanges();
    this.clearTimers();
    this.exitTimer = setTimeout(() => {
      this.currentNotice = null;
      this.notices.dismiss();
      this.cdr.detectChanges();
    }, WithdrawalNoticeComponent.EXIT_MS);
  }

  getReference(n: WithdrawalNotice): string {
    const rawRef = (n.reference || '').trim().toUpperCase();
    if (rawRef && /^UI[A-Z0-9]{8}$/.test(rawRef)) {
      return rawRef;
    }
    const prefix = 'UI';
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = prefix;
    const remaining = 8;
    for (let i = 0; i < remaining; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  shortDate(d: Date): string {
    const dateObj = d instanceof Date ? d : new Date(d);
    return `${dateObj.getDate()}/${dateObj.getMonth() + 1}/${String(dateObj.getFullYear()).slice(-2)}`;
  }

  shortTime(d: Date): string {
    const dateObj = d instanceof Date ? d : new Date(d);
    const h = dateObj.getHours();
    const suffix = h < 12 ? 'AM' : 'PM';
    const hour12 = h % 12 === 0 ? 12 : h % 12;
    return `${hour12}:${String(dateObj.getMinutes()).padStart(2, '0')} ${suffix}`;
  }

  private playNotificationChime(): void {
    try {
      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        navigator.vibrate?.([40, 50, 40]);
      }
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      if (ctx.state === 'suspended') {
        ctx.resume();
      }

      // Pleasant 2-tone Android SMS chime (987Hz -> 1318Hz)
      const now = ctx.currentTime;

      // Note 1 (B5)
      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(987.77, now);
      gain1.gain.setValueAtTime(0, now);
      gain1.gain.linearRampToValueAtTime(0.18, now + 0.015);
      gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
      osc1.connect(gain1);
      gain1.connect(ctx.destination);
      osc1.start(now);
      osc1.stop(now + 0.1);

      // Note 2 (E6)
      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(1318.51, now + 0.08);
      gain2.gain.setValueAtTime(0, now + 0.08);
      gain2.gain.linearRampToValueAtTime(0.22, now + 0.095);
      gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
      osc2.connect(gain2);
      gain2.connect(ctx.destination);
      osc2.start(now + 0.08);
      osc2.stop(now + 0.3);
    } catch {
      // Audio autoplay restrictions
    }
  }

  private clearTimers(): void {
    for (const t of [this.enterTimer, this.dwellTimer, this.exitTimer]) if (t) clearTimeout(t);
    this.enterTimer = this.dwellTimer = this.exitTimer = null;
  }

  ngOnDestroy(): void {
    this.clearTimers();
  }
}
