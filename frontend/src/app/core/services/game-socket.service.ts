import { Injectable } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import { BehaviorSubject, Observable } from 'rxjs';
import { getBackendOrigin } from '../config/backend-url';

export interface PhaseUpdate {
  phase: 'betting' | 'flying' | 'crashed';
  durationMs?: number;
  roundId?: number;
  multiplier?: number;
  room?: GameRoom;
}

export type GameRoom = 1 | 2 | 3;

export interface RoomState extends PhaseUpdate {
  room: GameRoom;
  history: number[];
  activeBets: Array<{
    slot: 1 | 2;
    amount: number;
    status: 'placed' | 'cashed_out';
    cashoutMultiplier: number | null;
    payoutAmount: number;
  }>;
}

export interface BetConfirmed {
  betId: number;
  amount: number;
  slot?: 1 | 2;
  room?: GameRoom;
}

export interface CashOutSuccess {
  multiplier: number;
  payoutAmount: number;
  slot?: 1 | 2;
  room?: GameRoom;
}

export interface LiveBetBroadcast {
  betId?: number;
  player: string;
  bet: number;
  multiplier: number | null;
  win: number;
  cashedOut: boolean;
  userId?: number;
  slot?: 1 | 2;
  room?: GameRoom;
}

export interface WithdrawalNotificationPayload {
  id: number;
  title: string;
  message: string;
  type: string;
  amount?: number;
  status?: string;
  createdAt: string;
}

export interface GameErrorNotification {
  message: string;
  slot?: 1 | 2;
  room?: GameRoom;
}

export interface ChatRainData {
  id: string;
  title: string;
  amountPerClaim: number;
  currency: string;
  quantityTotal: number;
  quantityClaimed: number;
  totalAmount: number;
  minBalanceRequired: number;
  claimedUserIds?: string[];
  claimedAvatars?: string[];
  extraClaimantsCount?: number;
  isExpired?: boolean;
  isClaimed?: boolean;
}

export interface ChatMessage {
  id: number | string;
  type?: 'text' | 'rain' | 'system';
  userId?: number | null | string;
  username: string;
  displayName: string;
  avatarColor?: string;
  avatarIcon?: string;
  avatarBadge?: string;
  avatarUrl?: string;
  message: string;
  rainData?: ChatRainData;
  likes: number;
  hasLiked?: boolean;
  createdAt: string;
  isSelf?: boolean;
}

export interface PlayerRealtimeEvent {
  action: string;
  userId: number | null;
  occurredAt: string;
  balance?: number;
}

@Injectable({
  providedIn: 'root'
})
export class GameSocketService {
  private socket: Socket | null = null;
  private activeRoom: GameRoom = 1;
  private get serverUrl(): string {
    return getBackendOrigin();
  }


  // RxJS BehaviorSubjects for real-time reactive UI streams
  public phase$ = new BehaviorSubject<'betting' | 'flying' | 'crashed'>('betting');
  public roundState$ = new BehaviorSubject<PhaseUpdate>({ phase: 'betting', multiplier: 1.00 });
  public multiplier$ = new BehaviorSubject<number>(1.00);
  public balance$ = new BehaviorSubject<number | null>(null);
  public roundHistory$ = new BehaviorSubject<number[]>([]);
  public roomState$ = new BehaviorSubject<RoomState | null>(null);
  
  public betConfirmed$ = new BehaviorSubject<BetConfirmed | null>(null);
  public betCancelled$ = new BehaviorSubject<{ betId: number; amount: number; slot?: 1 | 2; room?: GameRoom } | null>(null);
  public cashOutSuccess$ = new BehaviorSubject<CashOutSuccess | null>(null);
  public errorNotification$ = new BehaviorSubject<GameErrorNotification | null>(null);

  /**
   * Emits when the server cuts this account off mid-session.
   *
   * The socket is dropped immediately afterwards, so this is the only warning
   * the player gets. Exposed as a stream rather than handled here because this
   * service deliberately knows nothing about auth or routing.
   */
  public accountSuspended$ = new BehaviorSubject<string | null>(null);
  public withdrawalNotification$ = new BehaviorSubject<WithdrawalNotificationPayload | null>(null);
  public isConnected$ = new BehaviorSubject<boolean>(false);

  public betPlacedBroadcast$ = new BehaviorSubject<LiveBetBroadcast | null>(null);
  public betCashedOutBroadcast$ = new BehaviorSubject<LiveBetBroadcast | null>(null);
  public mpesaSuccess$ = new BehaviorSubject<{ amount: number; receipt: string; balance: number } | null>(null);
  public mpesaFailed$  = new BehaviorSubject<{ reason: string; amount: number } | null>(null);
  public walletUpdated$ = new BehaviorSubject<PlayerRealtimeEvent | null>(null);
  public transactionsUpdated$ = new BehaviorSubject<PlayerRealtimeEvent | null>(null);
  public depositsUpdated$ = new BehaviorSubject<PlayerRealtimeEvent | null>(null);
  public withdrawalsUpdated$ = new BehaviorSubject<PlayerRealtimeEvent | null>(null);
  public userUpdated$ = new BehaviorSubject<PlayerRealtimeEvent | null>(null);
  
