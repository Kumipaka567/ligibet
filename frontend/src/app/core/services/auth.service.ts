import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { BehaviorSubject, Observable, tap, catchError, of, throwError } from 'rxjs';
import { getBackendOrigin } from '../config/backend-url';

export interface User {
  id: number;
  username: string;
  phone_number?: string;
  balance: number;
  role: 'user' | 'admin' | 'superadmin';
  bonus_claimed?: boolean;
}


export interface AuthResponse {
  token: string;
  user: User;
  message?: string;
}

export interface AuthError {
  /** HTTP status, or 0 when the request never reached the server. */
  status: number;
  message: string;
}

interface PendingPhoneVerification {
  phoneNumber: string;
  authResult: AuthResponse;
  generatedOtp: string;
}

export interface DepositRecord {
  id: number;
  amount: number;
  status: 'pending' | 'completed' | 'failed';
  mpesa_receipt_number?: string;
  payment_method: string;
  created_at: string;
}

export interface TransactionRecord {
  id: number;
  type: string;
  amount: number;
  status: 'completed' | 'failed' | 'pending';
  reference?: string;
  failure_reason?: string | null;
  mpesa_receipt_number?: string | null;
  created_at: string;
}

export interface WithdrawalNotification {
  id: number;
  title: string;
  message: string;
  type: 'completed' | 'pending' | 'rejected' | 'info';
  amount?: number;
  status?: 'completed' | 'pending' | 'rejected';
  createdAt: string;
}

export interface WithdrawalResponse {
  message: string;
  balance: number;
  status: 'completed' | 'pending';
  notification: WithdrawalNotification | string;
}

export interface BonusClaimResponse {
  message: string;
  balance: number;
  bonusClaimed: boolean;
  notification: {
    id: number;
    title: string;
    message: string;
    type: 'bonus';
    createdAt: string;
  };
}

@Injectable({
  providedIn: 'root'
})
export class AuthService {
  private get baseUrl(): string {
    return `${getBackendOrigin()}/api`;
  }
  private get apiUrl(): string { return `${this.baseUrl}/auth`; }
  private tokenKey = 'aviator_jwt_token';
  private pendingPhoneVerificationKey = 'aviator_pending_phone_verification';
  private pendingPhoneVerification: PendingPhoneVerification | null = null;
  // Survives a blocked storage for the life of the page, so a player can still
  // finish signing up even when the browser refuses to persist anything.
  private memoryToken: string | null = null;


  public currentUser$ = new BehaviorSubject<User | null>(null);
  public isAuthenticated$ = new BehaviorSubject<boolean>(this.hasToken());
  public userBalance$ = new BehaviorSubject<number>(0);

  constructor(private http: HttpClient) {
    if (this.hasToken()) {
      this.loadCurrentUser().subscribe();
    }
  }

  /**
   * Storage throws outright in several real browser contexts — Safari private
   * mode, some in-app webviews, and anything with site data blocked. Every one
   * of these calls used to be unguarded, so a single throw escaped mid-signup
   * and left the verification screen spinning with no error path.
   */
  private readStore(kind: 'local' | 'session', key: string): string | null {
    try {
      return (kind === 'local' ? localStorage : sessionStorage).getItem(key);
    } catch {
      return null;
    }
  }

  private writeStore(kind: 'local' | 'session', key: string, value: string): boolean {
    try {
      (kind === 'local' ? localStorage : sessionStorage).setItem(key, value);
      return true;
    } catch {
      return false;
    }
  }

  private clearStore(kind: 'local' | 'session', key: string): void {
    try {
      (kind === 'local' ? localStorage : sessionStorage).removeItem(key);
    } catch {
      /* nothing to clear if storage is unavailable */
    }
  }

  public getToken(): string | null {
    return this.readStore('local', this.tokenKey) ?? this.memoryToken;
  }

  public hasToken(): boolean {
    return !!this.getToken();
  }

