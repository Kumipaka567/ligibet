import { TestBed } from '@angular/core/testing';
import { App } from './app';
import { provideRouter } from '@angular/router';
import { BehaviorSubject } from 'rxjs';
import { vi } from 'vitest';
import { AuthService } from './core/services/auth.service';
import { GameSocketService } from './core/services/game-socket.service';
import { SanitizedModeService } from './core/services/sanitized-mode.service';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter([]),
        { provide: AuthService, useValue: { currentUser$: new BehaviorSubject(null), isAuthenticated$: new BehaviorSubject(false), getToken: () => null, logout: vi.fn() } },
        { provide: GameSocketService, useValue: { accountSuspended$: new BehaviorSubject(null), isConnected$: new BehaviorSubject(false), connect: vi.fn(), disconnect: vi.fn() } },
        { provide: SanitizedModeService, useValue: { isSanitizedMode: () => false } }
      ]
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it('renders the routed shell and one global withdrawal notice without covering the login route', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('router-outlet')).toBeTruthy();
    expect(compiled.querySelectorAll('app-withdrawal-notice').length).toBe(1);
    expect(compiled.querySelector('.ligibet-floating-download')).toBeNull();
  });
});