  // Real-time chat streams
  public chatMessage$ = new BehaviorSubject<ChatMessage | null>(null);
  public chatLiked$ = new BehaviorSubject<{ id: number | string; likes: number } | null>(null);
  public chatError$ = new BehaviorSubject<{ message: string; requiresDeposit?: boolean } | null>(null);
  public onlineUsersCount$ = new BehaviorSubject<number>(4826);
  public chatRainUpdated$ = new BehaviorSubject<{ rainId: string; quantityClaimed: number; quantityTotal: number } | null>(null);

  constructor() {}

  private isActiveRoom(room?: GameRoom): boolean {
    return room === undefined || room === this.activeRoom;
  }

  /** Expose raw socket for custom event listeners (e.g. mpesa_success) */
  public getSocket(): Socket | null {
    return this.socket;
  }

  /**
   * Initialize Socket.IO connection with JWT token authentication handshake
   */
  public connect(token: string): void {
    if (this.socket && this.socket.connected) {
      this.socket.disconnect();
    }

    this.socket = io(this.serverUrl, {
      auth: {
        token: token
      },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000
    });

    this.socket.on('connect', () => {
      console.log('[SOCKET] Connected to Aviator Game Engine socket:', this.socket?.id);
      this.isConnected$.next(true);
      this.errorNotification$.next(null);
    });

    this.socket.on('connect_error', (err) => {
      console.error('[SOCKET] Socket connection error:', err.message);
      this.isConnected$.next(false);

      // A suspended account is refused at the handshake. Without this it would
      // retry forever behind a generic "failed to connect" banner.
      if (err.message === 'ACCOUNT_SUSPENDED') {
        this.accountSuspended$.next('Your account has been suspended by an administrator.');
        return;
      }

      this.errorNotification$.next({ message: err.message || 'Failed to connect to real-time game server.' });
    });

    this.socket.on('account_suspended', (data: { message?: string }) => {
      this.accountSuspended$.next(data?.message || 'Your account has been suspended by an administrator.');
    });

    this.socket.on('phase_update', (data: PhaseUpdate) => {
      if (!this.isActiveRoom(data.room)) return;
      this.phase$.next(data.phase);
      this.roundState$.next(data);
      if (data.multiplier !== undefined) {
        this.multiplier$.next(data.multiplier);
      }
      if (data.phase === 'betting') {
        this.betConfirmed$.next(null);
        this.cashOutSuccess$.next(null);
      }
    });

    this.socket.on('multiplier_tick', (data: { multiplier: number; roundId: number; room?: GameRoom }) => {
      if (!this.isActiveRoom(data.room)) return;
      this.multiplier$.next(data.multiplier);
    });

    this.socket.on('round_crashed', (data: { crashPoint: number; roundId: number; room?: GameRoom }) => {
      if (!this.isActiveRoom(data.room)) return;
      this.phase$.next('crashed');
      this.roundState$.next({
        phase: 'crashed',
        roundId: data.roundId,
        multiplier: data.crashPoint
      });
      this.multiplier$.next(data.crashPoint);
    });

    this.socket.on('room_state', (data: RoomState) => {
      if (!data || !Array.isArray(data.history)) return;
      this.activeRoom = data.room;
      this.phase$.next(data.phase);
      this.roundState$.next(data);
      this.multiplier$.next(data.multiplier ?? 1.00);
      this.roundHistory$.next(data.history);
      this.roomState$.next(data);
    });

    const handleBalanceEvent = (data: any) => {
      const bal = data?.balance !== undefined ? data.balance : (typeof data === 'number' ? data : null);
      if (bal !== null && !isNaN(bal)) {
        console.log(`[${new Date().toISOString()}] [PAYMENT_LOG] Live balance update received:`, bal);
        this.balance$.next(Number(bal));
      }
    };

    this.socket.on('balance_update', handleBalanceEvent);
    this.socket.on('balance_updated', handleBalanceEvent);
    this.socket.on('balance', handleBalanceEvent);
    this.socket.on('mpesa_deposit_completed', handleBalanceEvent);

    this.socket.on('mpesa_success', (data: { amount: number; receipt: string; balance: number }) => {
      console.log(`[${new Date().toISOString()}] [PAYMENT_LOG] Socket received: mpesa_success`, data);
      this.mpesaSuccess$.next(data);
      handleBalanceEvent(data);
    });

    this.socket.on('mpesa_failed', (data: { reason: string; amount: number }) => {
      console.log(`[${new Date().toISOString()}] [PAYMENT_LOG] Socket received: mpesa_failed`, data);
      this.mpesaFailed$.next(data);
    });

    this.socket.on('wallet_updated', (data: PlayerRealtimeEvent) => {
      console.log(`[${new Date().toISOString()}] [PAYMENT_LOG] Socket received: wallet_updated`, data);
      this.walletUpdated$.next(data);
      handleBalanceEvent(data);
    });

    this.socket.on('transactions_updated', (data: PlayerRealtimeEvent) => {
      console.log(`[${new Date().toISOString()}] [PAYMENT_LOG] Socket received: transactions_updated`, data);
      this.transactionsUpdated$.next(data);
    });

    this.socket.on('deposits_updated', (data: PlayerRealtimeEvent) => {
      console.log(`[${new Date().toISOString()}] [PAYMENT_LOG] Socket received: deposits_updated`, data);
      this.depositsUpdated$.next(data);
    });

    this.socket.on('withdrawals_updated', (data: PlayerRealtimeEvent) => {
      console.log(`[${new Date().toISOString()}] [PAYMENT_LOG] Socket received: withdrawals_updated`, data);
      this.withdrawalsUpdated$.next(data);
    });

    this.socket.on('user_updated', (data: PlayerRealtimeEvent) => {
      this.userUpdated$.next(data);
    });

    this.socket.on('history_update', (data: { history: number[]; room?: GameRoom }) => {
      if (this.isActiveRoom(data?.room) && data && Array.isArray(data.history)) {
        this.roundHistory$.next(data.history);
      }
    });

    this.socket.on('bet_confirmed', (data: BetConfirmed) => {
      if (this.isActiveRoom(data.room)) this.betConfirmed$.next(data);
    });

    this.socket.on('bet_cancelled', (data: { betId: number; amount: number; slot?: 1 | 2; room?: GameRoom }) => {
      if (this.isActiveRoom(data.room)) this.betCancelled$.next(data);
    });

    this.socket.on('cash_out_success', (data: CashOutSuccess) => {
      if (this.isActiveRoom(data.room)) this.cashOutSuccess$.next(data);
    });

    this.socket.on('bet_placed_broadcast', (data: LiveBetBroadcast) => {
      if (this.isActiveRoom(data.room)) this.betPlacedBroadcast$.next(data);
    });

    this.socket.on('bet_cashed_out_broadcast', (data: LiveBetBroadcast) => {
      if (this.isActiveRoom(data.room)) this.betCashedOutBroadcast$.next(data);
    });

    this.socket.on('bet_error', (data: GameErrorNotification) => {
      if (this.isActiveRoom(data.room)) this.errorNotification$.next(data);
    });

    this.socket.on('withdrawal_notification', (data: WithdrawalNotificationPayload) => {
      this.withdrawalNotification$.next(data);
    });

    this.socket.on('cashout_error', (data: GameErrorNotification) => {
      if (this.isActiveRoom(data.room)) this.errorNotification$.next(data);
    });

    // Chat events
    this.socket.on('chat_message', (data: ChatMessage) => {
      this.chatMessage$.next(data);
    });
    this.socket.on('chatMessage', (data: ChatMessage) => {
      this.chatMessage$.next(data);
    });

    this.socket.on('chat_liked', (data: { id: number; likes: number }) => {
      this.chatLiked$.next(data);
    });

    this.socket.on('chat_error', (data: { message: string; requiresDeposit?: boolean }) => {
      this.chatError$.next(data);
    });

    this.socket.on('online_users_count', (data: { count: number }) => {
      if (data && typeof data.count === 'number') {
        this.onlineUsersCount$.next(data.count);
      }
    });

    this.socket.on('chat_rain_updated', (data: { rainId: string; quantityClaimed: number; quantityTotal: number }) => {
      if (data) {
        this.chatRainUpdated$.next(data);
      }
    });

    this.socket.on('disconnect', () => {
      console.warn('[SOCKET] Disconnected from Game Engine socket');
      this.isConnected$.next(false);
    });
  }

