import {
  Component,
  OnInit,
  AfterViewInit,
  OnDestroy,
  ViewChild,
  ElementRef,
  HostListener,
  Input,
  signal,
  computed,
  effect,
  inject
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { ChatMessage, GameRoom, GameSocketService, LiveBetBroadcast, RoomState } from '../../../core/services/game-socket.service';
import { AuthService, User, TransactionRecord } from '../../../core/services/auth.service';
import { SanitizedModeService } from '../../../core/services/sanitized-mode.service';
import { getBackendOrigin } from '../../../core/config/backend-url';

export type GameState = 'WAITING' | 'RUNNING' | 'CRASHED';

export interface LiveBet {
  id: string;
  player: string;
  avatarIcon: string;
  bet: number;
  multiplier: number | null;
  win: number;
  cashedOut: boolean;
  isCurrentUser?: boolean;
}

export interface PanelBetState {
  amount: number;
  selectedPreset: number | null;
  presetTapCount: number;
  placedAmount: number;
  queuedAmount: number;
  mode: 'bet' | 'auto';
  autoTarget: number;
  autoBetEnabled: boolean;
  autoCashOutEnabled: boolean;
  isPending: boolean;
  hasActiveBet: boolean;
  hasCashedOut: boolean;
  cashedOutPayout: number;
  cashedOutMultiplier: number;
}

@Component({
  selector: 'app-aviator-game',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './aviator-game.component.html',
  styleUrl: './aviator-game.component.scss'
})
export class AviatorGameComponent implements OnInit, AfterViewInit, OnDestroy {
  @Input() isMiniView: boolean = false;
  @Input() muteAudio: boolean = false;
  @Input() set activeRoom(r: number | GameRoom | undefined) {
    if (r && (r === 1 || r === 2 || r === 3) && r !== this.selectedRoom()) {
      this.switchRoomDirectly(r as GameRoom);
    }
  }

  public switchRoomDirectly(room: GameRoom) {
    if (room === this.selectedRoom()) return;
    this.pendingRoom.set(room);
    this.confirmRoomChange();
  }

  @ViewChild('flightCanvas') canvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('canvasContainer') canvasContainerRef!: ElementRef<HTMLDivElement>;
  @ViewChild('chatScrollContainer') chatScrollContainer?: ElementRef<HTMLDivElement>;

  private gameSocket = inject(GameSocketService);
  private authService = inject(AuthService);
  public sanitizedModeService = inject(SanitizedModeService);
  private http = inject(HttpClient);
  private router = inject(Router);

  /** True when current user is Admin/Superadmin AND Sanitized Mode is switched ON */
  public isSanitized = computed(() => this.authService.isAdmin() && this.sanitizedModeService.isSanitizedMode());

  private subs: Subscription[] = [];
  private animationFrameId: number | null = null;
  private bettingIntervalId: any = null;
  private mockLoopIntervalId: any = null;
  private resizeObserver: ResizeObserver | null = null;
  private fakeJoinIntervalId: any = null;

  // --------------------------------------------------------------------------
  // ANGULAR SIGNALS STATE MACHINE
  // --------------------------------------------------------------------------
  public gameState = signal<GameState>('WAITING');
  public currentMultiplier = signal<number>(1.00);
  public finalCrashMultiplier = signal<number>(1.00);
  public countdownSeconds = signal<number>(5);
  public countdownProgress = signal<number>(100);

  public userBalance = signal<number>(0.00);
  public isConnected = signal<boolean>(false);
  public activeTab = signal<'all' | 'my' | 'top'>('all');
  public selectedRoom = signal<GameRoom>(1);
  public pendingRoom = signal<GameRoom>(1);
  public showRoomModal = signal<boolean>(false);
  public showPanel2 = signal<boolean>(true);

  public history = signal<number[]>([
    1.17, 2.98, 1.28, 3.03, 1.57, 1.46, 2.13, 1.72, 2.93, 1.00,
    19.26, 1.28, 6.17, 1.86, 2.27, 1.04, 2.43, 1.15, 2.29, 5.66
  ]);

  private readonly demoRoomHistories: Record<GameRoom, number[]> = {
    1: [1.17, 2.98, 1.28, 3.03, 1.57, 1.46, 2.13, 1.72, 2.93, 1.00, 19.26, 1.28, 6.17, 1.86, 2.27, 1.04, 2.43, 1.15, 2.29, 5.66],
    2: [1.05, 1.44, 2.36, 1.73, 1.21, 3.12, 1.08, 2.03, 1.54, 4.28, 1.11, 2.64, 1.38, 1.92, 3.77, 1.26, 2.15, 1.61, 5.09, 1.18],
    3: [1.00, 8.47, 1.32, 1.08, 14.66, 2.05, 1.00, 3.91, 1.27, 22.14, 1.49, 1.12, 6.75, 1.00, 2.74, 10.31, 1.18, 4.46, 1.03, 18.29]
  };

  public panel1 = signal<PanelBetState>({
    amount: 10,
    selectedPreset: null,
    presetTapCount: 0,
    placedAmount: 0,
    queuedAmount: 0,
    mode: 'bet',
    autoTarget: 1.10,
    autoBetEnabled: false,
    autoCashOutEnabled: false,
    isPending: false,
    hasActiveBet: false,
    hasCashedOut: false,
    cashedOutPayout: 0,
    cashedOutMultiplier: 0
  });

  public panel2 = signal<PanelBetState>({
    amount: 10,
    selectedPreset: null,
    presetTapCount: 0,
    placedAmount: 0,
    queuedAmount: 0,
    mode: 'bet',
    autoTarget: 1.10,
    autoBetEnabled: false,
    autoCashOutEnabled: false,
    isPending: false,
    hasActiveBet: false,
    hasCashedOut: false,
    cashedOutPayout: 0,
    cashedOutMultiplier: 0
  });

  public liveBets = signal<LiveBet[]>([]);
  private readonly maxBetFeedSize = 3000;
  private readonly visibleBetRows = 100;

  // Modals & UI overlays
  public showWalletModal = signal<boolean>(false);
  public showHistoryModal = signal<boolean>(false);
  public showProfileModal = signal<boolean>(false);
  public showProfileDropdown = signal<boolean>(false);
  public showGameMenu = signal<boolean>(false);
  public soundEnabled = signal<boolean>(true);
  public musicEnabled = signal<boolean>(true);
  public animationEnabled = signal<boolean>(true);
  public showLimitsModal = signal<boolean>(false);
  public showHowToPlayModal = signal<boolean>(false);
  public showRulesModal = signal<boolean>(false);
  public showFreeBetsModal = signal<boolean>(false);
  public showAvatarModal = signal<boolean>(false);
  public selectedAvatarIcon = signal<string>('😎');
  public avatarOptions = ['😎', '🚀', '🔥', '⚡', '👑', '🏆', '💎', '🎯', '🦁', '🌟', '🦊', '🐯', '🐼', '🐺', '🎲'];
  public walletTab = signal<'deposit' | 'withdraw' | 'transactions'>('deposit');
  public depositVal = signal<number>(999);
  public minimumDeposit = signal<number>(999);
  // The first pill is always the configured minimum; the rest are the standard
  // top-ups that still clear it, so no pill can offer an amount the server rejects.
  public depositPresets = computed<number[]>(() => {
    const minimum = this.minimumDeposit();
    const presets = [minimum, ...[1000, 2000, 3000, 5000, 10000].filter(value => value > minimum)];
    while (presets.length < 6) presets.push(presets[presets.length - 1] * 2);
    return presets.slice(0, 6);
  });
  public depositSelectedPreset = signal<number | null>(null);
  public depositPresetTapCount = signal<number>(0);
  public withdrawVal = signal<number>(500);
  public withdrawSelectedPreset = signal<number | null>(null);
  public withdrawPresetTapCount = signal<number>(0);
  public isSubmittingWithdrawal = signal<boolean>(false);
  public toastMessage = signal<string | null>(null);
  public isToastError = signal<boolean>(false);
  public cashoutNotification = signal<{ multiplier: number; payout: number; slot: 1 | 2 } | null>(null);
  private cashoutNotificationTimeout: any = null;

  // Withdrawal / Admin notification pop-up
  public withdrawalNotif = signal<{ id?: number; title: string; message: string; type: string; timestamp: string } | null>(null);
  private withdrawalNotifTimeout: any = null;
  private lastWithdrawalNotificationId: number | null = null;
  public bonusNotif = signal<{ title: string; message: string; type: 'success' | 'info' } | null>(null);
  public isClaimingBonus = signal<boolean>(false);
  private bonusNotifTimeout: any = null;

  // Game loading splash screen (shown for 3s after login)
  public gameLoading = signal<boolean>(true);

  // Transaction History State
  public transactionHistory: TransactionRecord[] = [];
  public isLoadingTransactions = false;
  public transactionHistoryTab = signal<'deposit' | 'withdrawal'>('deposit');

  // M-Pesa STK Push state
  public mpesaPhone = signal<string>('');
  public mpesaStatus = signal<'idle' | 'sending' | 'waiting' | 'success'>('idle');
  public mpesaStatusMsg = signal<string>('');
  public mpesaReceipt = signal<string>('');
  private mpesaCheckoutRequestId: string = '';

  // Deposit lockout after consecutive uncompleted prompts.
  //
  // Held as an absolute deadline plus a separate clock signal, so the countdown
  // re-renders each second without the deadline being rewritten. The clock only
  // ticks while a lockout is actually running — this component drives the game
  // canvas, and a signal changing every second for no reason is a re-render
  // every second for no reason.
  public depositCooldownUntil = signal<number>(0);
  private cooldownNow = signal<number>(Date.now());
  private cooldownTickerId: any = null;
  private cooldownPollId: any = null;

  public depositCooldownSeconds = computed(() => {
    const until = this.depositCooldownUntil();
    if (!until) return 0;
    return Math.max(0, Math.ceil((until - this.cooldownNow()) / 1000));
  });

  public depositLocked = computed(() => this.depositCooldownSeconds() > 0);

  public depositCooldownLabel = computed(() => {
    const total = this.depositCooldownSeconds();
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  });

  public currentUser = signal<User | null>(null);

  // ─── REAL-TIME CHAT SERVICE STATE ──────────────────────────────────────────
  public showChatModal = signal<boolean>(false);
  public showChatInfoModal = signal<boolean>(false);
  public chatMessages = signal<ChatMessage[]>([]);
  public chatInputText: string = '';
  public onlineChatUsers = signal<number>(4826);
  public hasNewMessagesBelow = signal<boolean>(false);
  public isChatEligible = signal<boolean>(false);
  public isSendingChat = signal<boolean>(false);
  public isClaimingRain = signal<boolean>(false);
  public userLikedMessageIds = new Set<string | number>();
  public claimedRainIds = new Set<string>();

  public hasChatBalance = computed(() => {
    return (Number(this.userBalance()) || 0) >= 1000;
  });

  // --------------------------------------------------------------------------
  // COMPUTED PROPERTIES
  // --------------------------------------------------------------------------
  public potentialPayout1 = computed(() => {
    const p1 = this.panel1();
    if (!p1.hasActiveBet || p1.hasCashedOut) return 0;
    return parseFloat((p1.placedAmount * this.currentMultiplier()).toFixed(2));
  });

  public potentialPayout2 = computed(() => {
    const p2 = this.panel2();
    if (!p2.hasActiveBet || p2.hasCashedOut) return 0;
    return parseFloat((p2.placedAmount * this.currentMultiplier()).toFixed(2));
  });

  public displayBetsList = computed(() => {
    const tab = this.activeTab();
    const list = this.liveBets();
    const username = this.currentUser()?.username || 'Player';
    const highestStakes = [...list].sort((a, b) => b.bet - a.bet);

    if (tab === 'my') {
      return list
        .filter(b => b.player === username || b.isCurrentUser)
        .slice(0, this.visibleBetRows);
    }
    if (tab === 'top') {
      return highestStakes.slice(0, this.visibleBetRows);
    }
    return highestStakes.slice(0, this.visibleBetRows);
  });

  public betsCount = computed(() => {
    const tab = this.activeTab();
    const list = this.liveBets();
    const username = this.currentUser()?.username || 'Player';

    if (tab === 'my') {
      return list.filter(b => b.player === username || b.isCurrentUser).length;
    }

    return Math.min(list.length, this.maxBetFeedSize);
  });

  public settledBetsCount = computed(() =>
    this.liveBets().filter(bet => bet.cashedOut).length
  );

  public totalWinAmount = computed(() =>
    this.liveBets().reduce((total, bet) => total + (bet.cashedOut ? bet.win : 0), 0)
  );

  public settledBetsPercent = computed(() => {
    const total = this.betsCount();
    return total ? (this.settledBetsCount() / total) * 100 : 0;
  });

  public get filteredTransactionHistory(): TransactionRecord[] {
    const type = this.transactionHistoryTab();
    return this.transactionHistory.filter(transaction => transaction.type === type);
  }

  public get depositTransactions(): TransactionRecord[] {
    return this.transactionHistory.filter(transaction => transaction.type === 'deposit');
  }

  public get withdrawalTransactions(): TransactionRecord[] {
    return this.transactionHistory.filter(transaction => transaction.type === 'withdrawal');
  }

  // --------------------------------------------------------------------------
  // CANVAS ENGINE INTERNALS
  // --------------------------------------------------------------------------
  private ctx: CanvasRenderingContext2D | null = null;
  private flightProgress = 0; // 0.0 to 1.0
  private purpleGlowPhase = 0; // 0.0 (blue) to 1.0 (purple)
  private lastCanvasFrameTime = 0;
  private sunburstAngle = 0;
  private crashFlightProgress = 0;
  private crashStartedAt: number | null = null;
  private readonly crashExitDurationMs = 360;
  private readonly crashResultDurationMs = 400;
  private planeImage: HTMLImageElement | null = null;
  private flightSound: HTMLAudioElement | null = null;
  private flyAwaySound: HTMLAudioElement | null = null;
  private audioCtx: AudioContext | null = null;
  private flightAudioBuffer: AudioBuffer | null = null;
  private flyAwayAudioBuffer: AudioBuffer | null = null;
  private activeFlightSource: AudioBufferSourceNode | null = null;
  private activeFlightGain: GainNode | null = null;
  private activeFlyAwaySource: AudioBufferSourceNode | null = null;
  private audioWasArmed = false;
  private readonly soundPreferenceKey = 'ligibet_aviator_sound_enabled';

  constructor() {
    // The minimum deposit is admin-configurable and can change while this page
    // is open, so re-read it every time the wallet opens rather than trusting
    // the value fetched at page load.
    effect(() => {
      if (this.showWalletModal()) this.authService.loadMinimumDeposit(true);
    });

    // Effect to reflect balance changes or auto-cashout evaluations
    effect(() => {
      const state = this.gameState();
      const mult = this.currentMultiplier();

      if (state === 'RUNNING') {
        this.evaluateAutoCashouts(mult);
      }
    });
  }

  ngOnInit() {
    this.startDepositCooldownWatch();
    this.initPlaneImage();
    this.initGameAudio();
    this.initAuthAndSockets();
    this.authService.loadCurrentUser().subscribe();
    this.authService.loadMinimumDeposit();
    this.subs.push(
      this.authService.minimumDeposit$.subscribe(minimum => {
        this.minimumDeposit.set(minimum);
        if (this.depositVal() < minimum) this.depositVal.set(minimum);
      })
    );
    this.seedMockBets();
    // Signed-in players must follow the server's authoritative room stream.
    // Local simulation remains available only before authentication.
    if (!this.authService.getToken()) {
      this.startStandaloneGameLoop();
    }
    // Show loading splash for 3 seconds after login
    setTimeout(() => this.gameLoading.set(false), 3000);
  }

  private initPlaneImage() {
    if (typeof window !== 'undefined') {
      const img = new Image();
      img.src = '/assets/images/plane.png';
      img.onload = () => {
        this.planeImage = img;
      };
    }
  }

  private initGameAudio(): void {
    if (typeof window === 'undefined') return;

    if (this.muteAudio || this.isMiniView) {
      this.soundEnabled.set(false);
      this.musicEnabled.set(false);
      return;
    }

    try {
      this.soundEnabled.set(localStorage.getItem(this.soundPreferenceKey) !== 'false');
    } catch {
      this.soundEnabled.set(true);
    }

    this.flightSound = new Audio('/assets/audio/aviator%20sound.mpeg');
    this.flightSound.loop = true;
    this.flightSound.preload = 'auto';
    this.flightSound.volume = 0.5;

    this.flyAwaySound = new Audio('/assets/audio/flew%20away%20sound.mpeg');
    this.flyAwaySound.preload = 'auto';
    this.flyAwaySound.volume = 0.65;

    // Web Audio API decodes audio for zero-gap seamless looping
    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioContextClass) {
        this.audioCtx = new AudioContextClass();
        this.loadAudioBuffer('/assets/audio/aviator%20sound.mpeg').then(buf => {
          this.flightAudioBuffer = buf;
        }).catch(() => undefined);
        this.loadAudioBuffer('/assets/audio/flew%20away%20sound.mpeg').then(buf => {
          this.flyAwayAudioBuffer = buf;
        }).catch(() => undefined);
      }
    } catch {
      // AudioContext fallback to standard HTML5 Audio
    }
  }

  private async loadAudioBuffer(url: string): Promise<AudioBuffer | null> {
    if (!this.audioCtx) return null;
    try {
      const response = await fetch(url);
      const arrayBuffer = await response.arrayBuffer();
      return await this.audioCtx.decodeAudioData(arrayBuffer);
    } catch {
      return null;
    }
  }

  private canPlayGameAudio(): boolean {
    if (this.muteAudio || this.isMiniView) return false;
    return typeof document === 'undefined' || !document.hidden;
  }

  private armAudioAfterInteraction(): void {
    if (this.muteAudio || this.isMiniView || this.audioWasArmed || !this.soundEnabled()) return;

    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      void this.audioCtx.resume();
    }

    if (this.flightSound) {
      const audio = this.flightSound;
      audio.muted = true;
      void audio.play().then(() => {
        audio.pause();
        audio.currentTime = 0;
        audio.muted = false;
        this.audioWasArmed = true;
      }).catch(() => {
        audio.muted = false;
      });
    }
  }

  private startFlightAudio(): void {
    if (!this.soundEnabled() || !this.canPlayGameAudio()) return;

    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      void this.audioCtx.resume();
    }

    if (this.flyAwaySound) {
      this.flyAwaySound.pause();
      this.flyAwaySound.currentTime = 0;
    }
    if (this.activeFlyAwaySource) {
      try {
        this.activeFlyAwaySource.stop();
        this.activeFlyAwaySource.disconnect();
      } catch {}
      this.activeFlyAwaySource = null;
    }

    // Web Audio API seamless looping (0ms boundary gap)
    if (this.audioCtx && this.flightAudioBuffer) {
      this.stopFlightAudio();
      try {
        const source = this.audioCtx.createBufferSource();
        source.buffer = this.flightAudioBuffer;
        source.loop = true;
        const gainNode = this.audioCtx.createGain();
        gainNode.gain.value = 0.5;
        source.connect(gainNode);
        gainNode.connect(this.audioCtx.destination);
        source.start(0);
        this.activeFlightSource = source;
        this.activeFlightGain = gainNode;
        return;
      } catch {
        // Fallback to HTML5 audio below if Web Audio fails
      }
    }

    if (this.flightSound) {
      this.flightSound.pause();
      this.flightSound.currentTime = 0;
      void this.flightSound.play().catch(() => undefined);
    }
  }

  private stopFlightAudio(): void {
    if (this.activeFlightSource) {
      try {
        this.activeFlightSource.stop();
        this.activeFlightSource.disconnect();
      } catch {}
      this.activeFlightSource = null;
    }
    if (this.activeFlightGain) {
      try {
        this.activeFlightGain.disconnect();
      } catch {}
      this.activeFlightGain = null;
    }
    if (this.flightSound) {
      this.flightSound.pause();
      this.flightSound.currentTime = 0;
    }
  }

  private playFlyAwayAudio(fadeInSeconds = 0): void {
    if (!this.soundEnabled() || !this.canPlayGameAudio()) return;

    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      void this.audioCtx.resume();
    }

    if (this.audioCtx && this.flyAwayAudioBuffer) {
      try {
        if (this.activeFlyAwaySource) {
          this.activeFlyAwaySource.stop();
          this.activeFlyAwaySource.disconnect();
        }
        const source = this.audioCtx.createBufferSource();
        source.buffer = this.flyAwayAudioBuffer;
        source.loop = false;
        const gainNode = this.audioCtx.createGain();
        const now = this.audioCtx.currentTime;
        gainNode.gain.setValueAtTime(fadeInSeconds ? 0 : 0.65, now);
        if (fadeInSeconds) gainNode.gain.linearRampToValueAtTime(0.65, now + fadeInSeconds);
        source.connect(gainNode);
        gainNode.connect(this.audioCtx.destination);
        source.start(0);
        source.onended = () => {
          try { gainNode.disconnect(); } catch {}
          if (this.activeFlyAwaySource === source) this.activeFlyAwaySource = null;
        };
        this.activeFlyAwaySource = source;
        return;
      } catch {}
    }

    if (this.flyAwaySound) {
      this.flyAwaySound.pause();
      this.flyAwaySound.currentTime = 0;
      void this.flyAwaySound.play().catch(() => undefined);
    }
  }

  private transitionToFlyAwayAudio(): void {
    if (!this.soundEnabled() || !this.canPlayGameAudio()) {
      this.stopAllGameAudio();
      return;
    }

    if (this.audioCtx && this.activeFlightGain && this.activeFlightSource) {
      const now = this.audioCtx.currentTime;
      const fadeOutSeconds = 0.12;
      try {
        this.activeFlightGain.gain.cancelScheduledValues(now);
        this.activeFlightGain.gain.setValueAtTime(this.activeFlightGain.gain.value, now);
        this.activeFlightGain.gain.linearRampToValueAtTime(0, now + fadeOutSeconds);
        this.activeFlightSource.stop(now + fadeOutSeconds + 0.02);
      } catch {}
      this.activeFlightSource = null;
      this.activeFlightGain = null;
      this.playFlyAwayAudio(0.025);
      return;
    }

    // HTMLAudio fallback: start the fly-away sound immediately and lower the
    // looping track on the next paint, avoiding an audible empty gap.
    const flight = this.flightSound;
    if (flight) {
      const originalVolume = flight.volume;
      const startedAt = performance.now();
      const fade = () => {
        const progress = Math.min(1, (performance.now() - startedAt) / 120);
        flight.volume = originalVolume * (1 - progress);
        if (progress < 1) requestAnimationFrame(fade);
        else {
          flight.pause();
          flight.currentTime = 0;
          flight.volume = originalVolume;
        }
      };
      requestAnimationFrame(fade);
    }
    this.playFlyAwayAudio();
  }

  private stopAllGameAudio(): void {
    this.stopFlightAudio();
    if (this.activeFlyAwaySource) {
      try {
        this.activeFlyAwaySource.stop();
        this.activeFlyAwaySource.disconnect();
      } catch {}
      this.activeFlyAwaySource = null;
    }
    if (this.flyAwaySound) {
      this.flyAwaySound.pause();
      this.flyAwaySound.currentTime = 0;
    }
  }

  ngAfterViewInit() {
    this.initCanvas();
    this.startCanvasRenderLoop();
  }

  ngOnDestroy() {
    this.subs.forEach(s => s.unsubscribe());
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
    }
    if (this.bettingIntervalId) clearInterval(this.bettingIntervalId);
    if (this.mockLoopIntervalId) clearInterval(this.mockLoopIntervalId);
    if (this.fakeJoinIntervalId) clearInterval(this.fakeJoinIntervalId);
    if (this.cooldownTickerId) clearInterval(this.cooldownTickerId);
    if (this.cooldownPollId) clearInterval(this.cooldownPollId);
    if (this.resizeObserver) this.resizeObserver.disconnect();
    this.stopAllGameAudio();
    this.gameSocket.disconnect();
  }

  @HostListener('window:resize')
  onResize() {
    this.resizeCanvas();
  }

  @HostListener('document:visibilitychange')
  onVisibilityChange(): void {
    if (document.hidden) this.stopAllGameAudio();
  }

  @HostListener('window:pagehide')
  @HostListener('window:beforeunload')
  onPageExit(): void {
    this.stopAllGameAudio();
  }

  @HostListener('window:keydown.space', ['$event'])
  handleSpaceKey(event: Event) {
    const activeEl = document.activeElement;
    if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) {
      return;
    }
    event.preventDefault();
    this.triggerDualPanelAction();
  }

  @HostListener('document:click', ['$event'])
  @HostListener('document:touchstart', ['$event'])
  onDocumentClick(event: Event) {
    const target = event.target as Node;
    if (!target) return;

    const profileWrap = document.getElementById('profileDropdownWrap');
    const settingsWrap = document.getElementById('settingsDropdownWrap');

    const clickedInsideTrigger =
      (profileWrap && profileWrap.contains(target)) ||
      (settingsWrap && settingsWrap.contains(target));

    if (!clickedInsideTrigger) {
      this.showProfileDropdown.set(false);
      this.showGameMenu.set(false);
    }
  }

  @HostListener('document:pointerdown')
  onPlayerInteraction(): void {
    this.armAudioAfterInteraction();
  }

  // --------------------------------------------------------------------------
  // WEBSOCKET & BACKEND COMMUNICATION
  // --------------------------------------------------------------------------
  private initAuthAndSockets() {
    this.subs.push(
      this.authService.currentUser$.subscribe(u => {
        this.currentUser.set(u);
        if (u) this.userBalance.set(u.balance);
      }),
      this.authService.userBalance$.subscribe(b => {
        this.userBalance.set(b);
      }),
      this.gameSocket.isConnected$.subscribe(connected => {
        this.isConnected.set(connected);
        if (connected) {
          this.authService.loadCurrentUser().subscribe();
        }
      }),
      this.gameSocket.roundState$.subscribe(roundState => {
        if (this.isConnected()) {
          this.onSocketPhaseChange(roundState);
        }
      }),
      this.gameSocket.multiplier$.subscribe(mult => {
        if (this.isConnected() && this.gameState() === 'RUNNING') {
          this.onMultiplierUpdate(mult);
        }
      }),
      this.gameSocket.balance$.subscribe(balance => {
        if (balance !== undefined && balance !== null && !isNaN(balance)) {
          this.userBalance.set(balance);
          this.authService.updateBalance(balance);
        }
      }),
      this.gameSocket.roundHistory$.subscribe(h => {
        if (h && h.length > 0) this.history.set(h);
      }),
      this.gameSocket.roomState$.subscribe(roomState => {
        if (roomState) this.restoreRoomBets(roomState);
      }),
      this.gameSocket.betConfirmed$.subscribe(b => {
        if (b && (b.room === undefined || b.room === this.selectedRoom())) {
          const panel = this.resolveResponsePanel(b.slot);
          if (panel) this.confirmBet(panel, b.amount);
        }
      }),
      this.gameSocket.betCancelled$.subscribe(b => {
        if (b && (b.room === undefined || b.room === this.selectedRoom())) {
          const panel = this.resolveResponsePanel(b.slot) || b.slot || 1;
          if (panel === 1) {
            this.panel1.update(p => ({ ...p, hasActiveBet: false, placedAmount: 0, isPending: false }));
          } else {
            this.panel2.update(p => ({ ...p, hasActiveBet: false, placedAmount: 0, isPending: false }));
          }
          this.showToast('Bet cancelled');
        }
      }),
      this.gameSocket.cashOutSuccess$.subscribe(c => {
        if (c && (c.room === undefined || c.room === this.selectedRoom())) {
          const panel = this.resolveResponsePanel(c.slot);
          if (panel) this.confirmCashout(panel, c.multiplier, c.payoutAmount);
          this.triggerCashoutNotification(c.multiplier, c.payoutAmount, c.slot || 1);
        }
      }),
      this.gameSocket.betPlacedBroadcast$.subscribe(b => {
        if (b) this.addLiveBetBroadcast(b);
      }),
      this.gameSocket.betCashedOutBroadcast$.subscribe(c => {
        if (c) this.updateLiveBetBroadcast(c);
      }),
      this.gameSocket.errorNotification$.subscribe(err => {
        if (err && (err.room === undefined || err.room === this.selectedRoom())) {
          if (err.slot) {
            this.setPanelPending(err.slot, false);
          } else {
            this.clearPendingPanels();
          }
          this.showToast(err.message, true);
        }
      }),
      this.gameSocket.withdrawalNotification$.subscribe(payload => {
        if (payload) {
          this.showWithdrawalNotification(payload);
        }
      }),
      this.gameSocket.transactionsUpdated$.subscribe(event => {
        if (event) {
          this.loadTransactionsHistory();
          if (event.action === 'mpesa_deposit_completed' && this.mpesaStatus() === 'waiting') {
            this.mpesaStatus.set('success');
            this.showToast('M-Pesa deposit confirmed!');
            setTimeout(() => this.showWalletModal.set(false), 2500);
          }
          if (event.action === 'mpesa_deposit_failed' && (this.mpesaStatus() === 'waiting' || this.mpesaStatus() === 'sending')) {
            this.resetMpesaState();
          }
        }
      }),
      this.gameSocket.depositsUpdated$.subscribe(event => {
        if (event) {
          this.loadTransactionsHistory();
          if (event.action === 'mpesa_deposit_completed' && this.mpesaStatus() === 'waiting') {
            this.mpesaStatus.set('success');
            this.showToast('M-Pesa deposit confirmed!');
            setTimeout(() => this.showWalletModal.set(false), 2500);
          }
          if (event.action === 'mpesa_deposit_failed' && (this.mpesaStatus() === 'waiting' || this.mpesaStatus() === 'sending')) {
            this.resetMpesaState();
          }
        }
      }),
      this.gameSocket.withdrawalsUpdated$.subscribe(event => {
        if (event) this.loadTransactionsHistory();
      }),
      this.gameSocket.userUpdated$.subscribe(event => {
        if (event) this.authService.loadCurrentUser().subscribe();
      }),
      this.gameSocket.walletUpdated$.subscribe(event => {
        if (event && (event as any).balance !== undefined) {
          const bal = parseFloat((event as any).balance) || 0;
          this.userBalance.set(bal);
          this.authService.updateBalance(bal);
        }
      }),
      this.gameSocket.chatMessage$.subscribe(msg => {
        if (msg) {
          this.addIncomingChatMessage(msg);
        }
      }),
      this.gameSocket.chatLiked$.subscribe(likeData => {
        if (likeData) {
          this.chatMessages.update(msgs =>
            msgs.map(m => m.id === likeData.id ? { ...m, likes: likeData.likes } : m)
          );
        }
      }),
      this.gameSocket.onlineUsersCount$.subscribe(count => {
        if (count) {
          this.onlineChatUsers.set(count);
        }
      }),
      this.gameSocket.chatRainUpdated$.subscribe(rainUpdate => {
        if (rainUpdate) {
          this.chatMessages.update(msgs =>
            msgs.map(m => {
              if (m.id === rainUpdate.rainId || m.rainData?.id === rainUpdate.rainId) {
                return {
                  ...m,
                  rainData: {
                    ...m.rainData!,
                    quantityClaimed: rainUpdate.quantityClaimed,
                    quantityTotal: rainUpdate.quantityTotal
                  }
                };
              }
              return m;
            })
          );
        }
      }),
      this.gameSocket.chatError$.subscribe(err => {
        if (err) {
          this.addIncomingChatMessage({
            id: 'sys_' + Date.now(),
            type: 'system',
            username: 'System',
            displayName: 'System',
            message: 'Chat access is restricted for players with balance below\n1000 KES',
            likes: 0,
            createdAt: new Date().toISOString()
          });
          this.showToast('Chat access is restricted for players with balance below 1000 KES.', true);
          setTimeout(() => this.scrollToChatBottom(), 50);
        }
      })
    );

    const token = this.authService.getToken();
    if (token) {
      this.gameSocket.connect(token);
      this.checkChatEligibility();
    }

    // Listen for server-pushed M-Pesa success & failed events
    this.subs.push(
      this.gameSocket.mpesaSuccess$.subscribe(payload => {
        if (!payload) return;
        console.log(`[${new Date().toISOString()}] [PAYMENT_LOG] Player UI updated: mpesa_success`, payload);
        this.mpesaStatus.set('success');
        this.mpesaReceipt.set(payload.receipt);
        this.mpesaStatusMsg.set(`KES ${payload.amount} deposited! Receipt: ${payload.receipt}`);
        this.userBalance.set(payload.balance);
        this.authService.updateBalance(payload.balance);
        this.showToast(`M-Pesa deposit of KES ${payload.amount} confirmed!`);
        this.loadTransactionsHistory();
        setTimeout(() => this.showWalletModal.set(false), 2500);
      }),
      this.gameSocket.mpesaFailed$.subscribe(payload => {
        if (!payload) return;
        this.resetMpesaState();
        this.loadTransactionsHistory();
      })
    );
  }

  // --------------------------------------------------------------------------
  // STANDALONE / MOCK GAME LOOP ENGINE (Runs continuously even with 0 stake)
  // --------------------------------------------------------------------------
  private startStandaloneGameLoop() {
    // If backend is not connected, run local provably fair simulation loop
    this.onRoundStart();
  }

  public onRoundStart(durationMs = 5000) {
    this.gameState.set('WAITING');
    this.currentMultiplier.set(1.00);
    this.flightProgress = 0;
    this.lastCanvasFrameTime = 0;
    this.crashFlightProgress = 0;
    this.crashStartedAt = null;

    // Reset panel bet states for new round
    this.panel1.update(p => ({
      ...p,
      hasActiveBet: p.placedAmount > 0,
      isPending: false,
      hasCashedOut: false,
      cashedOutPayout: 0,
      cashedOutMultiplier: 0,
      selectedPreset: null,
      presetTapCount: 0
    }));

    this.panel2.update(p => ({
      ...p,
      hasActiveBet: p.placedAmount > 0,
      isPending: false,
      hasCashedOut: false,
      cashedOutPayout: 0,
      cashedOutMultiplier: 0,
      selectedPreset: null,
      presetTapCount: 0
    }));

    // Always seed the display-only fake player pool so the sidebar never
    // looks empty. Real server bets are prepended on top via addLiveBetBroadcast.
    // These fake entries NEVER reach the server or the admin dashboard.
    this.seedMockBets();

    // A queued stake is submitted only once the authoritative server opens
    // the next betting phase.
    this.activateQueuedBet(1);
    this.activateQueuedBet(2);

    // Auto bet triggers if enabled
    if (this.panel1().autoBetEnabled && !this.panel1().hasActiveBet && this.panel1().queuedAmount === 0) {
      setTimeout(() => this.placeBet(1), 100);
    }
    if (this.showPanel2() && this.panel2().autoBetEnabled && !this.panel2().hasActiveBet && this.panel2().queuedAmount === 0) {
      setTimeout(() => this.placeBet(2), 100);
    }

    // 5-second WAITING / Betting Countdown
    const totalDuration = Math.max(0, durationMs || 5000);
    this.countdownSeconds.set(Math.ceil(totalDuration / 1000));
    this.countdownProgress.set(100);
    const startTime = Date.now();

    if (this.bettingIntervalId) clearInterval(this.bettingIntervalId);

    this.bettingIntervalId = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const remaining = Math.max(0, totalDuration - elapsed);
      this.countdownSeconds.set(Math.ceil(remaining / 1000));
      const progress = Math.max(0, Math.min(100, (remaining / totalDuration) * 100));
      this.countdownProgress.set(progress);

      if (remaining <= 0) {
        clearInterval(this.bettingIntervalId);
        if (!this.isConnected()) {
          this.startFlightPhase();
        }
      }
    }, 30);
  }

  private startFlightPhase() {
    this.gameState.set('RUNNING');
    this.currentMultiplier.set(1.00);
    this.startFlightAudio();

    if (this.isConnected()) return;

    // -----------------------------------------------------------------------
    // PROVABLY FAIR CRASH POINT — Spribe Aviator specification
    // P(reaching multiplier m) = 0.97 / m   (3% house edge)
    // Derived crash point generation:
    //   - 3% of rounds: instant crash at 1.00x
    //   - Otherwise:    crashPoint = 0.97 / (1 − r),  r ~ Uniform[0,1)
    // Verification:
    //   P(crash ≤ 2x)  ≈ 51.5%  → P(reaching 2x)  ≈ 48.5%  ≈ 0.97/2  ✓
    //   P(crash ≤ 10x) ≈ 90.3%  → P(reaching 10x) ≈  9.7%  ≈ 0.97/10 ✓
    // -----------------------------------------------------------------------
    const crashPoint = this.generateLocalCrashPoint();
    /* Previous shared profile formula retained below as reference.
    const crashPoint: number = r < roomProfile.instantCrashChance
      ? 1.00                                               // 3% house edge — instant crash
      : parseFloat(Math.max(1.00, Math.min(roomProfile.ceiling, roomProfile.returnRate / (1 - r))).toFixed(2)); */

    const flightStartTime = Date.now();

    if (this.mockLoopIntervalId) clearInterval(this.mockLoopIntervalId);

    this.mockLoopIntervalId = setInterval(() => {
      if (this.isConnected()) {
        clearInterval(this.mockLoopIntervalId);
        return;
      }

      const elapsedSec = (Date.now() - flightStartTime) / 1000;

      // -----------------------------------------------------------------------
      // MULTIPLIER GROWTH — Hybrid Speed Specification
      // Formula: M(t) = 1.00 + 0.06 · t + 0.01 · t^2
      // Starts linearly (1.00x - 2.00x) then transitions into quadratic/exponential growth.
      // -----------------------------------------------------------------------
      const nextMult = this.calculateLocalMultiplier(elapsedSec);

      if (nextMult >= crashPoint) {
        clearInterval(this.mockLoopIntervalId);
        this.onCrash(crashPoint);
      } else {
        this.onMultiplierUpdate(nextMult);
        // simulateAICashouts is called inside onMultiplierUpdate
      }
    }, 16); // ~60fps — matches Spribe spec example tick rate
  }

  public onMultiplierUpdate(multiplier: number) {
    this.currentMultiplier.set(multiplier);

    // Animate fake-player cashouts on every tick (both demo & live socket modes)
    this.simulateAICashouts(multiplier);

    // Live update active bets in sidebar table
    this.liveBets.update(bets =>
      bets.map(b => {
        if (!b.cashedOut) {
          return {
            ...b,
            win: parseFloat((b.bet * multiplier).toFixed(2))
          };
        }
        return b;
      })
    );
  }

  public onCrash(finalPoint: number) {
    const wasFlying = this.gameState() === 'RUNNING';
    this.gameState.set('CRASHED');
    this.finalCrashMultiplier.set(finalPoint);
    this.currentMultiplier.set(finalPoint);

    // Freeze the exact in-flight point. The canvas immediately takes it through
    // one smooth exit path instead of jumping several pixels per frame.
    this.crashFlightProgress = this.flightProgress;
    this.crashStartedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();

    // Start the crash sound while the flight loop fades out. This is non-blocking
    // so neither the plane nor the next-round state waits for audio playback.
    if (wasFlying) {
      this.transitionToFlyAwayAudio();
    }

    // In live mode the history ribbon is delivered by the server, which is
    // also the data source used by the admin dashboard.
    if (!this.isConnected()) {
      this.history.update(h => [finalPoint, ...h.slice(0, 19)]);
    }

    // Current-round bets are over. A queued next-round stake is preserved.
    this.panel1.update(p => ({ ...p, placedAmount: 0, isPending: false, hasActiveBet: false }));
    this.panel2.update(p => ({ ...p, placedAmount: 0, isPending: false, hasActiveBet: false }));

    // Start the next betting phase as soon as the exit animation has cleared.
    // This keeps the crash result from holding on screen or waiting for audio.
    if (!this.isConnected()) {
      setTimeout(() => {
        this.onRoundStart();
      }, this.crashResultDurationMs);
    }
  }

  private onSocketPhaseChange(roundState: { phase: 'betting' | 'flying' | 'crashed'; durationMs?: number; multiplier?: number }) {
    if (roundState.phase === 'betting') {
      this.onRoundStart(roundState.durationMs);
    } else if (roundState.phase === 'flying') {
      const wasFlying = this.gameState() === 'RUNNING';
      this.gameState.set('RUNNING');
      this.currentMultiplier.set(roundState.multiplier ?? 1.00);
      if (!wasFlying) this.startFlightAudio();
    } else if (roundState.phase === 'crashed') {
      this.onCrash(roundState.multiplier ?? this.currentMultiplier());
    }
  }

  public requestRoomChange(room: GameRoom) {
    this.pendingRoom.set(room);
    this.showRoomModal.set(true);
  }

  public cancelRoomChange() {
    this.showRoomModal.set(false);
    this.pendingRoom.set(this.selectedRoom());
  }

  public confirmRoomChange() {
    const room = this.pendingRoom();
    if (room === this.selectedRoom()) {
      this.cancelRoomChange();
      return;
    }

    const isDemoSession = !this.authService.getToken();
    if (!isDemoSession && !this.isConnected()) {
      this.showRoomModal.set(false);
      this.showToast('Connecting to the game service. Please try again in a moment.', true);
      return;
    }

    if (this.bettingIntervalId) clearInterval(this.bettingIntervalId);
    if (this.mockLoopIntervalId) clearInterval(this.mockLoopIntervalId);
    if (this.fakeJoinIntervalId) clearInterval(this.fakeJoinIntervalId);
    this.stopAllGameAudio();

    this.selectedRoom.set(room);
    this.resetRoomBets();
    this.history.set([...this.demoRoomHistories[room]]);
    this.currentMultiplier.set(1.00);
    this.finalCrashMultiplier.set(1.00);
    this.gameState.set('WAITING');
    this.showRoomModal.set(false);

    if (isDemoSession) {
      this.onRoundStart();
    } else if (!this.gameSocket.changeRoom(room)) {
      this.showToast('Unable to switch rooms. Please reconnect and try again.', true);
    }
  }

  private resetRoomBets() {
    const reset = (panel: PanelBetState): PanelBetState => ({
      ...panel,
      placedAmount: 0,
      queuedAmount: 0,
      isPending: false,
      hasActiveBet: false,
      hasCashedOut: false,
      cashedOutPayout: 0,
      cashedOutMultiplier: 0,
      selectedPreset: null,
      presetTapCount: 0
    });
    this.panel1.update(reset);
    this.panel2.update(reset);
  }

  private restoreRoomBets(roomState: RoomState) {
    const restore = (slot: 1 | 2) => (panel: PanelBetState): PanelBetState => {
      const bet = roomState.activeBets.find(item => item.slot === slot);
      if (!bet) {
        return { ...panel, placedAmount: 0, queuedAmount: 0, isPending: false, hasActiveBet: false, hasCashedOut: false, cashedOutPayout: 0, cashedOutMultiplier: 0 };
      }
      return {
        ...panel,
        placedAmount: bet.amount,
        queuedAmount: 0,
        isPending: false,
        hasActiveBet: bet.status === 'placed',
        hasCashedOut: bet.status === 'cashed_out',
        cashedOutPayout: bet.payoutAmount,
        cashedOutMultiplier: bet.cashoutMultiplier || 0
      };
    };
    this.panel1.update(restore(1));
    this.panel2.update(restore(2));
  }

  private generateLocalCrashPoint(): number {
    const nextRandom = () => Math.random();
    const round = (value: number) => parseFloat(Math.max(1.00, value).toFixed(2));

    if (this.selectedRoom() === 1) {
      const random = nextRandom();
      return random < 0.03 ? 1.00 : round(Math.min(100000, 0.97 / (1 - random)));
    }

    const band = nextRandom();
    if (this.selectedRoom() === 2) {
      if (band < 0.42) return round(1.00 + nextRandom() * 0.75);
      if (band < 0.84) return round(1.75 + nextRandom() * 1.75);
      if (band < 0.97) return round(3.50 + nextRandom() * 6.50);
      return round(10.00 + nextRandom() * 40.00);
    }

    if (band < 0.60) return round(1.00 + nextRandom() * 0.45);
    if (band < 0.86) return round(1.45 + nextRandom() * 3.55);
    if (band < 0.97) return round(5.00 + nextRandom() * 20.00);
    return round(25.00 + nextRandom() * 225.00);
  }

  private calculateLocalMultiplier(elapsedSec: number): number {
    if (this.selectedRoom() === 2) {
      return parseFloat((1.00 + 0.11 * elapsedSec + 0.0025 * Math.pow(elapsedSec, 2)).toFixed(2));
    }
    if (this.selectedRoom() === 3) {
      return parseFloat(Math.exp(0.095 * elapsedSec).toFixed(2));
    }
    return parseFloat((1.00 + 0.06 * elapsedSec + 0.01 * Math.pow(elapsedSec, 2)).toFixed(2));
  }

  // --------------------------------------------------------------------------
  // PAYOUT & AUTO CASHOUT CALCULATIONS
  // --------------------------------------------------------------------------
  private evaluateAutoCashouts(mult: number) {
    const p1 = this.panel1();
    if ((p1.mode === 'auto' || p1.autoCashOutEnabled) && p1.hasActiveBet && !p1.hasCashedOut && mult >= p1.autoTarget) {
      this.cashOut(1);
    }

    const p2 = this.panel2();
    if (this.showPanel2() && (p2.mode === 'auto' || p2.autoCashOutEnabled) && p2.hasActiveBet && !p2.hasCashedOut && mult >= p2.autoTarget) {
      this.cashOut(2);
    }
  }

  public placeBet(panelIndex: 1 | 2) {
    // Once the plane is in flight, a stake belongs to the following round.
    if (this.gameState() !== 'WAITING') {
      this.queueBet(panelIndex);
      return;
    }

    const panel = panelIndex === 1 ? this.panel1() : this.panel2();
    const amount = panel.amount;

    if (!Number.isFinite(amount) || amount <= 0) {
      this.showToast('Please enter a valid bet amount', true);
      return;
    }

    if (panel.hasActiveBet || panel.queuedAmount > 0 || panel.isPending) return;

    if (amount > this.userBalance()) {
      // Open deposit modal tab immediately without bottom toast notification
      this.walletTab.set('deposit');
      this.showWalletModal.set(true);
      return;
    }

    if (this.isConnected()) {
      // The backend owns live balances, bet acceptance, and the admin feed.
      // Do not optimistically mutate any of those values on the client.
      this.setPanelPending(panelIndex, true);
      this.gameSocket.placeBet(amount, panelIndex);
      return;
    }

    // Deduct balance
    const newBalance = this.userBalance() - amount;
    this.userBalance.set(newBalance);
    this.authService.updateBalance(newBalance);

    if (panelIndex === 1) {
      this.panel1.update(p => ({
        ...p,
        placedAmount: amount,
        hasActiveBet: true,
        hasCashedOut: false
      }));
    } else {
      this.panel2.update(p => ({
        ...p,
        placedAmount: amount,
        hasActiveBet: true,
        hasCashedOut: false
      }));
    }

    // Add user bet to live sidebar table
    const username = this.currentUser()?.username || 'You';
    const newBetRow: LiveBet = {
      id: Math.random().toString(36).substring(2, 9),
      player: username,
      avatarIcon: this.selectedAvatarIcon() || 'PRO',
      bet: amount,
      multiplier: null,
      win: 0,
      cashedOut: false,
      isCurrentUser: true
    };

    this.liveBets.update(list => [newBetRow, ...list]);
  }

  /**
   * Reserve a stake while a round is in flight. It is promoted to an active
   * bet by activateQueuedBet as soon as the next betting phase opens.
   */
  public queueBet(panelIndex: 1 | 2) {
    const panel = panelIndex === 1 ? this.panel1() : this.panel2();
    const amount = panel.amount;

    if (this.gameState() === 'WAITING') {
      this.placeBet(panelIndex);
      return;
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      this.showToast('Please enter a valid bet amount', true);
      return;
    }

    if (panel.queuedAmount > 0 || panel.isPending) return;

    if (amount > this.userBalance()) {
      // Open deposit modal tab immediately without bottom toast notification
      this.walletTab.set('deposit');
      this.showWalletModal.set(true);
      return;
    }

    if (this.isConnected()) {
      if (panelIndex === 1) {
        this.panel1.update(p => ({ ...p, queuedAmount: amount }));
      } else {
        this.panel2.update(p => ({ ...p, queuedAmount: amount }));
      }
      return;
    }

    const newBalance = this.userBalance() - amount;
    this.userBalance.set(newBalance);
    this.authService.updateBalance(newBalance);

    if (panelIndex === 1) {
      this.panel1.update(p => ({ ...p, queuedAmount: amount }));
    } else {
      this.panel2.update(p => ({ ...p, queuedAmount: amount }));
    }
  }

  /** Moves a reserved next-round stake into the current betting phase. */
  public activateQueuedBet(panelIndex: 1 | 2) {
    const panel = panelIndex === 1 ? this.panel1() : this.panel2();
    const queuedAmount = panel.queuedAmount;

    if (queuedAmount <= 0) return;

    if (this.isConnected()) {
      this.setPanelPending(panelIndex, true, true);
      this.gameSocket.placeBet(queuedAmount, panelIndex);
      return;
    }

    const activate = (p: PanelBetState): PanelBetState => ({
      ...p,
      placedAmount: queuedAmount,
      queuedAmount: 0,
      hasActiveBet: true,
      hasCashedOut: false,
      cashedOutPayout: 0,
      cashedOutMultiplier: 0
    });

    if (panelIndex === 1) {
      this.panel1.update(activate);
    } else {
      this.panel2.update(activate);
    }

  }

  public cancelQueuedBet(panelIndex: 1 | 2) {
    const panel = panelIndex === 1 ? this.panel1() : this.panel2();
    if (panel.queuedAmount <= 0) return;

    if (!this.isConnected()) {
      const refunded = this.userBalance() + panel.queuedAmount;
      this.userBalance.set(refunded);
      this.authService.updateBalance(refunded);
    }

    if (panelIndex === 1) {
      this.panel1.update(p => ({ ...p, queuedAmount: 0 }));
    } else {
      this.panel2.update(p => ({ ...p, queuedAmount: 0 }));
    }

    this.showToast('Next-round bet cancelled');
  }

  public cancelBet(panelIndex: 1 | 2) {
    const panel = panelIndex === 1 ? this.panel1() : this.panel2();

    if (panel.queuedAmount > 0) {
      this.cancelQueuedBet(panelIndex);
      return;
    }

    if (this.gameState() !== 'WAITING' || !panel.hasActiveBet) return;

    if (this.isConnected()) {
      this.gameSocket.cancelBet(panelIndex);
      this.setPanelPending(panelIndex, false);
      if (panelIndex === 1) {
        this.panel1.update(p => ({ ...p, hasActiveBet: false, placedAmount: 0 }));
      } else {
        this.panel2.update(p => ({ ...p, hasActiveBet: false, placedAmount: 0 }));
      }
      return;
    }

    // Refund balance
    const refunded = this.userBalance() + panel.placedAmount;
    this.userBalance.set(refunded);
    this.authService.updateBalance(refunded);

    if (panelIndex === 1) {
      this.panel1.update(p => ({ ...p, hasActiveBet: false, placedAmount: 0 }));
    } else {
      this.panel2.update(p => ({ ...p, hasActiveBet: false, placedAmount: 0 }));
    }

    this.showToast('Bet cancelled');
  }

  public cashOut(panelIndex: 1 | 2) {
    const mult = this.currentMultiplier();
    const panel = panelIndex === 1 ? this.panel1() : this.panel2();

    if (this.gameState() !== 'RUNNING' || !panel.hasActiveBet || panel.hasCashedOut || panel.isPending) return;

    if (this.isConnected()) {
      this.setPanelPending(panelIndex, true);
      this.gameSocket.cashOut(panelIndex);
      return;
    }

    const payout = parseFloat((panel.placedAmount * mult).toFixed(2));

    // Credit win to wallet balance
    const updatedBalance = this.userBalance() + payout;
    this.userBalance.set(updatedBalance);
    this.authService.updateBalance(updatedBalance);

    if (panelIndex === 1) {
      this.panel1.update(p => ({
        ...p,
        hasCashedOut: true,
        cashedOutPayout: payout,
        cashedOutMultiplier: mult
      }));
    } else {
      this.panel2.update(p => ({
        ...p,
        hasCashedOut: true,
        cashedOutPayout: payout,
        cashedOutMultiplier: mult
      }));
    }

    // Highlight user row in "All Bets" table
    const username = this.currentUser()?.username || 'You';
    this.liveBets.update(list =>
      list.map(b => {
        if (b.player === username || b.isCurrentUser) {
          return {
            ...b,
            multiplier: mult,
            win: payout,
            cashedOut: true
          };
        }
        return b;
      })
    );

    this.triggerCashoutNotification(mult, payout, panelIndex);
    // Cashout notification banner at top of canvas is displayed above
  }

  private setPanelPending(panelIndex: 1 | 2, isPending: boolean, clearQueued = false) {
    const apply = (panel: PanelBetState): PanelBetState => ({
      ...panel,
      isPending,
      queuedAmount: clearQueued ? 0 : panel.queuedAmount
    });

    if (panelIndex === 1) {
      this.panel1.update(apply);
    } else {
      this.panel2.update(apply);
    }
  }

  /** Supports a backend restart rolling out the two-panel protocol. */
  private resolveResponsePanel(slot?: 1 | 2): 1 | 2 | null {
    if (slot === 1 || slot === 2) return slot;
    if (this.panel1().isPending) return 1;
    if (this.panel2().isPending) return 2;
    return null;
  }

  private clearPendingPanels() {
    this.setPanelPending(1, false);
    this.setPanelPending(2, false);
  }

  private confirmBet(panelIndex: 1 | 2, amount: number) {
    const apply = (panel: PanelBetState): PanelBetState => ({
      ...panel,
      placedAmount: amount,
      queuedAmount: 0,
      isPending: false,
      hasActiveBet: true,
      hasCashedOut: false,
      cashedOutPayout: 0,
      cashedOutMultiplier: 0
    });

    if (panelIndex === 1) {
      this.panel1.update(apply);
    } else {
      this.panel2.update(apply);
    }
  }

  private confirmCashout(panelIndex: 1 | 2, multiplier: number, payout: number) {
    const apply = (panel: PanelBetState): PanelBetState => ({
      ...panel,
      isPending: false,
      hasCashedOut: true,
      cashedOutPayout: payout,
      cashedOutMultiplier: multiplier
    });

    if (panelIndex === 1) {
      this.panel1.update(apply);
    } else {
      this.panel2.update(apply);
    }

    this.triggerCashoutNotification(multiplier, payout, panelIndex);
  }

  public triggerCashoutNotification(multiplier: number, payout: number, slot: 1 | 2 = 1) {
    this.cashoutNotification.set({ multiplier, payout, slot });
    if (this.cashoutNotificationTimeout) {
      clearTimeout(this.cashoutNotificationTimeout);
    }
    this.cashoutNotificationTimeout = setTimeout(() => {
      this.cashoutNotification.set(null);
    }, 2800);
  }

  public dismissCashoutNotification() {
    if (this.cashoutNotificationTimeout) {
      clearTimeout(this.cashoutNotificationTimeout);
    }
    this.cashoutNotification.set(null);
  }

  public showWithdrawalNotification(payload: { id?: number; title?: string; message: string; type?: string; timestamp?: string; createdAt?: string }) {
    if (payload.id && payload.id === this.lastWithdrawalNotificationId) return;
    if (this.withdrawalNotifTimeout) clearTimeout(this.withdrawalNotifTimeout);
    if (payload.id) this.lastWithdrawalNotificationId = payload.id;

    const createdAt = payload.createdAt || payload.timestamp;
    const timestamp = createdAt
      ? new Date(createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    this.withdrawalNotif.set({
      id: payload.id,
      title: payload.title || 'Ligibet Notification',
      message: payload.message,
      type: payload.type || 'info',
      timestamp
    });
    // Auto-dismiss after 6 seconds so the player can read the admin-edited message
    this.withdrawalNotifTimeout = setTimeout(() => {
      this.withdrawalNotif.set(null);
    }, 6000);
  }

  public dismissWithdrawalNotification() {
    if (this.withdrawalNotifTimeout) clearTimeout(this.withdrawalNotifTimeout);
    this.withdrawalNotif.set(null);
  }

  public claimWelcomeBonus() {
    if (this.isClaimingBonus()) return;
    if (this.currentUser()?.bonus_claimed) {
      this.showBonusNotification('Bonus Active', 'Your 3,500 KES welcome bonus is already credited in your wallet.', 'success');
      return;
    }

    // Balance is the qualifier, not deposit history — the old copy said
    // "deposit required", which read as though a past deposit was enough.
    if (this.userBalance() < 2000) {
      this.showBonusNotification(
        'Balance Requirement',
        `A wallet balance of at least 2,000 KES is required to claim the 3,500 KES welcome bonus. `
          + `Your balance is ${this.userBalance().toFixed(2)} KES.`,
        'info'
      );
      return;
    }

    this.isClaimingBonus.set(true);
    this.authService.claimWelcomeBonus().subscribe({
      next: response => {
        this.userBalance.set(response.balance);
        this.currentUser.update(user => user ? { ...user, bonus_claimed: true, balance: response.balance } : user);
        this.showProfileDropdown.set(false);
        this.showBonusNotification('Bonus Claimed!', response.message || '3,500 KES has been added to your wallet.', 'success');
        this.isClaimingBonus.set(false);
        this.loadTransactionsHistory();
      },
      error: message => {
        this.isClaimingBonus.set(false);
        const errText = typeof message === 'string' ? message : 'Could not process bonus at this moment.';
        if (errText.toLowerCase().includes('already')) {
          this.currentUser.update(user => user ? { ...user, bonus_claimed: true } : user);
          this.showBonusNotification('Bonus Active', 'Your 3,500 KES welcome bonus is active in your wallet balance.', 'success');
        } else {
          this.showBonusNotification('Bonus Notice', errText, 'info');
        }
      }
    });
  }

  public showBonusNotification(title: string, message: string, type: 'success' | 'info') {
    if (this.bonusNotifTimeout) clearTimeout(this.bonusNotifTimeout);
    this.bonusNotif.set({ title, message, type });
    this.bonusNotifTimeout = setTimeout(() => this.bonusNotif.set(null), 6500);
  }

  public dismissBonusNotification() {
    if (this.bonusNotifTimeout) clearTimeout(this.bonusNotifTimeout);
    this.bonusNotif.set(null);
  }

  public triggerDualPanelAction() {
    const state = this.gameState();
    if (state === 'WAITING') {
      if (!this.panel1().hasActiveBet && !this.panel1().queuedAmount && !this.panel1().isPending) {
        this.placeBet(1);
      }
      if (!this.panel2().hasActiveBet && !this.panel2().queuedAmount && !this.panel2().isPending) {
        this.placeBet(2);
      }
    } else if (state === 'RUNNING') {
      if (this.panel1().hasActiveBet && !this.panel1().hasCashedOut && !this.panel1().isPending) {
        this.cashOut(1);
      }
      if (this.panel2().hasActiveBet && !this.panel2().hasCashedOut && !this.panel2().isPending) {
        this.cashOut(2);
      }
    }
  }

  // --------------------------------------------------------------------------
  // SIDEBAR MOCK BETS FEED  (frontend-only — never touches backend / admin)
  // --------------------------------------------------------------------------

  /** Kenyan-style masked phone prefixes + name fragments */
  private readonly FAKE_PREFIXES = [
    '07***', '01***', '07***', '07***', '01***',
    'J***o', 'M***i', 'K***e', 'A***a', 'P***r',
    'W***u', 'B***n', 'S***h', 'F***x', 'D***s'
  ];

  private readonly FAKE_AVATARS = [
    '🦊', '🐯', '🦁', '🐻', '🐼', '🐨', '🦅', '🐺', '🦈', '🐲',
    '🎯', '⚡', '💎', '🔥', '🌟', '🚀', '🎮', '🏆', '👑', '🎲',
    '😎', '🦄', '🥇', '💰', '🦾', '🎩', '🥊', '🏎️', '⚽', '🔥'
  ];

  /** Weighted bet amounts (KES) — majority small, tail of big spenders */
  private readonly FAKE_BET_POOL = [
    50, 50, 100, 100, 100, 100, 100, 100,
    200, 200, 200, 200, 300, 300,
    500, 500, 500, 500, 1000, 1000, 1000,
    2000, 5000, 10000
  ];

  private makeFakePlayer(index: number): LiveBet {
    const prefix = this.FAKE_PREFIXES[index % this.FAKE_PREFIXES.length];
    const suffix = Math.floor(Math.random() * 900 + 100); // 3-digit randomizer
    return {
      id: `fake-${index}-${Date.now()}`,
      player: `${prefix}${suffix}`,
      avatarIcon: this.FAKE_AVATARS[index % this.FAKE_AVATARS.length],
      bet: this.FAKE_BET_POOL[Math.floor(Math.random() * this.FAKE_BET_POOL.length)],
      multiplier: null,
      win: 0,
      cashedOut: false
    };
  }

  /**
   * Seed initial batch of ~160 fake players then trickle-in 40 more
   * during the WAITING window (staggered across 5 s = 250 ms bursts).
   * This is PURELY frontend — liveBets signal only.
   */
  private seedMockBets() {
    if (this.fakeJoinIntervalId) clearInterval(this.fakeJoinIntervalId);

    // Initial batch — 160 instant players
    const initialBatch: LiveBet[] = [];
    for (let i = 0; i < 160; i++) {
      initialBatch.push(this.makeFakePlayer(i));
    }
    this.liveBets.set(initialBatch);

    // Trickle-in 40 more over the 5-second betting window
    let trickleCount = 0;
    this.fakeJoinIntervalId = setInterval(() => {
      if (trickleCount >= 40 || this.gameState() !== 'WAITING') {
        clearInterval(this.fakeJoinIntervalId);
        return;
      }
      // Add 2–5 players at a time randomly
      const burst = Math.floor(Math.random() * 4) + 2;
      const newPlayers: LiveBet[] = [];
      for (let j = 0; j < burst && trickleCount < 40; j++, trickleCount++) {
        newPlayers.push(this.makeFakePlayer(160 + trickleCount));
      }
      this.liveBets.update(list => [...newPlayers, ...list].slice(0, this.maxBetFeedSize));
    }, 250);
  }

  /**
   * Progressive cashout simulation — spreads cashouts realistically.
   * Players with low auto-targets exit early; diamond hands hold longer.
   * Cash-out probability rises non-linearly with multiplier height.
   */
  private simulateAICashouts(currentMult: number) {
    // Sigmoid-inspired probability: very low at 1x, peaks at ~3x
    // P(cashout at tick) ≈ 0.004 + 0.08 * (1 - e^(-0.5 * (mult-1)))
    const basePct = 0.004 + 0.08 * (1 - Math.exp(-0.5 * (currentMult - 1)));

    this.liveBets.update(bets =>
      bets.map(b => {
        if (!b.cashedOut && !b.isCurrentUser && Math.random() < basePct) {
          // Slight jitter so shown multiplier isn't perfectly identical for all
          const jitter = parseFloat((Math.random() * 0.03 - 0.015).toFixed(2));
          const mult = parseFloat(Math.max(1.00, currentMult + jitter).toFixed(2));
          return {
            ...b,
            multiplier: mult,
            win: parseFloat((b.bet * mult).toFixed(2)),
            cashedOut: true
          };
        }
        return b;
      })
    );
  }

  private addLiveBetBroadcast(b: LiveBetBroadcast) {
    const row: LiveBet = {
      id: b.betId ? `bet-${b.betId}` : Math.random().toString(),
      player: b.player,
      avatarIcon: this.selectedAvatarIcon() || '😎',
      bet: b.bet,
      multiplier: b.multiplier,
      win: b.win,
      cashedOut: b.cashedOut,
      isCurrentUser: b.userId === this.currentUser()?.id
    };
    this.liveBets.update(list => [row, ...list].slice(0, this.maxBetFeedSize));
  }

  private updateLiveBetBroadcast(c: LiveBetBroadcast) {
    this.liveBets.update(list =>
      list.map(item => {
        const isMatchingBet = c.betId
          ? item.id === `bet-${c.betId}`
          : item.player === c.player;
        if (isMatchingBet) {
          return {
            ...item,
            multiplier: c.multiplier,
            win: c.win,
            cashedOut: true
          };
        }
        return item;
      })
    );
  }

  // --------------------------------------------------------------------------
  // HTML5 CANVAS RENDERING ENGINE (60 FPS Exponential Trajectory & Effects)
  // --------------------------------------------------------------------------
  private initCanvas() {
    if (!this.canvasRef) return;
    const canvas = this.canvasRef.nativeElement;
    this.ctx = canvas.getContext('2d');
    this.resizeCanvas();

    // Use ResizeObserver to re-size canvas whenever container dimensions change
    if (this.canvasContainerRef) {
      this.resizeObserver = new ResizeObserver(() => {
        this.resizeCanvas();
      });
      this.resizeObserver.observe(this.canvasContainerRef.nativeElement);
    }
  }

  private resizeCanvas() {
    if (!this.canvasRef || !this.canvasContainerRef) return;
    const canvas = this.canvasRef.nativeElement;
    const container = this.canvasContainerRef.nativeElement;
    const dpr = window.devicePixelRatio || 1;

    const w = container.clientWidth;
    const h = container.clientHeight;

    // Only resize if container has actual dimensions
    if (w === 0 || h === 0) return;

    // Set physical pixel dimensions
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);

    if (this.ctx) {
      this.ctx.setTransform(1, 0, 0, 1, 0, 0); // reset any previous transforms
      this.ctx.scale(dpr, dpr);
    }
  }

  private startCanvasRenderLoop = (frameTime = performance.now()) => {
    this.renderFrame(frameTime);
    this.animationFrameId = requestAnimationFrame(this.startCanvasRenderLoop);
  };

  private renderFrame(frameTime: number) {
    if (!this.ctx || !this.canvasRef || !this.canvasContainerRef) return;
    const container = this.canvasContainerRef.nativeElement;
    const w = container.clientWidth;
    const h = container.clientHeight;

    const state = this.gameState();
    const mult = this.currentMultiplier();

    const elapsedMs = this.lastCanvasFrameTime
      ? Math.min(60, frameTime - this.lastCanvasFrameTime)
      : 16.67;
    this.lastCanvasFrameTime = frameTime;
    const dt = Math.min(0.06, elapsedMs / 1000);

    // ─── SLOW, SMOOTH SUNBURST ROTATION (SPRIBE SILKY BACKGROUND FLOW) ─────
    const rays = 32;
    const rayAngle = (Math.PI / 2) / rays;
    const rayCycle = rayAngle * 2;

    if (state === 'RUNNING') {
      // Gentle, slow graceful drift during flight
      const flightSpeed = 0.045 + Math.min(0.04, (mult - 1) * 0.005);
      this.sunburstAngle = (this.sunburstAngle + flightSpeed * dt) % rayCycle;
    } else if (state === 'CRASHED') {
      const crashSpeed = 0.035;
      this.sunburstAngle = (this.sunburstAngle + crashSpeed * dt) % rayCycle;
    } else {
      // WAITING state: barely noticeable subtle idle drift
      const idleSpeed = 0.018;
      this.sunburstAngle = (this.sunburstAngle + idleSpeed * dt) % rayCycle;
    }

    // 1. Deep Solid Black Background
    this.ctx.fillStyle = '#000000';
    this.ctx.fillRect(0, 0, w, h);

    // 2. Draw Moving Sunburst Radiating Fan Lines
    this.drawSunburstRays(w, h, this.sunburstAngle, rayAngle);

    // 3. Ambient Flight Glow: Blue when < 2.00x (Image 1), Purple when >= 2.00x (Image 2)
    this.drawFlightZoneGlow(w, h, mult, state, elapsedMs);

    if (state === 'RUNNING' || state === 'CRASHED') {
      const isMobileBoard = w <= 600;
      const spriteScale = isMobileBoard ? 0.95 : 1.25;

      // ─── FLIGHT PROGRESS & SMOOTH INTERPOLATION (BETIKA / SPRIBE ULTRA-SMOOTH) ───
      if (state === 'RUNNING') {
        const m = Math.max(1.00, mult);
        const climbP = 1 - Math.pow(m, -0.68);
        const targetProgress = Math.min(0.86, Math.max(0.04, 0.04 + climbP * 0.84));
        const dt = Math.min(0.05, elapsedMs / 1000);
        const smoothing = 1 - Math.exp(-dt * 5.5);
        this.flightProgress += (targetProgress - this.flightProgress) * smoothing;
      }

      const p = state === 'CRASHED' ? this.crashFlightProgress : this.flightProgress;

      // ─── SAFE PLANE BOUNDS ──────────────────────────────────────────────────
      const planeDrawW = 84 * spriteScale;
      const planeDrawH = 46 * spriteScale;
      const marginX = planeDrawW * 0.50;
      const marginY = planeDrawH * 0.55;

      const minX = marginX + (isMobileBoard ? 8 : 16);
      const maxX = w - marginX - (isMobileBoard ? 10 : 20);
      const maxY = h - marginY - 6;
      const minY = marginY + (isMobileBoard ? 10 : 16);

      const basePathX = minX + (maxX - minX) * p;
      const basePathY = maxY - (maxY - minY) * Math.pow(p, 0.84);

      // Subtle, silky Spribe aerodynamic floating
      const flightTime = frameTime / 1000;
      const waveX = Math.sin(flightTime * 0.9) * 3.5;
      const waveY = Math.cos(flightTime * 1.1) * 5.0;

      const planeX = Math.max(minX, Math.min(maxX, basePathX + waveX));
      const planeY = Math.max(minY, Math.min(maxY, basePathY + waveY));

      // Gentle dynamic pitch
      const dynamicPitch = -0.045 + Math.sin(flightTime * 1.1) * 0.015;

      // Exact rear-wheel / tail point of the airplane where the red trail connects
      const tailX = planeX - planeDrawW * 0.40;
      const tailY = planeY + planeDrawH * 0.16;

      // Exponential Bezier control point anchored at the bottom
      const ctrlX = tailX * 0.42;
      const ctrlY = h;

      // ─── 1 & 2. TRANSLUCENT RED TRAIL FILL & CURVE (ONLY DURING ACTIVE FLIGHT) ───
      if (state === 'RUNNING' && !this.isSanitized()) {
        const fill = this.ctx.createLinearGradient(0, tailY, 0, h);
        fill.addColorStop(0, 'rgba(215, 12, 45, 0.55)');
        fill.addColorStop(0.5, 'rgba(150, 8, 30, 0.36)');
        fill.addColorStop(1, 'rgba(80, 4, 16, 0.18)');

        this.ctx.beginPath();
        this.ctx.moveTo(0, h);
        this.ctx.quadraticCurveTo(ctrlX, ctrlY, tailX, tailY);
        this.ctx.lineTo(tailX, h); // Clean straight vertical drop to floor!
        this.ctx.lineTo(0, h);     // Back along floor baseline
        this.ctx.closePath();
        this.ctx.fillStyle = fill;
        this.ctx.fill();

        // ─── VIBRANT GLOWING RED TRAIL CURVE ────────────────────────────────
        this.ctx.beginPath();
        this.ctx.moveTo(0, h);
        this.ctx.quadraticCurveTo(ctrlX, ctrlY, tailX, tailY);
        this.ctx.strokeStyle = '#e50914';
        this.ctx.lineWidth = 3.2;
        this.ctx.shadowColor = '#e50914';
        this.ctx.shadowBlur = 10;
        this.ctx.stroke();
        this.ctx.shadowBlur = 0;
      }

      // ─── 3. PLANE SPRITE (WITH NATURAL DYNAMIC PITCH & PROPELLER) ───────────
      if (state === 'RUNNING') {
        if (!this.isSanitized()) {
          this.drawAirplaneSprite(planeX, planeY, dynamicPitch, spriteScale);
        }
      } else if (state === 'CRASHED') {
        const crashStartedAt = this.crashStartedAt ?? frameTime;
        const crashProgress = Math.max(0, Math.min(1, (frameTime - crashStartedAt) / this.crashExitDurationMs));
        const exitDistance = 1 - Math.pow(1 - crashProgress, 2);
        const crashedX = planeX + (w * 0.45 + planeDrawW) * exitDistance;
        const crashedY = planeY - (h * 0.42 + planeDrawH) * exitDistance;
        if (crashProgress < 1 && !this.isSanitized()) {
          this.drawAirplaneSprite(crashedX, crashedY, -0.12 - crashProgress * 0.35, spriteScale);
        }
      }
    } else {
      // WAITING Phase
    }
  }

  private drawSunburstRays(w: number, h: number, offsetAngle: number, rayAngle: number) {
    if (!this.ctx) return;
    this.ctx.save();
    const maxDist = Math.hypot(w, h) * 1.8;

    // Angle coverage from below horizontal baseline (-0.35 rad) to past vertical axis (PI/2 + 0.35 rad)
    const minAngle = -0.35;
    const maxAngle = Math.PI / 2 + 0.35;

    const startIndex = Math.floor(minAngle / rayAngle) - 2;
    const endIndex = Math.ceil(maxAngle / rayAngle) + 2;

    for (let i = startIndex; i <= endIndex; i++) {
      // Rotate clockwise / downward relative to bottom-left origin to simulate forward/upward flight
      const a1 = i * rayAngle - offsetAngle;
      const a2 = (i + 1) * rayAngle - offsetAngle;

      this.ctx.beginPath();
      this.ctx.moveTo(0, h);
      this.ctx.lineTo(Math.cos(a1) * maxDist, h - Math.sin(a1) * maxDist);
      this.ctx.lineTo(Math.cos(a2) * maxDist, h - Math.sin(a2) * maxDist);
      this.ctx.closePath();

      const isEven = Math.abs(i) % 2 === 0;
      this.ctx.fillStyle = isEven ? 'rgba(255, 255, 255, 0.085)' : 'rgba(0, 0, 0, 0.35)';
      this.ctx.fill();
    }
    this.ctx.restore();
  }

  private drawFlightZoneGlow(
    w: number,
    h: number,
    multiplier: number,
    state: GameState,
    elapsedMs: number
  ) {
    if (!this.ctx || state === 'WAITING' || state === 'CRASHED') return;

    // Target purple factor: 0 when < 2.00x, 1 when >= 2.00x
    const targetPurple = multiplier >= 2.0 ? 1 : 0;
    const dt = Math.min(0.1, elapsedMs / 1000);
    this.purpleGlowPhase += (targetPurple - this.purpleGlowPhase) * (1 - Math.exp(-dt * 8));

    const p = Math.max(0, Math.min(1, this.purpleGlowPhase));

    // Under 2x: Electric Cyan-Blue (#0091ff) (Image 1)
    // Over 2x: Vivid Magenta-Purple (#d500a5) (Image 2)
    const r = Math.round(0 + (215 - 0) * p);
    const g = Math.round(145 + (20 - 145) * p);
    const b = Math.round(245 + (160 - 245) * p);

    // Designated focal center (behind the multiplier text & plane flight zone)
    const cx = w * 0.50;
    const cy = h * 0.44;

    this.ctx.save();
    
    // Stretch horizontally to match the wide spotlight beam in reference images
    this.ctx.translate(cx, cy);
    this.ctx.scale(1.35, 1.0);

    const radius = Math.min(w * 0.38, h * 0.62);

    const glow = this.ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
    glow.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.88)`);
    glow.addColorStop(0.25, `rgba(${Math.round(r * 0.85)}, ${Math.round(g * 0.85)}, ${Math.round(b * 0.85)}, 0.65)`);
    glow.addColorStop(0.52, `rgba(${Math.round(r * 0.55)}, ${Math.round(g * 0.55)}, ${Math.round(b * 0.55)}, 0.32)`);
    glow.addColorStop(0.78, `rgba(${Math.round(r * 0.25)}, ${Math.round(g * 0.25)}, ${Math.round(b * 0.25)}, 0.08)`);
    glow.addColorStop(1, 'rgba(0, 0, 0, 0)');

    this.ctx.fillStyle = glow;
    this.ctx.beginPath();
    this.ctx.arc(0, 0, radius, 0, Math.PI * 2);
    this.ctx.fill();

    this.ctx.restore();
  }

  private drawAxesGrid(w: number, h: number) {
    if (!this.ctx) return;
    this.ctx.save();
    this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
    this.ctx.lineWidth = 1;

    // Horizontal grid lines
    for (let y = h - 40; y > 20; y -= 55) {
      this.ctx.beginPath();
      this.ctx.moveTo(30, y);
      this.ctx.lineTo(w - 20, y);
      this.ctx.stroke();
    }

    // Vertical grid lines
    for (let x = 40; x < w - 20; x += 75) {
      this.ctx.beginPath();
      this.ctx.moveTo(x, 20);
      this.ctx.lineTo(x, h - 30);
      this.ctx.stroke();
    }
    this.ctx.restore();
  }

  private drawAirplaneSprite(x: number, y: number, angle: number, scale = 1.55) {
    if (!this.ctx) return;
    this.ctx.save();
    this.ctx.translate(x, y);
    this.ctx.rotate(angle);
    this.ctx.scale(scale, scale);

    if (this.planeImage && this.planeImage.complete && this.planeImage.naturalWidth > 0) {
      // Render clean user uploaded transparent red plane
      const drawWidth = 95;
      const drawHeight = (drawWidth * this.planeImage.naturalHeight) / this.planeImage.naturalWidth;
      this.ctx.drawImage(this.planeImage, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
      this.drawUploadedPlanePropeller(drawWidth, drawHeight);
    } else {
      // Fallback: Engine glow behind the tail
      const glowGradient = this.ctx.createRadialGradient(-30, 0, 1, -30, 0, 22);
      glowGradient.addColorStop(0, 'rgba(255, 56, 95, 0.72)');
      glowGradient.addColorStop(1, 'rgba(225, 29, 72, 0)');
      this.ctx.fillStyle = glowGradient;
      this.ctx.beginPath();
      this.ctx.arc(-30, 0, 22, 0, Math.PI * 2);
      this.ctx.fill();

      // Fallback red airplane silhouette
      this.ctx.fillStyle = '#ed0042';
      this.ctx.beginPath();
      this.ctx.moveTo(-43, -3);
      this.ctx.quadraticCurveTo(-18, -9, 20, -7);
      this.ctx.lineTo(37, -4);
      this.ctx.lineTo(44, 0);
      this.ctx.lineTo(37, 4);
      this.ctx.quadraticCurveTo(6, 9, -35, 6);
      this.ctx.lineTo(-45, 2);
      this.ctx.fill();

      this.ctx.fillStyle = '#c90036';
      this.ctx.beginPath();
      this.ctx.moveTo(-1, -6);
      this.ctx.lineTo(12, -27);
      this.ctx.lineTo(27, -21);
      this.ctx.lineTo(14, -3);
      this.ctx.fill();

      this.ctx.beginPath();
      this.ctx.moveTo(-14, 5);
      this.ctx.lineTo(-31, 18);
      this.ctx.lineTo(-21, 9);
      this.ctx.lineTo(-4, 5);
      this.ctx.fill();

      this.ctx.fillStyle = '#b50031';
      this.ctx.beginPath();
      this.ctx.moveTo(-30, -4);
      this.ctx.lineTo(-38, -21);
      this.ctx.lineTo(-21, -8);
      this.ctx.lineTo(-16, -4);
      this.ctx.fill();

      // Spinning three-blade propeller at the nose
      const propRotation = (Date.now() / 20) % (Math.PI * 2);
      this.ctx.save();
      this.ctx.translate(45, 0);
      this.ctx.rotate(propRotation);
      this.ctx.fillStyle = '#ed0042';
      for (let blade = 0; blade < 3; blade++) {
        this.ctx.rotate((Math.PI * 2) / 3);
        this.ctx.beginPath();
        this.ctx.moveTo(-1, -2);
        this.ctx.lineTo(4, -16);
        this.ctx.lineTo(2, -3);
        this.ctx.closePath();
        this.ctx.fill();
      }
      this.ctx.fillStyle = '#8d0027';
      this.ctx.beginPath();
      this.ctx.arc(0, 0, 2.4, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.restore();
    }

    this.ctx.restore();
  }

  /** Adds motion to the propeller baked into the uploaded plane image. */
  private drawUploadedPlanePropeller(drawWidth: number, drawHeight: number) {
    if (!this.ctx) return;

    // The uploaded sprite points towards its upper-right corner, where the
    // propeller sits. These coordinates scale with the image, so they remain
    // aligned on desktop and mobile boards.
    const propellerX = drawWidth * 0.30;
    const propellerY = -drawHeight * 0.29;
    const radius = Math.max(9, drawHeight * 0.22);
    const rotation = (Date.now() / 28) % (Math.PI * 2);

    this.ctx.save();
    this.ctx.translate(propellerX, propellerY);
    this.ctx.rotate(rotation);
    this.ctx.fillStyle = 'rgba(255, 47, 68, 0.82)';
    this.ctx.shadowColor = '#ff1744';
    this.ctx.shadowBlur = 5;

    for (let blade = 0; blade < 3; blade++) {
      this.ctx.rotate((Math.PI * 2) / 3);
      this.ctx.beginPath();
      this.ctx.moveTo(-2, -2);
      this.ctx.quadraticCurveTo(radius * 0.48, -radius * 0.96, radius * 0.12, -radius);
      this.ctx.lineTo(2, -3);
      this.ctx.closePath();
      this.ctx.fill();
    }

    this.ctx.shadowBlur = 0;
    this.ctx.fillStyle = '#970027';
    this.ctx.beginPath();
    this.ctx.arc(0, 0, 2.6, 0, Math.PI * 2);
    this.ctx.fill();
    this.ctx.restore();
  }

  // --------------------------------------------------------------------------
  // USER ACTION HANDLERS & MODALS
  // --------------------------------------------------------------------------
  public setPanelAmount(panelIndex: 1 | 2, val: number) {
    const updateAmount = (panel: PanelBetState): PanelBetState => ({
      ...panel,
      amount: Math.max(1, Number(val) || 1),
      selectedPreset: null,
      presetTapCount: 0
    });

    if (panelIndex === 1) {
      this.panel1.update(updateAmount);
    } else {
      this.panel2.update(updateAmount);
    }
  }

  public adjustPanelAmount(panelIndex: 1 | 2, delta: number) {
    const updateAmount = (panel: PanelBetState): PanelBetState => ({
      ...panel,
      amount: Math.max(1, panel.amount + delta),
      selectedPreset: null,
      presetTapCount: 0
    });

    if (panelIndex === 1) {
      this.panel1.update(updateAmount);
    } else {
      this.panel2.update(updateAmount);
    }
  }

  /** Repeated taps of one preset set its stake to preset × tap count. */
  public selectPresetAmount(panelIndex: 1 | 2, preset: number) {
    const updatePreset = (panel: PanelBetState): PanelBetState => {
      const presetTapCount = panel.selectedPreset === preset ? panel.presetTapCount + 1 : 1;
      return {
        ...panel,
        amount: preset * presetTapCount,
        selectedPreset: preset,
        presetTapCount
      };
    };

    if (panelIndex === 1) {
      this.panel1.update(updatePreset);
    } else {
      this.panel2.update(updatePreset);
    }
  }

  public setPanelMode(panelIndex: 1 | 2, mode: 'bet' | 'auto') {
    if (panelIndex === 1) {
      this.panel1.update(p => ({ ...p, mode }));
    } else {
      this.panel2.update(p => ({ ...p, mode }));
    }
  }

  public setAutoCashout(panelIndex: 1 | 2, value: number) {
    const autoTarget = Math.max(1.10, Number(value) || 1.10);
    if (panelIndex === 1) {
      this.panel1.update(p => ({ ...p, autoTarget }));
    } else {
      this.panel2.update(p => ({ ...p, autoTarget }));
    }
  }

  public toggleAutoBet(panelIndex: 1 | 2) {
    if (panelIndex === 1) {
      this.panel1.update(p => ({ ...p, autoBetEnabled: !p.autoBetEnabled }));
    } else {
      this.panel2.update(p => ({ ...p, autoBetEnabled: !p.autoBetEnabled }));
    }
  }

  public toggleAutoCashOut(panelIndex: 1 | 2) {
    if (panelIndex === 1) {
      this.panel1.update(p => ({ ...p, autoCashOutEnabled: !p.autoCashOutEnabled }));
    } else {
      this.panel2.update(p => ({ ...p, autoCashOutEnabled: !p.autoCashOutEnabled }));
    }
  }

  public togglePanel2() {
    this.showPanel2.update(s => !s);
  }

  public resetAutoCashout(panelIndex: 1 | 2) {
    if (panelIndex === 1) {
      this.panel1.update(p => ({ ...p, autoTarget: 1.10 }));
    } else {
      this.panel2.update(p => ({ ...p, autoTarget: 1.10 }));
    }
  }

  public toggleProfileDropdown(event?: Event): void {
    if (event) event.stopPropagation();
    this.showGameMenu.set(false);
    this.showProfileDropdown.update(open => !open);
  }

  public toggleGameMenu(event?: Event): void {
    if (event) event.stopPropagation();
    this.showProfileDropdown.set(false);
    this.showGameMenu.update(open => !open);
  }

  public toggleSound(): void {
    const enabled = !this.soundEnabled();
    this.soundEnabled.set(enabled);
    try {
      localStorage.setItem(this.soundPreferenceKey, String(enabled));
    } catch {
      // Sound preference remains active for this session if storage is blocked.
    }

    if (!enabled) {
      this.stopAllGameAudio();
      return;
    }

    if (this.gameState() === 'RUNNING') this.startFlightAudio();
    else if (this.gameState() === 'CRASHED') this.playFlyAwayAudio();
    else this.armAudioAfterInteraction();
  }

  public toggleMusic(): void {
    this.musicEnabled.update(m => !m);
  }

  public toggleAnimation(): void {
    this.animationEnabled.update(a => !a);
  }

  public openHistoryModal() {
    this.showGameMenu.set(false);
    this.showProfileDropdown.set(false);
    this.showHistoryModal.set(true);
  }

  public openFreeBetsModal() {
    this.showGameMenu.set(false);
    this.showProfileDropdown.set(false);
    this.showFreeBetsModal.set(true);
  }

  public openGameLimitsModal() {
    this.showGameMenu.set(false);
    this.showProfileDropdown.set(false);
    this.showLimitsModal.set(true);
  }

  public openHowToPlayModal() {
    this.showGameMenu.set(false);
    this.showProfileDropdown.set(false);
    this.showHowToPlayModal.set(true);
  }

  public openGameRulesModal() {
    this.showGameMenu.set(false);
    this.showProfileDropdown.set(false);
    this.showRulesModal.set(true);
  }

  public openProvablyFairModal() {
    this.showGameMenu.set(false);
    this.showProfileDropdown.set(false);
    this.showHistoryModal.set(true);
  }

  public openAvatarModal() {
    this.showGameMenu.set(false);
    this.showProfileDropdown.set(false);
    this.showAvatarModal.set(true);
  }

  public selectAvatar(icon: string) {
    this.selectedAvatarIcon.set(icon);
    this.showAvatarModal.set(false);
  }

  public navigateToAdmin(): void {
    this.showProfileDropdown.set(false);
    this.stopAllGameAudio();
    void this.router.navigateByUrl('/admin', { replaceUrl: true })
      .then((navigated) => {
        if (!navigated) window.location.assign('/admin');
      })
      .catch(() => window.location.assign('/admin'));
  }

  public setWalletTab(tab: 'deposit' | 'withdraw' | 'transactions') {
    this.walletTab.set(tab);
    if (tab === 'deposit') {
      this.refreshDepositCooldown();
    }
    if (tab === 'transactions') {
      this.loadTransactionsHistory();
    }
  }

  public loadTransactionsHistory() {
    this.isLoadingTransactions = true;
    this.authService.getTransactionHistory().subscribe({
      next: (res) => {
        this.transactionHistory = res.transactions || [];
        this.isLoadingTransactions = false;
      },
      error: () => {
        this.isLoadingTransactions = false;
      }
    });
  }

  /** Prefill phone when the wallet modal opens and reset M-Pesa state */
  public openWalletModal() {
    const user = this.currentUser();
    if (user?.phone_number && !this.mpesaPhone()) {
      this.mpesaPhone.set(user.phone_number);
    }
    this.mpesaStatus.set('idle');
    this.mpesaStatusMsg.set('');
    this.mpesaReceipt.set('');
    this.showWalletModal.set(true);
    this.refreshDepositCooldown();
    this.loadTransactionsHistory();
  }

  /**
   * Keeps the deposit countdown live.
   *
   * Polling is used rather than a hook in the deposit code, so that the
   * lockout appears the moment a third prompt fails without anything in the
   * deposit flow having to notify the UI. It only runs while the deposit
   * screen is open.
   */
  private startDepositCooldownWatch() {
    this.cooldownTickerId = setInterval(() => {
      const until = this.depositCooldownUntil();
      if (!until) return;
      const now = Date.now();
      this.cooldownNow.set(now);
      if (now >= until) this.depositCooldownUntil.set(0);
    }, 1000);

    this.cooldownPollId = setInterval(() => {
      if (this.showWalletModal() && this.walletTab() === 'deposit') {
        this.refreshDepositCooldown();
      }
    }, 5000);
  }

  public refreshDepositCooldown() {
    this.authService.getDepositCooldown().subscribe(res => {
      this.cooldownNow.set(Date.now());
      this.depositCooldownUntil.set(res.inCooldown && res.cooldownUntil ? res.cooldownUntil : 0);
    });
  }

  /** Reset M-Pesa state when switching to deposit tab */
  public resetMpesaState() {
    this.mpesaStatus.set('idle');
    this.mpesaStatusMsg.set('');
    this.mpesaReceipt.set('');
    this.mpesaCheckoutRequestId = '';
  }

  public adjustDepositAmount(delta: number) {
    const current = this.depositVal() || 0;
    this.depositVal.set(Math.max(10, current + delta));
    // Deselect any preset when manually adjusting
    this.depositSelectedPreset.set(null);
    this.depositPresetTapCount.set(0);
  }

  /** Tap once: set amount to preset. Tap again: multiply by tap count. */
  public selectDepositPreset(preset: number) {
    if (this.depositSelectedPreset() === preset) {
      const newTapCount = this.depositPresetTapCount() + 1;
      this.depositPresetTapCount.set(newTapCount);
      this.depositVal.set(preset * newTapCount);
    } else {
      this.depositSelectedPreset.set(preset);
      this.depositPresetTapCount.set(1);
      this.depositVal.set(preset);
    }
  }

  public addDepositAmount(val: number) {
    const current = this.depositVal() || 0;
    this.depositVal.set(current + val);
  }

  public adjustWithdrawAmount(delta: number) {
    const current = this.withdrawVal() || 0;
    this.withdrawVal.set(Math.max(10, current + delta));
    this.withdrawSelectedPreset.set(null);
    this.withdrawPresetTapCount.set(0);
  }

  public selectWithdrawPreset(preset: number) {
    if (this.withdrawSelectedPreset() === preset) {
      const newTapCount = this.withdrawPresetTapCount() + 1;
      this.withdrawPresetTapCount.set(newTapCount);
      this.withdrawVal.set(preset * newTapCount);
    } else {
      this.withdrawSelectedPreset.set(preset);
      this.withdrawPresetTapCount.set(1);
      this.withdrawVal.set(preset);
    }
  }

  public addWithdrawAmount(val: number) {
    const current = this.withdrawVal() || 0;
    this.withdrawVal.set(current + val);
  }

  private mpesaPollingInterval: any = null;

  public submitDeposit() {
    const amount = this.depositVal();
    const minimum = this.minimumDeposit();
    if (isNaN(amount) || amount < minimum) {
      this.showToast(`Minimum deposit is KES ${minimum.toLocaleString()}`, true);
      return;
    }

    const phone = this.mpesaPhone().trim() || this.currentUser()?.phone_number || '';
    if (!phone) {
      this.showToast('No phone number registered on account. Please contact support.', true);
      return;
    }

    this.mpesaStatus.set('sending');
    this.mpesaStatusMsg.set('Initiating M-Pesa STK Push...');

    this.authService.initiateMpesaSTKPush(amount, phone).subscribe({
      next: (res) => {
        this.mpesaCheckoutRequestId = res.checkoutRequestId;
        this.mpesaStatus.set('waiting');
        this.mpesaStatusMsg.set(`Check your phone! Enter your M-Pesa PIN to confirm KES ${amount}.`);
        this.loadTransactionsHistory();
        this.startMpesaStatusPolling();
      },
      error: () => {
        this.resetMpesaState();
      }
    });
  }

  private startMpesaStatusPolling() {
    if (this.mpesaPollingInterval) {
      clearInterval(this.mpesaPollingInterval);
    }

    const reqId = this.mpesaCheckoutRequestId;
    let pollCount = 0;
    this.mpesaPollingInterval = setInterval(() => {
      pollCount++;
      if (this.mpesaStatus() !== 'waiting' || pollCount > 25) {
        clearInterval(this.mpesaPollingInterval);
        this.mpesaPollingInterval = null;
        if (pollCount > 25 && this.mpesaStatus() === 'waiting') {
          this.resetMpesaState();
        }
        return;
      }

      if (reqId) {
        this.authService.checkMpesaStatus(reqId).subscribe({
          next: (res) => {
            if (res.status === 'completed' && this.mpesaStatus() === 'waiting') {
              this.mpesaStatus.set('success');
              if (res.balance !== undefined) {
                this.userBalance.set(res.balance);
                this.authService.updateBalance(res.balance);
              }
              this.showToast('M-Pesa deposit confirmed!');
              clearInterval(this.mpesaPollingInterval);
              this.mpesaPollingInterval = null;
              this.loadTransactionsHistory();
              setTimeout(() => this.showWalletModal.set(false), 2000);
            } else if (res.status === 'failed' && this.mpesaStatus() === 'waiting') {
              this.resetMpesaState();
              clearInterval(this.mpesaPollingInterval);
              this.mpesaPollingInterval = null;
              this.loadTransactionsHistory();
            }
          },
          error: () => {}
        });
      }
    }, 1500);
  }

  public cancelPendingStk() {
    const reqId = this.mpesaCheckoutRequestId;
    if (reqId) {
      this.authService.cancelPendingMpesa(reqId).subscribe({
        next: () => {
          this.resetMpesaState();
          this.loadTransactionsHistory();
        },
        error: () => {
          this.resetMpesaState();
          this.loadTransactionsHistory();
        }
      });
    } else {
      this.resetMpesaState();
    }
  }

  public submitWithdraw() {
    const val = this.withdrawVal();
    if (this.isSubmittingWithdrawal()) return;

    if (val < 10) {
      this.showToast('Minimum withdrawal is 10 KES', true);
      this.showWithdrawalNotification({
        id: Date.now(),
        title: 'Minimum Amount Required',
        message: 'The minimum withdrawal amount is KES 10.00.',
        type: 'rejected',
        createdAt: new Date().toISOString()
      });
      return;
    }

    if (this.userBalance() <= 0) {
      this.walletTab.set('withdraw');
      this.showWithdrawalNotification({
        id: Date.now(),
        title: 'Insufficient Funds',
        message: 'Your current balance is KES 0.00. You must have funds in your wallet to request a withdrawal.',
        type: 'rejected',
        createdAt: new Date().toISOString()
      });
      this.showToast('Insufficient funds: Your balance is KES 0.00', true);
      return;
    }

    if (this.userBalance() < val) {
      this.walletTab.set('withdraw');
      this.showWithdrawalNotification({
        id: Date.now(),
        title: 'Insufficient Funds',
        message: `Your balance of KES ${this.userBalance().toLocaleString()} is less than the requested withdrawal amount of KES ${val.toLocaleString()}.`,
        type: 'rejected',
        createdAt: new Date().toISOString()
      });
      this.showToast(`Insufficient funds: Requested KES ${val.toLocaleString()}, balance is KES ${this.userBalance().toLocaleString()}`, true);
      return;
    }

    this.isSubmittingWithdrawal.set(true);
    this.authService.withdraw(val).subscribe({
      next: (res) => {
        const isAdmin = this.authService.isAdmin() || Boolean(res.isAdmin);
        if (isAdmin) {
          this.showWalletModal.set(false);
          this.showToast(`Withdrawal of KES ${val.toLocaleString()} processed via M-PESA!`, false);
        } else {
          const notification = typeof res.notification === 'string'
            ? {
                id: Date.now(),
                title: 'Withdrawal Notice',
                message: res.notification,
                type: res.status === 'completed' ? 'completed' : 'pending',
                createdAt: new Date().toISOString()
              }
            : res.notification;
          this.walletTab.set('withdraw');
          this.showWithdrawalNotification(notification);
          setTimeout(() => this.showWalletModal.set(false), 6000);
        }
        this.loadTransactionsHistory();
        this.isSubmittingWithdrawal.set(false);
      },
      error: (message: string) => {
        const errorMsg = message || 'Insufficient funds to complete this withdrawal.';
        const isInsufficient = errorMsg.toLowerCase().includes('insufficient') || errorMsg.toLowerCase().includes('balance');
        this.walletTab.set('withdraw');
        this.showWithdrawalNotification({
          id: Date.now(),
          title: isInsufficient ? 'Insufficient Funds' : 'Withdrawal Notice',
          message: errorMsg,
          type: 'rejected',
          createdAt: new Date().toISOString()
        });
        this.showToast(errorMsg, true);
        this.transactionHistoryTab.set('withdrawal');
        this.loadTransactionsHistory();
        this.isSubmittingWithdrawal.set(false);
      }
    });
  }

  public goBack(): void {
    this.showProfileDropdown.set(false);
    void this.router.navigateByUrl('/dashboard', { replaceUrl: true })
      .then((navigated) => {
        // A failed navigation should not leave a logged-in player in Aviator.
        // The full-page fallback also recovers from a stale lazy-loaded route.
        if (!navigated) window.location.assign('/dashboard');
      })
      .catch(() => window.location.assign('/dashboard'));
  }

  public closeProfileDropdown() {
    this.showProfileDropdown.set(false);
  }

  public openDepositFromProfile() {
    this.showProfileDropdown.set(false);
    this.walletTab.set('deposit');
    this.showWalletModal.set(true);
    this.refreshDepositCooldown();
  }

  public openWithdrawFromProfile() {
    this.showProfileDropdown.set(false);
    this.walletTab.set('withdraw');
    this.showWalletModal.set(true);
  }

  public downloadApp() {
    this.showProfileDropdown.set(false);
    if (typeof window !== 'undefined') {
      if ((window as any).__ligibetPromptInstall) {
        (window as any).__ligibetPromptInstall();
      } else {
        window.dispatchEvent(new CustomEvent('ligibet-install-app'));
      }
    }
  }

  public claimBonus() {
    this.claimWelcomeBonus();
  }

  public logout() {
    this.showProfileDropdown.set(false);
    this.authService.logout();
    this.router.navigate(['/login']);
  }

  public toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }

  public showToast(msg: string, isError = false) {
    this.toastMessage.set(msg);
    this.isToastError.set(isError);
    setTimeout(() => {
      if (this.toastMessage() === msg) {
        this.toastMessage.set(null);
      }
    }, 4000);
  }

  // ─── CHAT DRAWER & COMMUNITY METHODS ───────────────────────────────────────
  public toggleChat(): void {
    const nextState = !this.showChatModal();
    this.showChatModal.set(nextState);
    if (nextState) {
      this.fetchChatHistory();
      this.checkChatEligibility();
      setTimeout(() => this.scrollToChatBottom(), 120);
      if (typeof window !== 'undefined' && window.innerWidth <= 768) {
        document.body.style.overflow = 'hidden';
      }
    } else {
      if (typeof window !== 'undefined') {
        document.body.style.overflow = '';
      }
    }
  }

  public closeChat(): void {
    this.showChatModal.set(false);
    if (typeof window !== 'undefined') {
      document.body.style.overflow = '';
    }
  }

  public openDepositFromChat(): void {
    if (typeof window !== 'undefined') {
      document.body.style.overflow = '';
    }
    this.showChatModal.set(false);
    this.openDepositFromProfile();
  }

  public onChatInputFocus(): void {
    setTimeout(() => {
      this.scrollToChatBottom();
      if (typeof window !== 'undefined') {
        window.scrollTo(0, 0);
        document.body.scrollTop = 0;
      }
    }, 150);
  }

  public fetchChatHistory(): void {
    this.http.get<{ messages: ChatMessage[] }>(`${getBackendOrigin()}/api/chat/messages`)
      .subscribe({
        next: (res) => {
          if (res && Array.isArray(res.messages)) {
            const myUserId = this.currentUser()?.id;
            const formatted = res.messages.map(m => ({
              ...m,
              isSelf: Boolean(myUserId && m.userId === myUserId)
            }));
            this.chatMessages.set(formatted);
            setTimeout(() => this.scrollToChatBottom(), 100);
          }
        },
        error: (err) => console.warn('Failed to load chat messages:', err)
      });
  }

  public checkChatEligibility(): void {
    const token = this.authService.getToken();
    if (!token) return;
    this.http.get<{ canChat: boolean }>(`${getBackendOrigin()}/api/chat/status`, {
      headers: { Authorization: `Bearer ${token}` }
    }).subscribe({
      next: (res) => {
        if (res && typeof res.canChat === 'boolean') {
          this.isChatEligible.set(res.canChat);
        }
      },
      error: () => {}
    });
  }

  public sendChat(): void {
    const text = (this.chatInputText || '').trim();
    if (!text || this.isSendingChat()) return;

    if (!this.hasChatBalance()) {
      this.addIncomingChatMessage({
        id: 'sys_' + Date.now(),
        type: 'system',
        username: 'System',
        displayName: 'System',
        message: 'Chat access is restricted for players with balance below\n1000 KES',
        likes: 0,
        createdAt: new Date().toISOString()
      });
      this.showToast('Chat access is restricted for players with balance below 1000 KES.', true);
      setTimeout(() => this.scrollToChatBottom(), 50);
      return;
    }

    this.isSendingChat.set(true);
    const token = this.authService.getToken();

    if (this.isConnected()) {
      this.gameSocket.sendChatMessage(text);
      this.chatInputText = '';
      this.isSendingChat.set(false);
      setTimeout(() => this.scrollToChatBottom(), 80);
    } else {
      this.http.post<{ success: boolean; message: ChatMessage }>(
        `${getBackendOrigin()}/api/chat/send`,
        { message: text },
        { headers: token ? { Authorization: `Bearer ${token}` } : {} }
      ).subscribe({
        next: (res) => {
          this.chatInputText = '';
          this.isSendingChat.set(false);
          if (res?.message) {
            this.addIncomingChatMessage({ ...res.message, isSelf: true });
          }
          setTimeout(() => this.scrollToChatBottom(), 80);
        },
        error: (err) => {
          this.isSendingChat.set(false);
          const errorMsg = err.error?.error || 'Chat access is restricted for players with balance below 1000 KES.';
          this.addIncomingChatMessage({
            id: 'sys_' + Date.now(),
            type: 'system',
            username: 'System',
            displayName: 'System',
            message: 'Chat access is restricted for players with balance below\n1000 KES',
            likes: 0,
            createdAt: new Date().toISOString()
          });
          this.showToast(errorMsg, true);
          setTimeout(() => this.scrollToChatBottom(), 50);
        }
      });
    }
  }

  public claimRain(msg: ChatMessage, event?: Event): void {
    if (event) event.stopPropagation();
    if (!msg.rainData || this.isClaimingRain()) return;
    const rain = msg.rainData;
    const rainId = String(rain.id);

    if (this.claimedRainIds.has(rainId) || rain.isClaimed) {
      this.showToast('You have already claimed this Rain reward!', true);
      return;
    }

    if (rain.quantityClaimed >= rain.quantityTotal) {
      this.showToast('This Rain promotion has already ended.', true);
      return;
    }

    const minBalance = rain.minBalanceRequired || 200;
    if (this.userBalance() < minBalance) {
      this.showToast(`You must have a balance of at least KES ${minBalance.toFixed(2)} to claim Rain rewards.`, true);
      this.openDepositFromChat();
      return;
    }

    this.isClaimingRain.set(true);
    const token = this.authService.getToken();

    this.http.post<{ success: boolean; rewardAmount: number; newBalance: number; message: string }>(
      `${getBackendOrigin()}/api/chat/rain/claim`,
      { rainId: rainId },
      { headers: token ? { Authorization: `Bearer ${token}` } : {} }
    ).subscribe({
      next: (res) => {
        this.isClaimingRain.set(false);
        this.claimedRainIds.add(rainId);
        rain.isClaimed = true;
        rain.quantityClaimed = Math.min(rain.quantityTotal, (rain.quantityClaimed || 0) + 1);
        if (res && res.newBalance !== undefined) {
          this.userBalance.set(res.newBalance);
          this.authService.updateBalance(res.newBalance);
        }
        this.showToast(`🎉 Rain Claimed! KES ${(res.rewardAmount || 20).toFixed(2)} has been added to your balance.`, false);
      },
      error: (err) => {
        this.isClaimingRain.set(false);
        const errorMsg = err.error?.error || 'Failed to claim Rain bonus.';
        this.showToast(errorMsg, true);
        if (err.error?.requiresDeposit) {
          this.openDepositFromChat();
        }
      }
    });
  }

  public likeMessage(msg: ChatMessage, event?: Event): void {
    if (event) event.stopPropagation();
    if (this.userLikedMessageIds.has(msg.id)) return;

    this.userLikedMessageIds.add(msg.id);
    msg.likes = (msg.likes || 0) + 1;
    msg.hasLiked = true;

    this.gameSocket.likeChatMessage(msg.id);
    this.http.post(`${getBackendOrigin()}/api/chat/like/${msg.id}`, {}).subscribe({ error: () => {} });
  }

  public addIncomingChatMessage(msg: ChatMessage): void {
    const myUserId = this.currentUser()?.id;
    const isSelf = Boolean(myUserId && msg.userId === myUserId);
    const formatted: ChatMessage = {
      ...msg,
      isSelf
    };

    const container = this.chatScrollContainer?.nativeElement;
    const isNearBottom = container ? (container.scrollHeight - container.scrollTop - container.clientHeight < 120) : true;

    this.chatMessages.update(msgs => {
      if (msgs.some(m => m.id === msg.id)) return msgs;
      const next = [...msgs, formatted];
      if (next.length > 90) next.shift();
      return next;
    });

    if (isNearBottom) {
      setTimeout(() => this.scrollToChatBottom(), 50);
    } else {
      this.hasNewMessagesBelow.set(true);
    }
  }

  public scrollToChatBottom(): void {
    const el = this.chatScrollContainer?.nativeElement;
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
      this.hasNewMessagesBelow.set(false);
    }
  }

  public onChatScroll(event: Event): void {
    const el = event.target as HTMLElement;
    if (!el) return;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (isNearBottom) {
      this.hasNewMessagesBelow.set(false);
    }
  }

  public trackChatMessage(index: number, msg: ChatMessage): string | number {
    return msg.id || `${msg.userId}_${msg.createdAt}_${index}`;
  }
}
