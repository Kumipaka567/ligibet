import { Component, OnInit, signal, computed, effect, ChangeDetectorRef, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { WithdrawalNoticeComponent } from './shared/withdrawal-notice/withdrawal-notice.component';
import { SanitizedModeService } from './core/services/sanitized-mode.service';

import { AuthService } from './core/services/auth.service';

// Routes whose own layout already carries a download banner. The floating card is
// fixed to the bottom of the viewport, so leaving it up here would sit on top of
// the "Log in" / "Create account" buttons and swallow the taps.
const PROMPT_FREE_ROUTES = ['/login', '/verify-phone'];

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, RouterOutlet, WithdrawalNoticeComponent],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App implements OnInit {
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly router = inject(Router);
  private readonly authService = inject(AuthService);
  public readonly sanitizedMode = inject(SanitizedModeService);
  public readonly isSanitized = computed(() => this.isAdminUser() && this.sanitizedMode.isSanitizedMode());
  public readonly isAdminUser = signal<boolean>(false);
  protected readonly title = signal('frontend');

  constructor() {
    effect(() => {
      const sanitized = this.isSanitized();
      if (typeof document !== 'undefined') {
        document.title = sanitized
          ? 'Ligi - Interactive Sports, Live Scores & Games'
          : 'LigiBet - Sports Betting & Aviator Casino';
      }
    });
  }

  // Floating App Download & Home Screen State
  public showDownloadPrompt = signal<boolean>(true);
  public isDownloading = signal<boolean>(false);
  public isIosDevice = signal<boolean>(false);
  public showIosGuide = signal<boolean>(false);
  public isPromptFreeRoute = signal<boolean>(false);
  private deferredPrompt: any = null;

  ngOnInit(): void {
    this.authService.currentUser$.subscribe(user => {
      const isAdmin = user?.role === 'admin' || user?.role === 'superadmin';
      this.isAdminUser.set(isAdmin);
      this.cdr.detectChanges();
    });
    this.checkDevice();
    this.checkDownloadStatus();
    this.trackPromptFreeRoutes();

    // Global install trigger accessible from all components
    (window as any).__ligibetPromptInstall = () => this.downloadApp();
    window.addEventListener('ligibet-install-app', () => this.downloadApp());

    // Listen for PWA beforeinstallprompt event
    window.addEventListener('beforeinstallprompt', (e: Event) => {
      e.preventDefault();
      this.deferredPrompt = e;
      this.checkDownloadStatus();
    });

    // Listen for appinstalled event (fired when user adds to home screen)
    window.addEventListener('appinstalled', () => {
      localStorage.setItem('ligibet_app_downloaded', 'true');
      sessionStorage.setItem('ligibet_prompt_dismissed', 'true');
      this.showDownloadPrompt.set(false);
      this.showIosGuide.set(false);
      this.cdr.detectChanges();
    });
  }

  private trackPromptFreeRoutes(): void {
    this.updatePromptFreeRoute(this.router.url);
    this.router.events
      .pipe(filter((event): event is NavigationEnd => event instanceof NavigationEnd))
      .subscribe((event) => {
        this.updatePromptFreeRoute(event.urlAfterRedirects || event.url);
        this.cdr.detectChanges();
      });
  }

  private updatePromptFreeRoute(url: string): void {
    const path = (url || '').split('?')[0].split('#')[0];
    // The root path always redirects to /login, so suppress the card there too and
    // avoid flashing it over the form during the initial navigation.
    const isRoot = path === '' || path === '/';
    this.isPromptFreeRoute.set(isRoot || PROMPT_FREE_ROUTES.some((route) => path === route || path.startsWith(`${route}/`)));
  }

  private checkDevice(): void {
    if (typeof navigator !== 'undefined') {
      const userAgent = navigator.userAgent || '';
      const isIos = /iPad|iPhone|iPod/.test(userAgent) && !(window as any).MSStream;
      this.isIosDevice.set(isIos);
    }
  }

  public checkDownloadStatus(): void {
    try {
      // Check if running in standalone PWA mode already
      const isStandalone = typeof window !== 'undefined' && (window.matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone);
      if (isStandalone) {
        this.showDownloadPrompt.set(false);
        return;
      }

      // Check session dismissal
      const isDismissed = typeof sessionStorage !== 'undefined' && sessionStorage.getItem('ligibet_prompt_dismissed') === 'true';
      if (isDismissed) {
        this.showDownloadPrompt.set(false);
      } else {
        this.showDownloadPrompt.set(true);
      }
      this.cdr.detectChanges();
    } catch {
      this.showDownloadPrompt.set(true);
    }
  }

  public downloadApp(): void {
    this.isDownloading.set(true);

    try {
      // Mark session and local storage
      sessionStorage.setItem('ligibet_prompt_dismissed', 'true');
      localStorage.setItem('ligibet_app_downloaded', 'true');
      localStorage.setItem('ligibet_app_download_time', new Date().toISOString());

      // If PWA prompt is ready (Android/Chrome/Edge), trigger native Add to Home Screen dialog
      if (this.deferredPrompt) {
        this.deferredPrompt.prompt();
        this.deferredPrompt.userChoice.then((choiceResult: { outcome: string }) => {
          if (choiceResult.outcome === 'accepted') {
            localStorage.setItem('ligibet_app_downloaded', 'true');
          }
          this.deferredPrompt = null;
        }).catch(() => {});
      } else if (this.isIosDevice()) {
        // Show iOS Add to Home Screen step-by-step guidance
        this.showIosGuide.set(true);
      }
    } catch (e) {
      console.error('Install error:', e);
    }

    // Smoothly fade out and remove prompt
    setTimeout(() => {
      this.isDownloading.set(false);
      if (!this.showIosGuide()) {
        this.showDownloadPrompt.set(false);
      }
      this.cdr.detectChanges();
    }, 1200);
  }

  public dismissPrompt(): void {
    // Dismissing sets downloaded flag so it never comes back
    localStorage.setItem('ligibet_app_downloaded', 'true');
    this.showDownloadPrompt.set(false);
    this.showIosGuide.set(false);
    this.cdr.detectChanges();
  }
}