  /**
   * Send live chat message to server
   */
  public sendChatMessage(message: string): void {
    if (!this.socket || !this.socket.connected) {
      return;
    }
    this.socket.emit('send_chat', { message });
  }

  /**
   * Like a chat message
   */
  public likeChatMessage(id: number | string): void {
    if (!this.socket || !this.socket.connected) {
      return;
    }
    this.socket.emit('like_chat', { id });
  }

  /**
   * Emit place bet event to server
   */
  public changeRoom(room: GameRoom): boolean {
    if (!this.socket || !this.socket.connected) return false;
    this.activeRoom = room;
    this.socket.emit('change_room', { room });
    return true;
  }

  public placeBet(amount: number, slot: 1 | 2): void {
    if (!this.socket || !this.socket.connected) {
      this.errorNotification$.next({ message: 'Socket connection offline. Please reconnect.', slot });
      return;
    }
    this.socket.emit('place_bet', { amount, slot });
  }

  public cancelBet(slot: 1 | 2): void {
    if (!this.socket || !this.socket.connected) {
      return;
    }
    this.socket.emit('cancel_bet', { slot });
  }

  /**
   * Emit cash out event to server
   */
  public cashOut(slot: 1 | 2): void {
    if (!this.socket || !this.socket.connected) {
      this.errorNotification$.next({ message: 'Socket connection offline. Please reconnect.', slot });
      return;
    }
    this.socket.emit('cash_out', { slot });
  }

  /**
   * Clear active notifications
   */
  public clearNotification(): void {
    this.errorNotification$.next(null);
  }

  /**
   * Disconnect socket cleanly
   */
  public disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
      this.isConnected$.next(false);
    }
  }
}