  public isAdmin(): boolean {
    const role = this.currentUser$.getValue()?.role;
    return role === 'admin' || role === 'superadmin';
  }

  public isSuperAdmin(): boolean {
    return this.currentUser$.getValue()?.role === 'superadmin';
  }


  public setSession(authResult: AuthResponse): void {
    this.memoryToken = authResult.token;
    this.writeStore('local', this.tokenKey, authResult.token);
    this.currentUser$.next(authResult.user);
    this.userBalance$.next(authResult.user.balance);
    this.isAuthenticated$.next(true);
  }

  public beginPhoneVerification(phoneNumber: string, authResult: AuthResponse): void {
    this.pendingPhoneVerification = {
      phoneNumber,
      authResult,
      generatedOtp: this.generatePhoneVerificationCode()
    };
    this.writeStore(
      'session',
      this.pendingPhoneVerificationKey,
      JSON.stringify(this.pendingPhoneVerification)
    );
  }

  public getPendingPhoneVerification(): PendingPhoneVerification | null {
    if (this.pendingPhoneVerification) return this.pendingPhoneVerification;

    const storedVerification = this.readStore('session', this.pendingPhoneVerificationKey);
    if (!storedVerification) return null;

    try {
      const pendingVerification = JSON.parse(storedVerification) as PendingPhoneVerification;
      if (!pendingVerification.phoneNumber || !pendingVerification.generatedOtp || !pendingVerification.authResult?.token) {
        this.clearStore('session', this.pendingPhoneVerificationKey);
        return null;
      }

      this.pendingPhoneVerification = pendingVerification;
      return pendingVerification;
    } catch {
      this.clearStore('session', this.pendingPhoneVerificationKey);
      return null;
    }
  }

  public completePhoneVerification(): AuthResponse | null {
    const pendingVerification = this.getPendingPhoneVerification();
    if (!pendingVerification) return null;

    this.setSession(pendingVerification.authResult);
    this.pendingPhoneVerification = null;
    this.clearStore('session', this.pendingPhoneVerificationKey);
    return pendingVerification.authResult;
  }

