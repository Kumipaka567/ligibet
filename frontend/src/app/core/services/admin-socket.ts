import { Injectable, NgZone, inject } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import { BehaviorSubject } from 'rxjs';
import { getBackendOrigin } from '../config/backend-url';

export type AdminRoundStatus = 'Waiting' | 'Running' | 'Crashed';
export type AdminGamePhase = 'betting' | 'flying' | 'crashed';

export interface AdminParticipant {
  username: string;
  betAmount: number;
  cashoutMultiplier: number | null;
  payoutAmount: number;
}

export interface AdminRoomStatus {
  room: number;
  isPrimary: boolean;
  roundId: number | null;
  nextCrashPoint: number | null;
  phase: string;
  multiplier: number;
  activeBets: number;
}

export interface AdminNextRound {
  roundId: number | null;
  nextRoundId: number | null;
  nextCrashPoint: number | null;
  serverSeed: string | null;
  hash: string | null;
  generatedAt: string | null;
  timeGenerated: string | null;
  bettingDurationMs: number;
  bettingClosesAt: number | null;
  countdownMs: number;
  status: AdminRoundStatus;
  /** Next crash point for every room, primary and secondary. */
  rooms?: AdminRoomStatus[];
}

export interface AdminPreviousRound {
  roundId: number | null;
  crashPoint: number | null;
  totalBets: number;
  totalStake: number;
  totalPayout: number;
  winnerCount: number;
  loserCount: number;
  winners: AdminParticipant[];
  losers: AdminParticipant[];
}

export interface AdminCurrentRound {
  roundId: number | null;
  phase: AdminGamePhase;
  status: AdminRoundStatus;
  currentMultiplier: number;
  numberOfBets: number;
  totalStake: number;
  estimatedPayout: number;
  connectedPlayers: number;
  onlineUsers: number;
}

export interface AdminHistoryRow {
  roundId: number;
  nextCrashPoint: number;
  generatedAt: string | null;
  status: AdminRoundStatus;
}

export interface AdminSnapshot {
  nextRound: AdminNextRound;
  previousRound: AdminPreviousRound;
  currentRound: AdminCurrentRound;
  history: AdminHistoryRow[];
}

export interface AdminRealtimeEvent {
  action: string;
  userId: number | null;
  occurredAt: string;
  balance?: number;
  role?: string;
  is_suspended?: boolean;
  is_online?: boolean;
  user?: {
    id: number;
    username?: string;
    phone_number?: string;
    balance?: number;
    role?: string;
    is_suspended?: boolean;
    created_at?: string;
    is_online?: boolean;
    has_custom_withdrawal_popup?: boolean;
    custom_withdrawal_title?: string;
    custom_withdrawal_message?: string;
  };
}

export interface AdminTransactionUpdate {
  id?: number;
  user_id: number;
  username?: string;
  phone_number?: string;
  type: string;
  amount: number;
  status: string;
  reference?: string;
  created_at?: string;
}

const EMPTY_NEXT_ROUND: AdminNextRound = {
  roundId: null,
  nextRoundId: null,
  nextCrashPoint: null,
  serverSeed: null,
  hash: null,
  generatedAt: null,
  timeGenerated: null,
  bettingDurationMs: 0,
  bettingClosesAt: null,
  countdownMs: 0,
  status: 'Waiting',
  rooms: []
};

const EMPTY_PREVIOUS_ROUND: AdminPreviousRound = {
  roundId: null,
  crashPoint: null,
  totalBets: 0,
  totalStake: 0,
  totalPayout: 0,
  winnerCount: 0,
  loserCount: 0,
  winners: [],
  losers: []
};

const EMPTY_CURRENT_ROUND: AdminCurrentRound = {
  roundId: null,
  phase: 'betting',
  status: 'Waiting',
  currentMultiplier: 1,
  numberOfBets: 0,
  totalStake: 0,
  estimatedPayout: 0,
  connectedPlayers: 0,
  onlineUsers: 0
};

@Injectable({
  providedIn: 'root'
})
export class AdminSocketService {
  private zone = inject(NgZone);
  private socket: Socket | null = null;
  private get serverUrl(): string {
    return `${getBackendOrigin()}/admin`;
  }


  public nextRound$ = new BehaviorSubject<AdminNextRound>(EMPTY_NEXT_ROUND);
  public previousRound$ = new BehaviorSubject<AdminPreviousRound>(EMPTY_PREVIOUS_ROUND);
  public currentRound$ = new BehaviorSubject<AdminCurrentRound>(EMPTY_CURRENT_ROUND);
  public history$ = new BehaviorSubject<AdminHistoryRow[]>([]);
  public isConnected$ = new BehaviorSubject<boolean>(false);
  public error$ = new BehaviorSubject<string | null>(null);
  public transactionUpdate$ = new BehaviorSubject<AdminTransactionUpdate | null>(null);
  public dashboardStatsUpdated$ = new BehaviorSubject<AdminRealtimeEvent | null>(null);
  public walletUpdated$ = new BehaviorSubject<AdminRealtimeEvent | null>(null);
  public transactionsUpdated$ = new BehaviorSubject<AdminRealtimeEvent | null>(null);
  public depositsUpdated$ = new BehaviorSubject<AdminRealtimeEvent | null>(null);
  public withdrawalsUpdated$ = new BehaviorSubject<AdminRealtimeEvent | null>(null);
  public userUpdated$ = new BehaviorSubject<AdminRealtimeEvent | null>(null);
  public activityUpdated$ = new BehaviorSubject<AdminRealtimeEvent | null>(null);
  public accessRevoked$ = new BehaviorSubject<{ userId: number; reason: string } | null>(null);
  public predatorTextUpdate$ = new BehaviorSubject<string | null>(null);

