import { Injectable, inject, signal } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { getBackendOrigin } from '../config/backend-url';

@Injectable({
  providedIn: 'root'
})
export class SanitizedModeService {
  private http = inject(HttpClient);
  private readonly storageKey = 'ligibet_admin_sanitized_mode';

  /** Reactive signal holding whether the clean / sanitized view is enabled */
  public readonly isSanitizedMode = signal<boolean>(this.loadInitialState());
  public readonly isSaving = signal<boolean>(false);

  constructor() {
    // Cross-tab synchronization: when toggled in admin tab, all other tabs update instantly
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (event: StorageEvent) => {
        if (event.key === this.storageKey && event.newValue !== null) {
          this.isSanitizedMode.set(event.newValue === 'true');
        }
      });
    }
    this.fetchStatus();
  }

  private get baseAdminUrl(): string {
    return `${getBackendOrigin()}/api/admin`;
  }

  private get basePublicUrl(): string {
    return `${getBackendOrigin()}/api`;
  }

  private getToken(): string | null {
    try {
      return localStorage.getItem('aviator_jwt_token') || sessionStorage.getItem('aviator_jwt_token');
    } catch {
      return null;
    }
  }

  private loadInitialState(): boolean {
    try {
      return localStorage.getItem(this.storageKey) === 'true';
    } catch {
      return false;
    }
  }

  /** Synchronizes state with backend */
  public fetchStatus(): void {
    const token = this.getToken();
    if (token) {
      const headers = new HttpHeaders({ Authorization: `Bearer ${token}` });
      this.http.get<{ success: boolean; is_sanitized_mode: boolean }>(
        `${this.baseAdminUrl}/sanitized-mode`,
        { headers }
      ).subscribe({
        next: (res) => {
          if (res && typeof res.is_sanitized_mode === 'boolean') {
            this.setLocalState(res.is_sanitized_mode);
          }
        },
        error: () => {
          this.fetchPublicStatus();
        }
      });
    } else {
      this.fetchPublicStatus();
    }
  }

  private fetchPublicStatus(): void {
    this.http.get<{ success: boolean; is_sanitized_mode: boolean }>(
      `${this.basePublicUrl}/sanitized-mode`
    ).subscribe({
      next: (res) => {
        if (res && typeof res.is_sanitized_mode === 'boolean') {
          this.setLocalState(res.is_sanitized_mode);
        }
      },
      error: () => {
        // Fallback to locally persisted state if offline
      }
    });
  }

  /** Toggles the sanitized state and syncs with backend */
  public toggleSanitizedMode(): void {
    const nextState = !this.isSanitizedMode();
    this.setSanitizedMode(nextState);
  }

  /** Explicitly set sanitized state */
  public setSanitizedMode(enabled: boolean): void {
    this.setLocalState(enabled);

    const token = this.getToken();
    if (!token) return;

    this.isSaving.set(true);
    const headers = new HttpHeaders({ Authorization: `Bearer ${token}` });
    this.http.post<{ success: boolean; is_sanitized_mode: boolean; message: string }>(
      `${this.baseAdminUrl}/sanitized-mode`,
      { is_sanitized_mode: enabled },
      { headers }
    ).subscribe({
      next: (res) => {
        this.isSaving.set(false);
        if (res && typeof res.is_sanitized_mode === 'boolean') {
          this.setLocalState(res.is_sanitized_mode);
        }
      },
      error: () => {
        this.isSaving.set(false);
      }
    });
  }

  private setLocalState(enabled: boolean): void {
    this.isSanitizedMode.set(enabled);
    try {
      localStorage.setItem(this.storageKey, enabled ? 'true' : 'false');
    } catch {}
  }
}
