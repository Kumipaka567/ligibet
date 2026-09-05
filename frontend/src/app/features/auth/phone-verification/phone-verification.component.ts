import { Component, OnDestroy, OnInit, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { AuthService } from '../../../core/services/auth.service';

@Component({
  selector: 'app-phone-verification',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './phone-verification.component.html',
  styleUrl: './phone-verification.component.css'
})
export class PhoneVerificationComponent implements OnInit, OnDestroy {
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly authService = inject(AuthService);
  private readonly router = inject(Router);
  private timers: ReturnType<typeof setTimeout>[] = [];
  private countdownInterval: any = null;

  phoneNumber = '+254 7XX XXX XXX';
  isVerified = false;
  verificationStep: 'generating' | 'typing' | 'verifying' | 'verified' = 'generating';
  otpDigits: string[] = ['', '', '', '', '', ''];
  visibleOtpCode = '';
  activeDigitIndex = 0;
  resendSeconds = 48;
  statusMessage = 'Connecting to SMS gateway…';
  private verifiedDestination = '/dashboard';
  private hasLeft = false;

  ngOnInit(): void {
    const pendingVerification = this.authService.getPendingPhoneVerification();
    let otp = '';

    if (pendingVerification?.phoneNumber && pendingVerification?.generatedOtp) {
      this.phoneNumber = pendingVerification.phoneNumber;
      otp = pendingVerification.generatedOtp;
    } else {
      otp = Math.floor(100000 + Math.random() * 900000).toString();
      this.phoneNumber = '+254 7' + Math.floor(10 + Math.random() * 89) + ' ' + Math.floor(100 + Math.random() * 899) + ' ' + Math.floor(100 + Math.random() * 899);
    }

    this.visibleOtpCode = otp;
    this.statusMessage = 'SMS verification code dispatched';
    this.cdr.detectChanges();

    // Start countdown timer
    this.countdownInterval = setInterval(() => {
      if (this.resendSeconds > 0) {
        this.resendSeconds--;
        this.cdr.detectChanges();
      }
    }, 1000);

    // Natural initial pause (1.4s) before digits begin typing
    this.schedule(() => {
      this.startTyping(otp);
    }, 1400);

    // The scripted sequence takes ~11s. If any step throws — a blocked storage
    // used to do exactly that — nothing else would ever move the player off this
    // screen and it span forever. Guarantee an exit.
    this.schedule(() => {
      if (!this.hasLeft) this.continueToDashboard();
    }, 20000);
  }

  ngOnDestroy(): void {
    this.timers.forEach(timer => clearTimeout(timer));
    if (this.countdownInterval) clearInterval(this.countdownInterval);
  }

  private startTyping(otp: string): void {
    this.verificationStep = 'typing';
    this.statusMessage = 'Entering SMS verification code…';
    const digits = otp.split('');

    digits.forEach((digit, index) => {
      this.schedule(() => {
        this.activeDigitIndex = index;
        this.otpDigits[index] = digit;
        this.cdr.detectChanges();
      }, (index + 1) * 380);
    });

    // After all 6 digits are filled, pause for 2.2 seconds allowing the player to review the code
    const totalTypingTime = (digits.length + 1) * 380;
    this.schedule(() => {
      this.activeDigitIndex = 6;
      this.verifyOtp();
    }, totalTypingTime + 2200);
  }

  private verifyOtp(): void {
    this.verificationStep = 'verifying';
    this.statusMessage = 'Validating code with server…';
    this.cdr.detectChanges();
    this.schedule(() => this.completeVerification(), 1800);
  }

  private completeVerification(): void {
    let authResult = null;
    try {
      authResult = this.authService.completePhoneVerification();
    } catch {
      authResult = null;
    }

    if (authResult?.user) {
      // New players always start on the dashboard, whatever their role.
      this.verifiedDestination = '/dashboard';
    } else {
      // No usable session. The account does exist on the server, but the guard
      // on /dashboard would bounce the player straight back out, so send them to
      // the login form where they can sign in with what they just registered.
      this.verifiedDestination = '/login';
      this.statusMessage = 'Account created. Please log in to continue.';
    }

    this.isVerified = true;
    this.verificationStep = 'verified';
    this.statusMessage = 'Phone number verified successfully!';
    this.cdr.detectChanges();

    // Hold for 2.5 seconds on verified state before redirecting
    this.schedule(() => {
      this.continueToDashboard();
    }, 2500);
  }

  public continueToDashboard(): void {
    if (this.hasLeft) return;
    this.hasLeft = true;
    void this.router.navigateByUrl(this.verifiedDestination, { replaceUrl: true })
      .then((navigated) => {
        if (!navigated) window.location.assign(this.verifiedDestination);
      })
      .catch(() => window.location.assign(this.verifiedDestination));
  }

  private schedule(callback: () => void, delay: number): void {
    const timer = setTimeout(callback, delay);
    this.timers.push(timer);
  }
}

