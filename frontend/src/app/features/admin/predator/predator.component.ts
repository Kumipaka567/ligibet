import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { AdminRoomStatus, AdminSocketService } from '../../../core/services/admin-socket';
import { AuthService } from '../../../core/services/auth.service';
import { SanitizedModeService } from '../../../core/services/sanitized-mode.service';

/** The rooms this readout watches, in display order. */
const WATCHED_ROOMS = [1, 2, 3];

export interface PredatorRoom {
  room: number;
  isPrimary: boolean;
  roundId: number | null;
  nextCrashPoint: number | null;
  phase: string;
  multiplier: number;
  activeBets: number;
  /** False until the engine has reported this room at least once. */
  live: boolean;
}

/**
 * A standalone readout of the next crash point.
 * In normal mode: displays rooms 1 to 3 with full dark telemetry.
 * In sanitized mode: clean white screen, room 1 only, big predictor without decimals,
 * and the configured number/words displayed large directly below it. All editing done in admin dashboard.
 */
@Component({
  selector: 'app-predator',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './predator.component.html',
  styleUrls: ['./predator.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class PredatorComponent implements OnInit, OnDestroy {
  private readonly adminSocket = inject(AdminSocketService);
  private readonly authService = inject(AuthService);
  public readonly sanitizedModeService = inject(SanitizedModeService);
  private readonly router = inject(Router);
  private readonly subscriptions: Subscription[] = [];

  public readonly isConnected = signal(false);
  public readonly connectionError = signal<string | null>(null);
  public readonly lastUpdate = signal<Date | null>(null);
  public readonly countdownMs = signal<number>(0);
  private readonly roomFeed = signal<AdminRoomStatus[]>([]);

  /** Sanitized mode flag: strictly active only for admin / superadmin */
  public readonly isSanitized = computed(() =>
    this.authService.isAdmin() && this.sanitizedModeService.isSanitizedMode()
  );

  /** Configurable visible text (configured only from the admin dashboard) */
  public readonly predatorText = computed(() =>
    this.sanitizedModeService.predatorCustomText()
  );

  /**
   * Room list:
   * In Sanitized Mode: strictly Room 1 ONLY (Rooms 2 & 3 removed).
   * In Normal Mode: Rooms 1, 2, and 3.
   */
  public readonly rooms = computed<PredatorRoom[]>(() => {
    const feed = this.roomFeed();
    const watched = this.isSanitized() ? [1] : WATCHED_ROOMS;

    return watched.map((room) => {
      const reported = feed.find((entry) => entry.room === room);
      if (!reported) {
        return {
          room,
          isPrimary: room === 1,
          roundId: null,
          nextCrashPoint: null,
          phase: 'unknown',
          multiplier: 1,
          activeBets: 0,
          live: false
        };
      }
      return {
        room: reported.room,
        isPrimary: reported.isPrimary,
        roundId: reported.roundId,
        nextCrashPoint: reported.nextCrashPoint,
        phase: reported.phase || 'unknown',
        multiplier: Number(reported.multiplier) || 1,
        activeBets: Number(reported.activeBets) || 0,
        live: true
      };
    });
  });

  public readonly totalActiveBets = computed(() =>
    this.rooms().reduce((sum, room) => sum + room.activeBets, 0)
  );

  public ngOnInit(): void {
    const token = this.authService.getToken();
    if (!token) {
      this.router.navigate(['/login']);
      return;
    }

    this.adminSocket.connect(token);
    this.sanitizedModeService.fetchStatus();

    this.subscriptions.push(
      this.adminSocket.isConnected$.subscribe((connected) => this.isConnected.set(connected)),
      this.adminSocket.error$.subscribe((error) => this.connectionError.set(error)),
      this.adminSocket.nextRound$.subscribe((next) => {
        const rooms = next?.rooms;
        if (rooms && rooms.length) {
          this.roomFeed.set(rooms);
        } else if (next?.roundId !== null && next?.roundId !== undefined) {
          // Older payloads carry only the primary room at the top level.
          this.roomFeed.set([{
            room: 1,
            isPrimary: true,
            roundId: next.roundId,
            nextCrashPoint: next.nextCrashPoint,
            phase: next.status === 'Running' ? 'flying' : next.status === 'Crashed' ? 'crashed' : 'betting',
            multiplier: 1,
            activeBets: 0
          }]);
        }
        this.countdownMs.set(Number(next?.countdownMs) || 0);
        this.lastUpdate.set(new Date());
      }),
      this.adminSocket.predatorTextUpdate$.subscribe((text) => {
        if (text !== null) {
          this.sanitizedModeService.applyPredatorTextUpdate(text);
        }
      })
    );
  }

  public ngOnDestroy(): void {
    this.subscriptions.forEach((subscription) => subscription.unsubscribe());
    this.adminSocket.disconnect();
  }

  /**
   * Formats next crash point:
   * In Sanitized Mode: single whole integer without decimals (e.g. 9.08 -> 9).
   * In Normal Mode: 2 decimal places (e.g. 9.08).
   */
  public formatCrashValue(crashPoint: number | null): string {
    if (crashPoint === null || crashPoint === undefined) return '—';
    if (this.isSanitized()) {
      return String(Math.floor(Number(crashPoint)));
    }
    return Number(crashPoint).toFixed(2);
  }

  public phaseLabel(phase: string): string {
    switch (phase) {
      case 'betting': return 'Betting Open';
      case 'flying': return 'In Flight';
      case 'crashed': return 'Crashed';
      default: return 'Awaiting Engine';
    }
  }

  /** Banding is visual: highlights target magnitude */
  public crashBand(crashPoint: number | null): string {
    if (crashPoint === null) return 'unknown';
    if (crashPoint < 2) return 'low';
    if (crashPoint < 10) return 'mid';
    return 'high';
  }

  public bandLabel(crashPoint: number | null): string {
    if (this.isSanitized()) {
      return '';
    }
    switch (this.crashBand(crashPoint)) {
      case 'low': return 'Early crash';
      case 'mid': return 'Standard range';
      case 'high': return 'Long runner';
      default: return 'No target yet';
    }
  }

  public trackByRoom(_index: number, room: PredatorRoom): number {
    return room.room;
  }

  public backToDashboard(): void {
    this.router.navigate(['/admin']);
  }
}