  public connect(token: string): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this.isConnected$.next(false);
    this.clearRealtimeEvents();

    this.socket = io(this.serverUrl, {
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000
    });

    this.listen('connect', () => {
      this.isConnected$.next(true);
      this.error$.next(null);
    });

    this.listen('connect_error', (err: Error) => {
      this.isConnected$.next(false);
      this.error$.next(err.message || 'Admin socket connection failed.');
    });

    this.listen('admin_snapshot', (snapshot: AdminSnapshot) => {
      this.applySnapshot(snapshot);
    });

    this.listen('admin_round_generated', (snapshot: AdminSnapshot) => {
      this.applySnapshot(snapshot);
    });

    this.listen('admin_next_round', (nextRound: AdminNextRound) => {
      this.nextRound$.next(nextRound);
    });

    this.listen('admin_betting_countdown', (data: Pick<AdminNextRound, 'roundId' | 'countdownMs' | 'bettingClosesAt'>) => {
      const current = this.nextRound$.getValue();
      if (current.roundId === data.roundId) {
        this.nextRound$.next({
          ...current,
          countdownMs: data.countdownMs,
          bettingClosesAt: data.bettingClosesAt
        });
      }
    });

    this.listen('admin_round_status', (data: {
      roundId: number;
      status: AdminRoundStatus;
      phase: AdminGamePhase;
      currentMultiplier: number;
      crashPoint: number | null;
      history: AdminHistoryRow[];
    }) => {
      const nextRound = this.nextRound$.getValue();
      if (nextRound.roundId === data.roundId) {
        this.nextRound$.next({
          ...nextRound,
          status: data.status,
          countdownMs: data.status === 'Waiting' ? nextRound.countdownMs : 0
        });
      }

      const currentRound = this.currentRound$.getValue();
      this.currentRound$.next({
        ...currentRound,
        roundId: data.roundId,
        phase: data.phase,
        status: data.status,
        currentMultiplier: data.crashPoint ?? data.currentMultiplier
      });
      this.history$.next(data.history);
    });

    this.listen('admin_current_round', (currentRound: AdminCurrentRound) => {
      this.currentRound$.next(currentRound);
    });

    this.listen('admin_previous_round', (data: { previousRound: AdminPreviousRound }) => {
      this.previousRound$.next(data.previousRound);
    });

    this.listen('admin_transaction_update', (data: AdminTransactionUpdate) => {
      this.transactionUpdate$.next(data);
    });

    this.listen('dashboard_stats_updated', (data: AdminRealtimeEvent) => {
      this.dashboardStatsUpdated$.next(data);
    });

    this.listen('wallet_updated', (data: AdminRealtimeEvent) => {
      this.walletUpdated$.next(data);
    });

    this.listen('transactions_updated', (data: AdminRealtimeEvent) => {
      this.transactionsUpdated$.next(data);
    });

    this.listen('deposits_updated', (data: AdminRealtimeEvent) => {
      this.depositsUpdated$.next(data);
    });

    this.listen('withdrawals_updated', (data: AdminRealtimeEvent) => {
      this.withdrawalsUpdated$.next(data);
    });

    this.listen('user_updated', (data: AdminRealtimeEvent) => {
      this.userUpdated$.next(data);
    });

    this.listen('activity_updated', (data: AdminRealtimeEvent) => {
      this.activityUpdated$.next(data);
    });

    this.listen('predator_text_updated', (data: { predator_custom_text?: string }) => {
      if (data && typeof data.predator_custom_text === 'string') {
        this.predatorTextUpdate$.next(data.predator_custom_text);
      }
    });

    this.listen('admin_access_revoked', (data: { userId: number; reason: string }) => {
      this.accessRevoked$.next(data);
      this.socket?.disconnect();
      this.isConnected$.next(false);
      this.error$.next(data.reason || 'Administrator access has changed.');
    });

    this.listen('disconnect', (reason: string) => {
      this.isConnected$.next(false);
      if (reason !== 'io client disconnect') {
        this.error$.next(`Admin socket disconnected (${reason}). Reconnecting…`);
      }
    });
  }

  /** Room defaults to 1 so any existing caller keeps its old behaviour. */
  public overrideCrashPoint(crashPoint: number, room: number = 1): void {
    if (this.socket && this.socket.connected) {
      this.socket.emit('admin_override_crash_point', { crashPoint, room });
    }
  }

  public resetCrashPoint(room: number = 1): void {
    if (this.socket && this.socket.connected) {
      this.socket.emit('admin_reset_crash_point', { room });
    }
  }

  public disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this.isConnected$.next(false);
  }

  private listen<T>(event: string, handler: (payload: T) => void): void {
    this.socket?.on(event, (payload: T) => this.zone.run(() => handler(payload)));
  }

  private clearRealtimeEvents(): void {
    this.transactionUpdate$.next(null);
    this.dashboardStatsUpdated$.next(null);
    this.walletUpdated$.next(null);
    this.transactionsUpdated$.next(null);
    this.depositsUpdated$.next(null);
    this.withdrawalsUpdated$.next(null);
    this.userUpdated$.next(null);
    this.activityUpdated$.next(null);
    this.accessRevoked$.next(null);
  }

  private applySnapshot(snapshot: AdminSnapshot): void {
    this.nextRound$.next(snapshot.nextRound);
    this.previousRound$.next(snapshot.previousRound);
    this.currentRound$.next(snapshot.currentRound);
    this.history$.next(snapshot.history);
  }
}
