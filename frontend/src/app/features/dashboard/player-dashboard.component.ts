import { CommonModule } from '@angular/common';
import { Component, HostListener, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { AuthService, User } from '../../core/services/auth.service';
import { FootballMatch, MatchOutcome, SportsMarketService } from '../../core/services/sports-market.service';

interface BetSlipSelection {
  matchId: string;
  matchLabel: string;
  outcome: MatchOutcome;
  outcomeLabel: string;
  odds: number;
}

@Component({
  selector: 'app-player-dashboard',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './player-dashboard.component.html',
  styleUrl: './player-dashboard.component.css'
})
export class PlayerDashboardComponent implements OnInit, OnDestroy {
  private readonly authService = inject(AuthService);
  private readonly router = inject(Router);
  readonly sports = inject(SportsMarketService);
  private readonly subscriptions: Subscription[] = [];

  readonly currentUser = signal<User | null>(null);
  readonly userBalance = signal(0);
  readonly activeFilter = signal<'all' | 'live' | 'upcoming'>('all');
  readonly activeNavTab = signal<string>('home');
  readonly selectedSport = signal<string>('soccer');
  readonly betslipTab = signal<'normal' | 'shikisha' | 'virtuals'>('normal');
  readonly selections = signal<BetSlipSelection[]>([]);
  readonly showProfileMenu = signal(false);
  readonly showDepositModal = signal(false);
  readonly showMobileSlipDrawer = signal(false);
  readonly mobileMenuOpen = signal(false);
  readonly dataSaverEnabled = signal(false);
  readonly betNotice = signal<string | null>(null);
  readonly depositNotice = signal<string | null>(null);
  readonly isDepositing = signal(false);
  readonly minimumDeposit = signal(999);

  stake = 20;
  depositAmount = 999;
  depositPhone = '';
  betslipCode = '';

  // Withdrawal, account settings and in-page toast state
  readonly showWithdrawModal = signal(false);
  readonly isWithdrawing = signal(false);
  readonly withdrawNotice = signal<string | null>(null);
  readonly withdrawalPopup = signal<{ title: string; message: string; type: string } | null>(null);
  readonly showAccountModal = signal(false);
  readonly isSavingAccount = signal(false);
  readonly accountNotice = signal<string | null>(null);
  readonly accountError = signal<string | null>(null);
  readonly toastMessage = signal<string | null>(null);
  withdrawAmount = 100;
  newUsername = '';
  currentPassword = '';
  accountNewPassword = '';

  readonly isPrivileged = computed(() => {
    const role = this.currentUser()?.role;
    return role === 'admin' || role === 'superadmin';
  });

  toggleMobileSlipDrawer(): void {
    this.showMobileSlipDrawer.update(val => !val);
  }

  toggleMobileMenu(): void {
    this.showProfileMenu.set(false);
    this.mobileMenuOpen.update(open => !open);
  }

  closeMobileMenu(): void {
    this.mobileMenuOpen.set(false);
  }

  toggleDataSaver(): void {
    const enabled = !this.dataSaverEnabled();
    this.dataSaverEnabled.set(enabled);
    if (enabled) this.sports.stop();
    else this.sports.start();
  }

  readonly aviatorMultipliers = signal<number[]>([
    1.17, 2.98, 1.28, 3.03, 1.57, 1.46, 2.13, 1.72, 2.93, 19.26, 6.17, 2.43, 5.66
  ]);

  // ---- Real photography slots -------------------------------------------
  /**
   * Wide promo banner. Drop a real image at assets/banners/hero.jpg (roughly
   * 1400x260) and it takes over the hero; if the file is absent the designed
   * gradient banner shows instead, so this is safe to leave empty.
   */
  readonly heroBanners = [
    {
      id: 'kings-move',
      image: 'assets/banners/banner-kings-move.jpg',
      headline: 'Arm wrestle your way to',
      prize: 'KSH 1,000,000',
      prizeSuffix: 'every game!',
      cta: 'Play Now',
      tag: 'ligibet.it.com 18+',
      gameId: 'kings-move',
      art: 'assets/games/photos/kings-move.jpg'
    },
    {
      id: 'aviator',
      image: 'assets/banners/banner-aviator.jpg',
      headline: 'Fly High to the Moon!',
      prize: 'KSH 2,000,000',
      prizeSuffix: 'Max Win',
      cta: 'Play Aviator',
      tag: 'Provably Fair 18+',
      gameId: 'aviator',
      art: 'assets/images/aviator-dashboard-logo.png'
    },
    {
      id: 'jackpot',
      image: 'assets/banners/banner-jackpot.jpg',
      headline: 'Weekend Football Mega Jackpot',
      prize: 'KSH 50,000,000',
      prizeSuffix: 'Pick 17 Games',
      cta: 'Bet with KSH 20',
      tag: 'Big Win 18+',
      gameId: 'sports',
      art: 'assets/games/photos/instant-virtuals.jpg'
    },
    {
      id: 'bonus',
      image: 'assets/banners/banner-bonus.jpg',
      headline: 'Double Your Starting Power!',
      prize: '100% BONUS',
      prizeSuffix: '+ Free Flights',
      cta: 'Claim Bonus',
      tag: 'New Players 18+',
      gameId: 'deposit',
      art: 'assets/games/photos/comet-crash.jpg'
    }
  ];

  readonly currentBannerIndex = signal(0);
  private bannerTimer: any = null;
  readonly isBannerPaused = signal(false);

  /**
   * Game ids with realistic 3D photographs at assets/games/photos/<id>.jpg.
   * Aviator retains its classic original image.
   */
  readonly photoTiles: string[] = [
    'kings-move',
    'ligihero',
    'jetx',
    'ligiviator',
    'comet-crash',
    'instant-virtuals',
    'liginare',
    'aviatrix'
  ];

  /** Photo if one has been supplied for this tile, otherwise the vector art. */
  tileImage(tile: { id: string; img: string }): string {
    if (tile.id === 'aviator') {
      return 'assets/images/aviator-dashboard-logo.png';
    }
    return this.photoTiles.includes(tile.id) ? `assets/games/photos/${tile.id}.jpg` : tile.img;
  }

  nextBanner(): void {
    this.currentBannerIndex.update(idx => (idx + 1) % this.heroBanners.length);
  }

  prevBanner(): void {
    this.currentBannerIndex.update(idx => (idx - 1 + this.heroBanners.length) % this.heroBanners.length);
  }

  setBanner(index: number): void {
    this.currentBannerIndex.set(index);
  }

  pauseBanner(): void {
    this.isBannerPaused.set(true);
    if (this.bannerTimer) {
      clearInterval(this.bannerTimer);
      this.bannerTimer = null;
    }
  }

  resumeBanner(): void {
    this.isBannerPaused.set(false);
    this.startBannerAutoPlay();
  }

  startBannerAutoPlay(): void {
    if (this.bannerTimer) clearInterval(this.bannerTimer);
    this.bannerTimer = setInterval(() => {
      if (!this.isBannerPaused()) {
        this.nextBanner();
      }
    }, 4500);
  }

  stopBannerAutoPlay(): void {
    if (this.bannerTimer) {
      clearInterval(this.bannerTimer);
      this.bannerTimer = null;
    }
  }

  // ---- Landing page furniture -------------------------------------------
  readonly activeGameCategory = signal<string>('crash');
  readonly activeGameTab = signal<string>('crash');

  readonly primaryNav = [
    { id: 'sports', label: 'Sports Betting' },
    { id: 'live', label: 'Live Betting' },
    { id: 'ligileague', label: 'LigiLeague' },
    { id: 'casino', label: 'Casino' },
    { id: 'prediction', label: 'Prediction Market' },
    { id: 'jackpots', label: 'Jackpots' },
    { id: 'livescore', label: 'Livescore' },
    { id: 'promotions', label: 'Promotions' }
  ];

  readonly navRail = [
    { id: 'home', label: 'Home', icon: 'assets/icons/home.svg', badge: '' },
    { id: 'live', label: 'LigiLIVE', icon: 'assets/icons/live.svg', badge: '68' },
    { id: 'soccer', label: 'Soccer', icon: 'assets/icons/soccer.svg', badge: '' },
    { id: 'ligileague', label: 'LigiLeague', icon: 'assets/icons/league.svg', badge: '' },
    { id: 'aviator', label: 'Aviator', icon: 'assets/images/aviator-dashboard-logo.png', badge: '' },
    { id: 'ligipoly', label: 'LigiPoly', icon: 'assets/icons/poly.svg', badge: '' },
    { id: 'virtuals', label: 'Virtuals', icon: 'assets/icons/virtuals.svg', badge: 'NEW' },
    { id: 'games', label: 'Games', icon: 'assets/icons/games.svg', badge: '' },
    { id: 'crash', label: 'Crash', icon: 'assets/icons/crash.svg', badge: 'NEW' },
    { id: 'casino', label: 'Casino', icon: 'assets/icons/casino.svg', badge: '' },
    { id: 'promos', label: 'Promos', icon: 'assets/icons/promos.svg', badge: '6' },
    { id: 'liginare', label: 'LigiNare', icon: 'assets/icons/nare.svg', badge: '' },
    { id: 'evolution', label: 'Evolution', icon: 'assets/icons/evolution.svg', badge: 'NEW' },
    { id: 'ligiturbo', label: 'LigiTurbo', icon: 'assets/icons/turbo.svg', badge: 'NEW' },
    { id: 'slots', label: 'Slots', icon: 'assets/icons/slots.svg', badge: '' },
    { id: 'esoccer', label: 'eSoccer', icon: 'assets/icons/esoccer.svg', badge: '' },
    { id: 'basketball', label: 'Basketball', icon: 'assets/icons/basketball.svg', badge: '' }
  ];

  readonly sideTiles = [
    { id: 'instant-virtuals', name: 'Instant Virtuals', img: 'assets/games/instant-virtuals.svg' },
    { id: 'aviator', name: 'Aviator', img: 'assets/images/aviator-dashboard-logo.png' },
    { id: 'aviatrix', name: 'Aviatrix', img: 'assets/games/aviatrix.svg' },
    { id: 'comet-crash', name: 'Comet Crash', img: 'assets/games/comet-crash.svg' },
    { id: 'liginare', name: 'LigiNare', img: 'assets/games/liginare.svg' },
    { id: 'jetx', name: 'JetX', img: 'assets/games/jetx.svg' }
  ];

  readonly gameTiles = [
    { id: 'aviator', name: 'Aviator', img: 'assets/images/aviator-dashboard-logo.png' },
    { id: 'ligihero', name: 'LigiHero', img: 'assets/games/ligihero.svg' },
    { id: 'kings-move', name: "King's Move", img: 'assets/games/kings-move.svg' },
    { id: 'jetx', name: 'JetX', img: 'assets/games/jetx.svg' },
    { id: 'ligiviator', name: 'Ligiviator', img: 'assets/games/ligiviator.svg' },
    { id: 'comet-crash', name: 'Comet Crash', img: 'assets/games/comet-crash.svg' }
  ];

  readonly gameTabs = [
    { id: 'crash', label: 'Crash', flame: true },
    { id: 'betbuilder', label: 'BetBuilder', flame: false },
    { id: 'ligileague', label: 'LigiLeague', flame: false },
    { id: 'ligipoly', label: 'LigiPoly', flame: false }
  ];

  readonly gameCategories = [
    { id: 'crash', label: 'Crash', count: 160 },
    { id: 'slots', label: 'Slots', count: 1536 },
    { id: 'exclusive', label: 'Ligi Exclusive', count: 24 },
    { id: 'virtuals', label: 'Virtuals', count: 25 },
    { id: 'wheel', label: 'Wheel Games', count: 31 },
    { id: 'dice', label: 'Dice', count: 66 },
    { id: 'high-stakes', label: 'High Stakes', count: 18 }
  ];

  readonly topLeagues = [
    { name: 'UEFA Champions League', region: 'Internationals', count: 18 },
    { name: 'UEFA Europa League', region: 'Internationals', count: 18 },
    { name: 'Premier League', region: 'England', count: 20 },
    { name: 'LaLiga', region: 'Spain Amateur', count: 21 },
    { name: 'EFL Cup', region: 'England', count: 16 },
    { name: 'Serie A', region: 'Italy', count: 20 }
  ];

  readonly quickLinks = [
    { id: 'inplay', label: 'Live Inplay', count: 68, icon: 'assets/icons/live.svg' },
    { id: 'soccer', label: 'Soccer', count: 179, icon: 'assets/icons/soccer.svg' },
    { id: 'premier', label: 'Premier League', count: 20, icon: 'assets/icons/league.svg' },
    { id: 'laliga', label: 'LaLiga', count: 21, icon: 'assets/icons/league.svg' },
    { id: 'seriea', label: 'Serie A', count: 20, icon: 'assets/icons/league.svg' },
    { id: 'esoccer', label: 'eSoccer', count: 28, icon: 'assets/icons/esoccer.svg' }
  ];

  goToLogin(): void {
    this.closeMobileMenu();
    this.router.navigate(['/login']);
  }

  setGameCategory(id: string): void {
    this.activeGameCategory.set(id);
  }

  setGameTab(id: string): void {
    this.activeGameTab.set(id);
  }

  /** Every crash-style tile runs on the existing Aviator engine. */
  /**
   * Only the Aviator tile leaves this page. Everything else announces itself in
   * place — sending every game to the Aviator engine made the whole grid look
   * broken, because each tile did the same thing.
   */
  openGame(id: string): void {
    this.closeAllDrawers();
    if (id === 'aviator') {
      this.goToAviator();
      return;
    }
    const known = [...this.gameTiles, ...this.sideTiles].find(tile => tile.id === id);
    this.showToast(`${known?.name || 'This game'} is coming soon.`);
  }

  private toastTimer: any = null;

  showToast(message: string): void {
    this.toastMessage.set(message);
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toastMessage.set(null), 2600);
  }

  dismissToast(): void {
    this.toastMessage.set(null);
  }

  /** Shuts every mobile overlay — the drawers previously had no way out. */
  closeAllDrawers(): void {
    this.mobileMenuOpen.set(false);
    this.showMobileSlipDrawer.set(false);
    this.showProfileMenu.set(false);
  }

  // ---- Withdrawal --------------------------------------------------------
  openWithdraw(): void {
    this.closeAllDrawers();
    this.withdrawNotice.set(null);
    this.withdrawAmount = 100;
    this.showWithdrawModal.set(true);
  }

  submitWithdraw(): void {
    const amount = Number(this.withdrawAmount);
    if (!Number.isFinite(amount) || amount < 10) {
      this.withdrawNotice.set('Enter a withdrawal amount of at least KES 10.');
      return;
    }
    this.isWithdrawing.set(true);
    this.withdrawNotice.set(null);

    this.authService.withdraw(amount).subscribe({
      next: (res) => {
        this.isWithdrawing.set(false);
        this.showWithdrawModal.set(false);
        const notification = typeof res.notification === 'string'
          ? { title: 'Withdrawal Notice', message: res.notification, type: (res.status === 'completed' ? 'completed' : 'pending') }
          : { title: res.notification.title, message: res.notification.message, type: res.notification.type };
        this.withdrawalPopup.set(notification);
      },
      error: (message: string) => {
        this.isWithdrawing.set(false);
        const text = message || 'Withdrawal could not be completed.';
        const insufficient = /insufficient|balance/i.test(text);
        this.showWithdrawModal.set(false);
        this.withdrawalPopup.set({
          title: insufficient ? 'Insufficient Funds' : 'Withdrawal Notice',
          message: text,
          type: 'rejected'
        });
      }
    });
  }

  closeWithdrawalPopup(): void {
    this.withdrawalPopup.set(null);
  }

  // ---- Account settings --------------------------------------------------
  openAccountSettings(): void {
    this.closeAllDrawers();
    this.accountNotice.set(null);
    this.accountError.set(null);
    this.newUsername = this.currentUser()?.username || '';
    this.currentPassword = '';
    this.accountNewPassword = '';
    this.showAccountModal.set(true);
  }

  saveUsername(): void {
    const name = (this.newUsername || '').trim();
    if (name.length < 3) {
      this.accountError.set('Username must be at least 3 characters.');
      return;
    }
    this.accountError.set(null);
    this.isSavingAccount.set(true);
    this.authService.changeUsername(name).subscribe({
      next: (res) => {
        this.isSavingAccount.set(false);
        this.accountNotice.set(res.message || 'Username updated.');
      },
      error: (message: string) => {
        this.isSavingAccount.set(false);
        this.accountError.set(message || 'Could not update username.');
      }
    });
  }

  saveAccountPassword(): void {
    if (!this.currentPassword || this.accountNewPassword.length < 6) {
      this.accountError.set('Enter your current password and a new one of at least 6 characters.');
      return;
    }
    this.accountError.set(null);
    this.isSavingAccount.set(true);
    this.authService.changePassword(this.currentPassword, this.accountNewPassword).subscribe({
      next: (res) => {
        this.isSavingAccount.set(false);
        this.accountNotice.set(res.message || 'Password updated.');
        this.currentPassword = '';
        this.accountNewPassword = '';
      },
      error: (message: string) => {
        this.isSavingAccount.set(false);
        this.accountError.set(message || 'Could not update password.');
      }
    });
  }

  readonly sportsList = [
    { id: 'soccer', name: 'Soccer', count: 179 },
    { id: 'table-tennis', name: 'Table Tennis', count: 24 },
    { id: 'boxing', name: 'Boxing', count: 8 },
    { id: 'aussie-rules', name: 'Aussie Rules', count: 5 },
    { id: 'rugby', name: 'Rugby', count: 12 },
    { id: 'cricket', name: 'Cricket', count: 15 },
    { id: 'baseball', name: 'Baseball', count: 9 },
    { id: 'basketball', name: 'Basketball', count: 42 },
    { id: 'mma', name: 'MMA', count: 7 },
    { id: 'tennis', name: 'Tennis', count: 31 },
    { id: 'esport-kog', name: 'eSport King of Glory', count: 6 },
    { id: 'esport-lol', name: 'eSport League of Legends', count: 14 },
    { id: 'esport-cs', name: 'eSport Counter-Strike', count: 18 },
    { id: 'esport-cod', name: 'eSport Call of Duty', count: 4 },
    { id: 'esoccer', name: 'eSoccer', count: 28 },
    { id: 'ice-hockey', name: 'Ice Hockey', count: 11 },
    { id: 'american-football', name: 'American Football', count: 16 },
    { id: 'beach-volley', name: 'Beach Volley', count: 3 },
    { id: 'handball', name: 'Handball', count: 9 },
    { id: 'zoom-soccer', name: 'Zoom Soccer', count: 55 },
    { id: 'darts', name: 'Darts', count: 10 }
  ];

  public getSportCategory(id: string): string {
    if (id === 'soccer' || id === 'zoom-soccer') return 'soccer';
    if (id === 'table-tennis') return 'table-tennis';
    if (id === 'tennis') return 'tennis';
    if (id === 'basketball') return 'basketball';
    if (id === 'boxing') return 'boxing';
    if (id === 'mma') return 'mma';
    if (id === 'rugby' || id === 'aussie-rules' || id === 'american-football') return 'rugby';
    if (id === 'cricket') return 'cricket';
    if (id === 'baseball') return 'baseball';
    if (id === 'ice-hockey') return 'ice-hockey';
    if (id === 'darts') return 'darts';
    if (id.startsWith('esport') || id === 'esoccer') return 'esport';
    return 'default';
  }

  readonly visibleMatches = computed(() => {
    const filter = this.activeFilter();
    const all = this.sports.matches().filter(match => filter === 'all' || match.state === filter);
    return all;
  });

  readonly combinedOdds = computed(() => Number(this.selections()
    .reduce((total, selection) => total * selection.odds, 1)
    .toFixed(2)));

  readonly potentialReturn = computed(() => Number((Math.max(0, this.stake || 0) * this.combinedOdds()).toFixed(2)));

  ngOnInit(): void {
    this.startBannerAutoPlay();
    this.sports.start();
    this.subscriptions.push(
      this.authService.currentUser$.subscribe(user => {
        this.currentUser.set(user);
        this.depositPhone = user?.phone_number || user?.username || '';
      }),
      this.authService.userBalance$.subscribe(balance => this.userBalance.set(balance)),
      this.authService.minimumDeposit$.subscribe(minimum => {
        this.minimumDeposit.set(minimum);
        if (!Number.isFinite(this.depositAmount) || this.depositAmount < minimum) {
          this.depositAmount = minimum;
        }
      })
    );
    this.authService.loadMinimumDeposit();
  }

  ngOnDestroy(): void {
    this.stopBannerAutoPlay();
    this.subscriptions.forEach(subscription => subscription.unsubscribe());
    this.sports.stop();
  }

  setNavTab(tab: string): void {
    this.activeNavTab.set(tab);
    this.closeAllDrawers();

    // Aviator is the only destination that leaves this page.
    if (tab === 'aviator') {
      this.goToAviator();
      return;
    }
    if (tab === 'live' || tab === 'inplay') {
      this.activeFilter.set('live');
      return;
    }
    if (tab === 'home' || tab === 'sports' || tab === 'soccer') {
      this.activeFilter.set('all');
      return;
    }
    const label = this.navRail.find(item => item.id === tab)?.label
      || this.primaryNav.find(item => item.id === tab)?.label;
    if (label) this.showToast(`${label} is coming soon.`);
  }

  selectSport(sportId: string): void {
    this.selectedSport.set(sportId);
  }

  loadBetslipByCode(): void {
    if (!this.betslipCode.trim()) {
      this.betNotice.set('Enter a valid betslip code (e.g., VBmSU).');
      return;
    }
    const matches = this.sports.matches();
    if (matches.length > 0) {
      const match = matches[0];
      this.toggleSelection(match, 'home');
      this.betNotice.set(`Loaded code "${this.betslipCode.toUpperCase()}": 1 selection added to slip.`);
      this.betslipCode = '';
    }
  }

  goToAviator(): void {
    this.closeMobileMenu();
    this.router.navigate(['/play']);
  }

  goToAdmin(): void {
    this.showProfileMenu.set(false);
    this.closeMobileMenu();
    this.router.navigate(['/admin']);
  }

  toggleProfileMenu(): void {
    this.showProfileMenu.update(value => !value);
  }

  goToWallet(): void {
    this.showProfileMenu.set(false);
    this.closeMobileMenu();
    this.router.navigate(['/wallet']);
  }

  toggleSelection(match: FootballMatch, outcome: MatchOutcome): void {
    const outcomeLabel = outcome === 'home' ? match.home : outcome === 'draw' ? 'Draw' : match.away;
    const odds = outcome === 'home' ? match.homeOdds : outcome === 'draw' ? match.drawOdds : match.awayOdds;
    const selectionId = `${match.id}:${outcome}`;

    this.selections.update(items => {
      if (items.some(item => `${item.matchId}:${item.outcome}` === selectionId)) {
        return items.filter(item => `${item.matchId}:${item.outcome}` !== selectionId);
      }
      return [
        ...items.filter(item => item.matchId !== match.id),
        { matchId: match.id, matchLabel: `${match.home} v ${match.away}`, outcome, outcomeLabel, odds }
      ];
    });
    this.betNotice.set(null);
  }

  isSelected(matchId: string, outcome: MatchOutcome): boolean {
    return this.selections().some(item => item.matchId === matchId && item.outcome === outcome);
  }

  removeSelection(selection: BetSlipSelection): void {
    this.selections.update(items => items.filter(item => item !== selection));
  }

  clearSlip(): void {
    this.selections.set([]);
    this.betNotice.set(null);
  }

  placeDemoBet(): void {
    if (!this.selections().length) {
      this.betNotice.set('Add at least one match to your bet slip.');
      return;
    }
    if (!Number.isFinite(this.stake) || this.stake < 10) {
      this.betNotice.set('Enter a stake of at least KES 10.');
      return;
    }
    this.betNotice.set(`Bet placed! ${this.selections().length} selection${this.selections().length === 1 ? '' : 's'} at ${this.combinedOdds().toFixed(2)} total odds.`);
  }

  openDeposit(): void {
    this.authService.loadMinimumDeposit(true);
    this.showProfileMenu.set(false);
    this.closeMobileMenu();
    this.depositNotice.set(null);
    this.showDepositModal.set(true);
  }

  submitDeposit(): void {
    const minimum = this.minimumDeposit();
    if (!Number.isFinite(this.depositAmount) || this.depositAmount < minimum) {
      this.depositNotice.set(`Enter a deposit amount of at least KES ${minimum.toLocaleString()}.`);
      return;
    }
    this.isDepositing.set(true);
    this.depositNotice.set(null);
    this.authService.initiateMpesaSTKPush(this.depositAmount, this.depositPhone || undefined).subscribe({
      next: () => {
        this.isDepositing.set(false);
        this.depositNotice.set('Check your phone to complete the M-Pesa prompt. Your balance updates after confirmation.');
      },
      error: () => {
        this.isDepositing.set(false);
        this.depositNotice.set(null);
      }
    });
  }

  downloadApp(): void {
    this.showProfileMenu.set(false);
    this.closeMobileMenu();
    if (typeof window !== 'undefined') {
      if ((window as any).__ligibetPromptInstall) {
        (window as any).__ligibetPromptInstall();
      } else {
        window.dispatchEvent(new CustomEvent('ligibet-install-app'));
      }
    }
  }

  logout(): void {
    this.closeMobileMenu();
    this.authService.logout();
    this.router.navigate(['/login']);
  }
}
