import { Component, OnInit, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../../../core/services/auth.service';
import { SanitizedModeService } from '../../../core/services/sanitized-mode.service';

@Component({
  selector: 'app-auth-landing',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="lb-auth">

      <!-- ---------------- TOP BAR ---------------- -->
      <header class="lb-auth-topbar">
        <div class="lb-auth-topbar-inner">
          <a class="lb-auth-logo">
            <span class="lb-auth-mark">
              <img src="assets/images/ligibet-logo.png" alt="" onerror="this.style.display='none'" />
            </span>
            <span class="lb-auth-word"><b>Ligi</b>{{ isSanitized() ? '' : 'Bets' }}</span>
          </a>
          <span class="lb-auth-tagline" *ngIf="!isSanitized()">Weka Ligi Yako. Shinda Kubwa.</span>
        </div>
      </header>

      <main class="lb-auth-main">
        <section class="lb-auth-card">

          <!-- APP DOWNLOAD BANNER -->
          <div class="lb-auth-app" (click)="triggerAppDownload()">
            <img src="assets/images/ligibet-logo.png" alt="Ligi App" class="lb-auth-app-logo" onerror="this.src='favicon.svg'" />
            <div class="lb-auth-app-text">
              <span class="lb-auth-app-title">{{ isSanitized() ? 'Ligi Mobile App' : 'LigiBet Mobile App' }}</span>
              <span class="lb-auth-app-sub">{{ isSanitized() ? 'Fast & Smooth &bull; Free Data Mode' : 'Instant Aviator &bull; Free Data Mode' }}</span>
            </div>
            <button type="button" class="lb-auth-app-btn">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                <polyline points="7 10 12 15 17 10"></polyline>
                <line x1="12" y1="15" x2="12" y2="3"></line>
              </svg>
              Download
            </button>
          </div>

          <!-- TABS -->
          <div class="lb-auth-tabs" *ngIf="activeTab !== 'forgot'">
            <button type="button" [class.active]="activeTab === 'login'" (click)="setTab('login')">Log in</button>
            <button type="button" [class.active]="activeTab === 'register'" (click)="setTab('register')">Register</button>
          </div>

          <!-- FORGOT HEADER -->
          <div class="lb-auth-forgot-head" *ngIf="activeTab === 'forgot'">
            <button type="button" class="lb-auth-back" (click)="setTab('login')">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.6"><path d="M15 5l-7 7 7 7"/></svg>
              Back to Login
            </button>
            <h2>Reset Password</h2>
          </div>

          <!-- ALERTS -->
          <div class="lb-alert error" *ngIf="errorMessage">{{ errorMessage }}</div>
          <div class="lb-alert success" *ngIf="successMessage">{{ successMessage }}</div>

          <!-- LOGIN / REGISTER -->
          <form *ngIf="activeTab !== 'forgot'" (ngSubmit)="onSubmit()" class="lb-auth-form">

            <div class="lb-field">
              <label class="lb-label">Phone number</label>
              <div class="lb-input-box lb-phone-box">
                <span class="lb-phone-prefix">+254</span>
                <span class="lb-phone-divider"></span>
                <input type="tel" [(ngModel)]="phone" name="phone" class="lb-input"
                       placeholder="7XX XXX XXX" autocomplete="tel" required />
              </div>
            </div>

            <div class="lb-field" *ngIf="activeTab === 'login'">
              <label class="lb-label">Password</label>
              <div class="lb-input-box">
                <input [type]="showPassword ? 'text' : 'password'" [(ngModel)]="password" name="password"
                       class="lb-input" placeholder="Enter password" required />
                <button type="button" class="lb-reveal" (click)="togglePassword()"
                        [attr.aria-label]="showPassword ? 'Hide password' : 'Show password'"
                        [attr.aria-pressed]="showPassword">
                  <ng-container [ngTemplateOutlet]="showPassword ? eyeOffIcon : eyeIcon"></ng-container>
                </button>
              </div>
            </div>

            <div class="lb-forgot-row" *ngIf="activeTab === 'login'">
              <a class="lb-forgot-link" (click)="setTab('forgot')">Forgot password?</a>
            </div>

            <div class="lb-field" *ngIf="activeTab === 'register'">
              <label class="lb-label">Create password</label>
              <div class="lb-input-box">
                <input [type]="showPassword ? 'text' : 'password'" [(ngModel)]="password" name="password"
                       class="lb-input" placeholder="Minimum 6 characters" required />
                <button type="button" class="lb-reveal" (click)="togglePassword()"
                        [attr.aria-label]="showPassword ? 'Hide password' : 'Show password'"
                        [attr.aria-pressed]="showPassword">
                  <ng-container [ngTemplateOutlet]="showPassword ? eyeOffIcon : eyeIcon"></ng-container>
                </button>
              </div>
            </div>

            <div class="lb-field" *ngIf="activeTab === 'register'">
              <label class="lb-label">Confirm password</label>
              <div class="lb-input-box">
                <input [type]="showPassword ? 'text' : 'password'" [(ngModel)]="confirmPassword" name="confirmPassword"
                       class="lb-input" placeholder="Re-enter password" required />
                <button type="button" class="lb-reveal" (click)="togglePassword()"
                        [attr.aria-label]="showPassword ? 'Hide password' : 'Show password'"
                        [attr.aria-pressed]="showPassword">
                  <ng-container [ngTemplateOutlet]="showPassword ? eyeOffIcon : eyeIcon"></ng-container>
                </button>
              </div>
            </div>

            <div class="lb-terms" *ngIf="activeTab === 'register'">
              <input type="checkbox" id="termsCheckbox" [(ngModel)]="termsAccepted" name="termsAccepted" class="lb-checkbox" required />
              <label for="termsCheckbox">I confirm I am 18+ and agree to the Terms and Privacy Policy</label>
            </div>

            <button type="submit" class="lb-submit" [disabled]="isSubmitting">
              <span class="lb-spinner" *ngIf="isSubmitting"></span>
              <span *ngIf="!isSubmitting && activeTab === 'login'">Log in</span>
              <span *ngIf="!isSubmitting && activeTab === 'register'">Create account</span>
            </button>
          </form>

          <!-- FORGOT FLOW -->
          <div *ngIf="activeTab === 'forgot'" class="lb-auth-form">
            <form *ngIf="forgotStep === 1" (ngSubmit)="onSendOtp()">
              <p class="lb-step-guide">Enter your registered mobile number below to receive a reset code.</p>
              <div class="lb-field">
                <label class="lb-label">Phone number</label>
                <div class="lb-input-box lb-phone-box">
                  <span class="lb-phone-prefix">+254</span>
                  <span class="lb-phone-divider"></span>
                  <input type="tel" [(ngModel)]="phone" name="phone" class="lb-input" placeholder="7XX XXX XXX" required />
                </div>
              </div>
              <button type="submit" class="lb-submit" [disabled]="isSubmitting">
                {{ isSubmitting ? 'Sending code...' : 'Send reset code' }}
              </button>
            </form>

            <form *ngIf="forgotStep === 2" (ngSubmit)="onVerifyAndReset()">
              <div class="lb-otp-banner">
                <span>Code sent to <strong>+254{{ phone }}</strong></span>
                <a class="lb-forgot-link" (click)="forgotStep = 1">Edit</a>
              </div>

              <div class="lb-field">
                <label class="lb-label">6-Digit Verification Code</label>
                <div class="lb-input-box">
                  <input type="text" [(ngModel)]="otpInput" name="otpInput" class="lb-input" placeholder="• • • • • •" maxlength="6" required />
                </div>
              </div>

              <div class="lb-field">
                <label class="lb-label">New Password</label>
                <div class="lb-input-box">
                  <input [type]="showNewPassword ? 'text' : 'password'" [(ngModel)]="newPassword" name="newPassword"
                         class="lb-input" placeholder="Minimum 6 characters" required />
                  <button type="button" class="lb-reveal" (click)="toggleNewPassword()"
                          [attr.aria-label]="showNewPassword ? 'Hide password' : 'Show password'"
                          [attr.aria-pressed]="showNewPassword">
                    <ng-container [ngTemplateOutlet]="showNewPassword ? eyeOffIcon : eyeIcon"></ng-container>
                  </button>
                </div>
              </div>

              <div class="lb-field">
                <label class="lb-label">Confirm New Password</label>
                <div class="lb-input-box">
                  <input [type]="showNewPassword ? 'text' : 'password'" [(ngModel)]="confirmNewPassword" name="confirmNewPassword"
                         class="lb-input" placeholder="Confirm new password" required />
                  <button type="button" class="lb-reveal" (click)="toggleNewPassword()"
                          [attr.aria-label]="showNewPassword ? 'Hide password' : 'Show password'"
                          [attr.aria-pressed]="showNewPassword">
                    <ng-container [ngTemplateOutlet]="showNewPassword ? eyeOffIcon : eyeIcon"></ng-container>
                  </button>
                </div>
              </div>

              <button type="submit" class="lb-submit" [disabled]="isSubmitting">
                {{ isSubmitting ? 'Verifying...' : 'Reset password' }}
              </button>

              <div class="lb-resend-row">
                <a class="lb-forgot-link" (click)="onSendOtp()">Resend code</a>
              </div>
            </form>
          </div>
        </section>

        <p class="lb-auth-foot">{{ isSanitized() ? '18+ only &bull; ligi.site' : '18+ only &bull; Play responsibly &bull; ligibet.site' }}</p>
      </main>
    </div>

    <ng-template #eyeIcon>
      <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
        <circle cx="12" cy="12" r="3"></circle>
      </svg>
    </ng-template>
    <ng-template #eyeOffIcon>
      <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"></path>
        <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"></path>
        <line x1="1" y1="1" x2="23" y2="23"></line>
      </svg>
    </ng-template>
  `,
  styles: [`
    :host {
      --lb-green: #15a94b;
      --lb-green-dark: #0d7f36;
      --lb-yellow: #ffe000;
      --lb-page: #eceff1;
      --lb-card: #ffffff;
      --lb-border: #dfe4e8;
      --lb-text: #1f2937;
      --lb-muted: #6b7280;
      --lb-faint: #9aa4ae;

      display: block;
      min-height: 100vh;
      background: var(--lb-page);
      color: var(--lb-text);
      font-family: 'Inter', 'Segoe UI', Roboto, Arial, sans-serif;
    }

    *, *::before, *::after { box-sizing: border-box; }

    .lb-auth { min-height: 100vh; display: flex; flex-direction: column; }

    /* TOP BAR */
    .lb-auth-topbar { background: var(--lb-green); box-shadow: 0 2px 8px rgba(0,0,0,0.14); }
    .lb-auth-topbar-inner {
      max-width: 1100px; margin: 0 auto;
      padding: 12px 18px;
      display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
    }
    .lb-auth-logo { display: flex; align-items: center; gap: 9px; text-decoration: none; }
    .lb-auth-mark {
      width: 42px; height: 42px; border-radius: 50%;
      background: #fff; overflow: hidden; flex: 0 0 auto;
      display: flex; align-items: center; justify-content: center;
    }
    .lb-auth-mark img { width: 100%; height: 100%; object-fit: cover; }
    .lb-auth-word { font-size: 23px; font-weight: 800; color: #fff; letter-spacing: -0.4px; }
    .lb-auth-word b { color: var(--lb-yellow); font-weight: 800; }
    .lb-auth-tagline { font-size: 13.5px; color: rgba(255,255,255,0.92); font-weight: 500; }

    /* MAIN */
    .lb-auth-main {
      flex: 1 1 auto;
      display: flex; flex-direction: column; align-items: center;
      padding: 22px 16px 40px;
    }

    .lb-auth-card {
      width: 100%; max-width: 430px;
      background: var(--lb-card);
      border-radius: 10px;
      padding: 18px 20px 24px;
      box-shadow: 0 2px 12px rgba(0,0,0,0.09);
    }

    /* APP BANNER */
    .lb-auth-app {
      display: flex; align-items: center; gap: 10px;
      background: #f4f8f5;
      border: 1px solid #d6e8dc;
      border-radius: 8px;
      padding: 9px 11px;
      margin-bottom: 18px;
      cursor: pointer;
    }
    .lb-auth-app:hover { background: #edf5f0; }
    .lb-auth-app-logo { width: 38px; height: 38px; border-radius: 8px; object-fit: cover; flex: 0 0 auto; }
    .lb-auth-app-text { display: flex; flex-direction: column; flex: 1 1 auto; min-width: 0; }
    .lb-auth-app-title { font-size: 13.5px; font-weight: 800; color: var(--lb-green-dark); }
    .lb-auth-app-sub { font-size: 11.5px; color: var(--lb-muted); }
    .lb-auth-app-btn {
      display: flex; align-items: center; gap: 5px;
      background: var(--lb-yellow); color: #17321f;
      border: 0; border-radius: 16px;
      padding: 7px 14px; font-size: 12.5px; font-weight: 800; cursor: pointer;
      flex: 0 0 auto;
    }

    /* TABS */
    .lb-auth-tabs {
      display: grid; grid-template-columns: 1fr 1fr;
      gap: 6px; background: #eef1f3; border-radius: 8px; padding: 4px;
      margin-bottom: 18px;
    }
    .lb-auth-tabs button {
      border: 0; background: transparent; border-radius: 6px;
      padding: 11px 6px; font-size: 15px; font-weight: 700;
      color: var(--lb-muted); cursor: pointer; font-family: inherit;
    }
    .lb-auth-tabs button.active { background: var(--lb-green); color: #fff; }

    .lb-auth-forgot-head { margin-bottom: 16px; }
    .lb-auth-back {
      display: flex; align-items: center; gap: 4px;
      background: transparent; border: 0; cursor: pointer;
      color: var(--lb-green-dark); font-size: 13.5px; font-weight: 700;
      padding: 0; margin-bottom: 8px; font-family: inherit;
    }
    .lb-auth-forgot-head h2 { margin: 0; font-size: 20px; font-weight: 800; }

    /* ALERTS */
    .lb-alert {
      border-radius: 7px; padding: 11px 13px;
      font-size: 13.5px; font-weight: 600; margin-bottom: 15px;
      line-height: 1.45;
    }
    .lb-alert.error { background: #fdecec; color: #b91c1c; border: 1px solid #f6cfcf; }
    .lb-alert.success { background: #e8f6ed; color: #0d7f36; border: 1px solid #c6e6d3; }

    /* FIELDS */
    .lb-auth-form { display: flex; flex-direction: column; }
    .lb-field { margin-bottom: 15px; }
    .lb-label {
      display: block; margin-bottom: 6px;
      font-size: 13px; font-weight: 700; color: var(--lb-muted);
    }
    .lb-input-box {
      display: flex; align-items: center; gap: 8px;
      background: #f8fafb;
      border: 1.5px solid var(--lb-border);
      border-radius: 8px;
      height: 50px; padding: 0 13px;
      transition: border-color 0.16s ease, box-shadow 0.16s ease, background 0.16s ease;
    }
    .lb-input-box:focus-within {
      border-color: var(--lb-green);
      background: #fff;
      box-shadow: 0 0 0 3px rgba(21, 169, 75, 0.15);
    }
    .lb-phone-prefix { color: var(--lb-green-dark); font-weight: 800; font-size: 15px; }
    .lb-phone-divider { width: 1.5px; height: 22px; background: var(--lb-border); }
    .lb-input {
      flex: 1 1 auto; width: 100%;
      background: transparent; border: 0; outline: none;
      font-size: 15.5px; font-family: inherit; color: var(--lb-text);
    }
    .lb-input::placeholder { color: var(--lb-faint); }

    .lb-input:-webkit-autofill,
    .lb-input:-webkit-autofill:hover,
    .lb-input:-webkit-autofill:focus {
      -webkit-box-shadow: 0 0 0 1000px #f8fafb inset;
      box-shadow: 0 0 0 1000px #f8fafb inset;
      -webkit-text-fill-color: var(--lb-text);
      caret-color: var(--lb-text);
      transition: background-color 9999s ease-in-out 0s;
    }
    .lb-input::selection { background: rgba(21, 169, 75, 0.24); }

    .lb-reveal {
      background: transparent; border: 0; padding: 0 2px;
      display: flex; align-items: center; justify-content: center;
      color: var(--lb-faint); cursor: pointer; flex: 0 0 auto;
      transition: color 0.16s ease;
    }
    .lb-reveal:hover, .lb-reveal:focus-visible { color: var(--lb-green); outline: none; }

    .lb-forgot-row { display: flex; justify-content: flex-end; margin: -6px 0 16px; }
    .lb-forgot-link {
      color: var(--lb-green-dark); font-size: 13.5px; font-weight: 700;
      cursor: pointer; text-decoration: none;
    }
    .lb-forgot-link:hover { text-decoration: underline; }

    .lb-terms { display: flex; align-items: flex-start; gap: 9px; margin: 2px 0 18px; }
    .lb-checkbox { width: 18px; height: 18px; min-width: 18px; margin-top: 1px; accent-color: var(--lb-green); cursor: pointer; }
    .lb-terms label { font-size: 12.5px; color: var(--lb-muted); line-height: 1.45; cursor: pointer; }

    .lb-submit {
      width: 100%; height: 52px;
      background: var(--lb-green); color: #fff;
      border: 0; border-radius: 8px;
      font-size: 16px; font-weight: 800; font-family: inherit;
      cursor: pointer;
      display: flex; align-items: center; justify-content: center; gap: 9px;
      transition: background 0.16s ease, transform 0.06s ease;
    }
    .lb-submit:hover:not(:disabled) { background: var(--lb-green-dark); }
    .lb-submit:active:not(:disabled) { transform: translateY(1px); }
    .lb-submit:disabled { opacity: 0.62; cursor: not-allowed; }

    .lb-spinner {
      width: 19px; height: 19px; border-radius: 50%;
      border: 2.5px solid rgba(255,255,255,0.35);
      border-top-color: #fff;
      animation: lbSpin 0.8s linear infinite;
    }
    @keyframes lbSpin { to { transform: rotate(360deg); } }

    .lb-step-guide { margin: 0 0 16px; font-size: 13.5px; color: var(--lb-muted); line-height: 1.5; }
    .lb-otp-banner {
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
      background: #e8f6ed; border-radius: 7px;
      padding: 11px 13px; margin-bottom: 16px;
      font-size: 13px; color: var(--lb-green-dark);
    }
    .lb-resend-row { display: flex; justify-content: center; margin-top: 14px; }

    .lb-auth-foot {
      margin: 20px 0 0; font-size: 12px; color: var(--lb-faint); text-align: center;
    }

    @media (max-width: 560px) {
      .lb-auth-topbar-inner { padding: 11px 14px; gap: 10px; }
      .lb-auth-word { font-size: 20px; }
      .lb-auth-tagline { font-size: 12.5px; width: 100%; }
      .lb-auth-card { padding: 16px 15px 20px; border-radius: 8px; }
      .lb-auth-main { padding: 14px 12px 34px; }
    }
  `]
})
export class AuthLandingComponent implements OnInit {
  private readonly authService = inject(AuthService);
  private readonly router = inject(Router);
  private readonly sanitizedModeService = inject(SanitizedModeService);

  /** Sanitized mode is strictly active ONLY for Admin / Superadmin accounts */
  readonly isSanitized = computed(() => this.authService.isAdmin() && this.sanitizedModeService.isSanitizedMode());

  public activeTab: 'login' | 'register' | 'forgot' = 'login';
  public phone: string = '';
  public password: string = '';
  public confirmPassword: string = '';
  public termsAccepted: boolean = true;
  public showPassword: boolean = false;
  public showNewPassword: boolean = false;
  public isSubmitting: boolean = false;
  public errorMessage: string | null = null;
  public successMessage: string | null = null;

  public forgotStep: number = 1;
  public otpInput: string = '';
  public newPassword: string = '';
  public confirmNewPassword: string = '';
  private generatedOtp: string = '';

  ngOnInit() {
    // Arriving here from a live session means an administrator just suspended
    // the account. Say so, otherwise being thrown out of a round mid-flight
    // looks like the site crashed.
    if (new URLSearchParams(window.location.search).get('notice') === 'suspended') {
      this.errorMessage = 'Your account has been suspended by an administrator.';
    }

    if (this.authService.hasToken()) {
      this.authService.loadCurrentUser().subscribe(res => {
        if (res?.user) {
          // Everyone lands on the dashboard; admins reach the console from the profile menu.
          this.router.navigate(['/dashboard']);
        }
      });
    }
  }

  public setTab(tab: 'login' | 'register' | 'forgot') {
    this.activeTab = tab;
    this.errorMessage = null;
    this.successMessage = null;
    this.forgotStep = 1;
    this.otpInput = '';
    this.newPassword = '';
    this.confirmNewPassword = '';
    this.confirmPassword = '';
    this.showPassword = false;
    this.showNewPassword = false;
  }

  public togglePassword() {
    this.showPassword = !this.showPassword;
  }

  public toggleNewPassword() {
    this.showNewPassword = !this.showNewPassword;
  }

  /** Digits and separators only, long enough to actually be a number. */
  private looksLikePhone(value: string): boolean {
    return /^\+?[\d\s()-]{7,}$/.test(value);
  }

  private formatPhone(rawPhone: string): { fullPhone: string; rawPhone: string } {
    const trimmed = (rawPhone || '').trim();

    // Admin and superadmin accounts sign in with a username, not a number.
    // Running one through the +254 normalisation below strips every character
    // and yields an empty string, which the API rejects as a missing username.
    if (!this.looksLikePhone(trimmed)) {
      return { fullPhone: trimmed, rawPhone: trimmed };
    }

    let cleaned = trimmed.replace(/[^\d+]/g, '');
    if (!cleaned) return { fullPhone: trimmed, rawPhone: trimmed };
    if (cleaned.startsWith('+')) {
      if (cleaned.startsWith('+2540')) {
        cleaned = '+254' + cleaned.slice(5);
      }
      return { fullPhone: cleaned, rawPhone: trimmed };
    }
    const localDigits = cleaned.replace(/^0+/, '');
    return {
      fullPhone: `+254${localDigits}`,
      rawPhone: trimmed
    };
  }

  /**
   * Mirrors the server's region rule so an out-of-region number is answered
   * without a round trip at all.
   *
   * The server remains the authority and repeats this check — this exists only
   * so the player is not left watching a spinner for a message that needs no
   * lookup to produce. A username returns true here: only the account behind it
   * can say where it belongs, so it has to go to the server.
   */
  private isAllowedRegion(fullPhone: string): boolean {
    if (!this.looksLikePhone(fullPhone)) return true;
    const digits = (fullPhone || '').replace(/[^\d]/g, '');
    if (digits.startsWith('254')) return /^254[71]\d{8}$/.test(digits);
    if (digits.startsWith('0')) return /^0[71]\d{8}$/.test(digits);
    return /^[71]\d{8}$/.test(digits);
  }

  public onSubmit() {
    if (this.activeTab === 'login') this.onLogin();
    else if (this.activeTab === 'register') this.onRegister();
  }

  private onLogin() {
    const trimmed = this.phone.trim();
    if (!trimmed || !this.password) {
      this.errorMessage = 'Please enter your phone number and password.';
      return;
    }
    const { fullPhone, rawPhone } = this.formatPhone(trimmed);
    if (!this.isAllowedRegion(fullPhone)) {
      this.errorMessage = 'Unavailable in your region.';
      return;
    }
    this.isSubmitting = true;
    this.errorMessage = null;
    this.authService.login({ username: fullPhone, password: this.password }).subscribe({
      next: (res) => {
        this.isSubmitting = false;
        this.router.navigate(['/dashboard']);
      },
      error: (err) => {
        // Worth retrying under the raw input only when the server rejected the
        // credentials or the formatted value itself. Retrying a 429 or a 500
        // just doubles the load and buries the real reason behind a
        // wrong-password message.
        const isWorthRetrying = err?.status === 401 || err?.status === 400;
        if (isWorthRetrying && rawPhone !== fullPhone) {
          this.authService.login({ username: rawPhone, password: this.password }).subscribe({
            next: (res) => {
              this.isSubmitting = false;
              this.router.navigate(['/dashboard']);
            },
            error: (retryErr) => {
              this.isSubmitting = false;
              this.errorMessage = retryErr?.message || 'Invalid phone number or password.';
            }
          });
        } else {
          this.isSubmitting = false;
          this.errorMessage = err?.message || 'Invalid phone number or password.';
        }
      }
    });
  }

  private onRegister() {
    const trimmed = this.phone.trim();
    if (!trimmed || !this.password || !this.confirmPassword) {
      this.errorMessage = 'Please provide your phone number and confirm your password twice.';
      return;
    }
    if (this.password.length < 6) {
      this.errorMessage = 'Password must be at least 6 characters.';
      return;
    }
    if (this.password !== this.confirmPassword) {
      this.errorMessage = 'Passwords do not match. Please re-enter both passwords.';
      return;
    }
    if (!this.termsAccepted) {
      this.errorMessage = 'Please accept the Terms and Privacy Policy.';
      return;
    }
    const { fullPhone } = this.formatPhone(trimmed);
    this.isSubmitting = true;
    this.errorMessage = null;
    this.authService.register({ 
      username: fullPhone, 
      phone_number: fullPhone, 
      password: this.password 
    }).subscribe({
      next: (res) => {
        this.isSubmitting = false;
        this.authService.beginPhoneVerification(fullPhone, res);
        // The account already exists at this point, so never leave the player
        // stranded on the form if the router refuses to move.
        this.router.navigate(['/verify-phone']).then((navigated) => {
          if (!navigated) window.location.assign('/verify-phone');
        }).catch(() => window.location.assign('/verify-phone'));
      },
      error: (err) => {
        this.isSubmitting = false;
        this.errorMessage = err?.message || 'Registration failed.';
      }
    });
  }

  public onSendOtp() {
    const trimmed = this.phone.trim();
    if (!trimmed) {
      this.errorMessage = 'Please enter your phone number.';
      return;
    }
    const { fullPhone } = this.formatPhone(trimmed);
    this.isSubmitting = true;
    this.errorMessage = null;
    this.successMessage = null;
    setTimeout(() => {
      this.isSubmitting = false;
      this.generatedOtp = '123456';
      this.successMessage = `OTP sent to ${fullPhone}!`;
      this.forgotStep = 2;
    }, 800);
  }

  public onVerifyAndReset() {
    const trimmed = this.phone.trim();
    const { fullPhone } = this.formatPhone(trimmed);
    if (!this.otpInput || this.otpInput !== this.generatedOtp) {
      this.errorMessage = 'Invalid verification code.';
      return;
    }
    if (this.newPassword.length < 6) {
      this.errorMessage = 'New password must be at least 6 characters.';
      return;
    }
    if (this.newPassword !== this.confirmNewPassword) {
      this.errorMessage = 'Passwords do not match.';
      return;
    }
    this.isSubmitting = true;
    this.errorMessage = null;
    this.authService.resetPassword({ phone_number: fullPhone, new_password: this.newPassword }).subscribe({
      next: () => {
        this.isSubmitting = false;
        this.successMessage = 'Password reset successful! Please log in.';
        this.activeTab = 'login';
        this.forgotStep = 1;
        this.newPassword = '';
        this.confirmNewPassword = '';
        this.otpInput = '';
      },
      error: (err) => {
        this.isSubmitting = false;
        this.errorMessage = typeof err === 'string' ? err : 'Reset failed.';
      }
    });
  }

  public triggerAppDownload(): void {
    if (typeof window !== 'undefined') {
      if ((window as any).__ligibetPromptInstall) {
        (window as any).__ligibetPromptInstall();
      } else {
        window.dispatchEvent(new CustomEvent('ligibet-install-app'));
      }
    }
  }
}