  private generatePhoneVerificationCode(): string {
    if (globalThis.crypto?.getRandomValues) {
      const values = new Uint32Array(1);
      globalThis.crypto.getRandomValues(values);
      return (100000 + (values[0] % 900000)).toString();
    }

    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  private extractErrorMessage(err: any): string {
    if (err && err.error && typeof err.error === 'object' && err.error.error) {
      return err.error.error;
    }
    if (err && typeof err.error === 'string') {
      return err.error;
    }
    if (err && err.message) {
      return err.message;
    }
    return 'Connection to server failed. Please ensure backend is running.';
  }

  /**
   * Keeps the HTTP status alongside the message. Without it the auth screen
   * cannot tell a genuine wrong password from a 429 or a 500, and reported
   * every one of them as "Invalid phone number or password".
   */
  private toAuthError(err: any): AuthError {
    return {
      status: typeof err?.status === 'number' ? err.status : 0,
      message: this.extractErrorMessage(err)
    };
  }

  public register(credentials: { username: string; phone_number?: string; password: string }): Observable<AuthResponse> {
    return this.http.post<AuthResponse>(`${this.apiUrl}/register`, credentials).pipe(
      catchError(err => throwError(() => this.toAuthError(err)))
    );
  }

  public login(credentials: { username: string; password: string }): Observable<AuthResponse> {
    return this.http.post<AuthResponse>(`${this.apiUrl}/login`, credentials).pipe(
      tap(res => this.setSession(res)),
      catchError(err => throwError(() => this.toAuthError(err)))
    );
  }

  public resetPassword(data: { phone_number: string; new_password: string }): Observable<{ message: string }> {
    return this.http.post<{ message: string }>(`${this.apiUrl}/reset-password`, data).pipe(
      catchError(err => throwError(() => this.extractErrorMessage(err)))
    );
  }

  public loadCurrentUser(): Observable<{ user: User } | null> {
    const token = this.getToken();
    if (!token) return of(null);

    const headers = new HttpHeaders({
      Authorization: `Bearer ${token}`
    });

    return this.http.get<{ user: User }>(`${this.apiUrl}/me`, { headers }).pipe(
      tap(res => {
        if (res && res.user) {
          this.currentUser$.next(res.user);
          this.userBalance$.next(res.user.balance);
          this.isAuthenticated$.next(true);
        }
      }),
      catchError(() => {
        this.logout();
        return of(null);
      })
    );
  }

  // The minimum deposit is admin-configurable, so the client reads the live
  // value instead of hardcoding it. Cached for the page so the deposit modal
  // opens instantly; the server enforces the real rule either way.
  public readonly minimumDeposit$ = new BehaviorSubject<number>(999);
  private minimumDepositLoaded = false;

  public get minimumDeposit(): number {
    return this.minimumDeposit$.value;
  }

  public loadMinimumDeposit(force = false): void {
    if (this.minimumDepositLoaded && !force) return;
    this.minimumDepositLoaded = true;
    this.http.get<{ minimum_deposit: number }>(`${this.baseUrl}/settings/deposit`).pipe(
      catchError(() => of({ minimum_deposit: this.minimumDeposit$.value }))
    ).subscribe(res => {
      const value = Number(res?.minimum_deposit);
      if (Number.isFinite(value) && value > 0) this.minimumDeposit$.next(value);
    });
  }

  public initiateMpesaSTKPush(amount: number, phone?: string): Observable<{ message: string; checkoutRequestId: string }> {
    const token = this.getToken();
    const headers = new HttpHeaders({ Authorization: `Bearer ${token}` });
    return this.http.post<{ message: string; checkoutRequestId: string }>(
      `${this.baseUrl}/mpesa/stk-push`,
      { amount, phone },
      { headers }
    ).pipe(
      catchError(err => throwError(() => this.extractErrorMessage(err)))
    );
  }

  /**
   * Remaining deposit lockout for the signed-in player, if any.
   *
   * Read-only, and deliberately its own call rather than something folded into
   * the deposit request: the deposit screen polls this to show the countdown,
   * which keeps the countdown entirely outside the deposit flow. It never
   * throws — a failed check reports "not in cooldown" and lets the deposit
   * endpoint stay the authority on whether an attempt is allowed.
   */
  public getDepositCooldown(): Observable<{ inCooldown: boolean; cooldownUntil?: number; retryAfterSeconds?: number }> {
    const headers = this.getAuthHeaders();
    return this.http.get<{ inCooldown: boolean; cooldownUntil?: number; retryAfterSeconds?: number }>(
      `${this.baseUrl}/mpesa/cooldown`,
      { headers }
    ).pipe(
      catchError(() => of({ inCooldown: false }))
    );
  }

  public getDepositHistory(): Observable<{ deposits: DepositRecord[] }> {
    const headers = this.getAuthHeaders();
    return this.http.get<{ deposits: DepositRecord[] }>(
      `${this.baseUrl}/wallet/deposits`,
      { headers }
    ).pipe(
      catchError(err => throwError(() => this.extractErrorMessage(err)))
    );
  }

  public getTransactionHistory(): Observable<{ transactions: TransactionRecord[]; bets: any[] }> {
    const headers = this.getAuthHeaders();
    return this.http.get<{ transactions: TransactionRecord[]; bets: any[] }>(
      `${this.baseUrl}/wallet/transactions`,
      { headers }
    ).pipe(
      catchError(err => throwError(() => this.extractErrorMessage(err)))
    );
  }

  public checkMpesaStatus(checkoutRequestId: string): Observable<{ status: string; reason?: string | null; receiptNumber: string | null; balance?: number }> {
    const token = this.getToken();
    const headers = new HttpHeaders({ Authorization: `Bearer ${token}` });
    return this.http.post<{ status: string; reason?: string | null; receiptNumber: string | null; balance?: number }>(
      `${this.baseUrl}/mpesa/stk-status`,
      { checkoutRequestId },
      { headers }
    ).pipe(
      catchError(err => throwError(() => this.extractErrorMessage(err)))
    );
  }

  public cancelPendingMpesa(checkoutRequestId: string): Observable<any> {
    const token = this.getToken();
    const headers = new HttpHeaders({ Authorization: `Bearer ${token}` });
    return this.http.post<any>(
      `${this.baseUrl}/mpesa/cancel-pending`,
      { checkoutRequestId },
      { headers }
    ).pipe(
      catchError(err => throwError(() => this.extractErrorMessage(err)))
    );
  }

  /** Legacy demo deposit — kept for admin use */
  public deposit(amount: number): Observable<{ message: string; balance: number }> {
    const token = this.getToken();
    const headers = new HttpHeaders({
      Authorization: `Bearer ${token}`
    });

    return this.http.post<{ message: string; balance: number }>(`${this.apiUrl}/deposit`, { amount }, { headers }).pipe(
      tap(res => {
        this.updateBalance(res.balance);
      }),
      catchError(err => throwError(() => this.extractErrorMessage(err)))
    );
  }

  public withdraw(amount: number): Observable<WithdrawalResponse> {
    const token = this.getToken();
    const headers = new HttpHeaders({
      Authorization: `Bearer ${token}`
    });

    return this.http.post<WithdrawalResponse>(
      `${this.baseUrl}/wallet/withdraw`,
      { amount },
      { headers }
    ).pipe(
      tap(res => this.updateBalance(res.balance)),
      catchError(err => throwError(() => this.extractErrorMessage(err)))
    );
  }

  public changePassword(currentPassword: string, newPassword: string): Observable<{ message: string }> {
    return this.http.post<{ message: string }>(
      `${this.baseUrl}/user/change-password`,
      { currentPassword, newPassword },
      { headers: this.getAuthHeaders() }
    ).pipe(
      catchError(err => throwError(() => this.extractErrorMessage(err)))
    );
  }

  public changeUsername(newUsername: string): Observable<{ message: string; username: string }> {
    return this.http.post<{ message: string; username: string }>(
      `${this.baseUrl}/user/change-username`,
      { newUsername },
      { headers: this.getAuthHeaders() }
    ).pipe(
      tap(res => {
        const current = this.currentUser$.getValue();
        if (current && res?.username) this.currentUser$.next({ ...current, username: res.username });
      }),
      catchError(err => throwError(() => this.extractErrorMessage(err)))
    );
  }

  public claimWelcomeBonus(): Observable<BonusClaimResponse> {
    const headers = this.getAuthHeaders();
    return this.http.post<BonusClaimResponse>(`${this.baseUrl}/bonus/claim`, {}, { headers }).pipe(
      tap(res => {
        this.updateBalance(res.balance);
        const currentUser = this.currentUser$.getValue();
        if (currentUser) {
          this.currentUser$.next({ ...currentUser, bonus_claimed: res.bonusClaimed });
        }
      }),
      catchError(err => throwError(() => this.extractErrorMessage(err)))
    );
  }

  public updateBalance(newBalance: number): void {
    this.userBalance$.next(newBalance);
    const currentUser = this.currentUser$.getValue();
    if (currentUser) {
      this.currentUser$.next({ ...currentUser, balance: newBalance });
    }
  }

  public logout(): void {
    this.memoryToken = null;
    this.clearStore('local', this.tokenKey);
    this.currentUser$.next(null);
    this.userBalance$.next(0);
    this.isAuthenticated$.next(false);
  }

  public getAuthHeaders(): HttpHeaders {
    const token = this.getToken();
    return new HttpHeaders({
      Authorization: token ? `Bearer ${token}` : ''
    });
  }
}
