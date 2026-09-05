import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { AuthService, TransactionRecord } from '../../../core/services/auth.service';
import { GameSocketService } from '../../../core/services/game-socket.service';

@Component({
  selector: 'app-wallet',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="wallet-page-wrapper">
      <header class="wallet-header">
        <button class="back-btn" (click)="goBack()">‹ Back to Game</button>
        <h1>User Wallet & Transaction History</h1>
        <div class="user-balance-box">
          <span class="lbl">Balance:</span>
          <span class="val">{{ (userBalance$ | async) | number:'1.2-2' }} KES</span>
        </div>
      </header>

      <main class="wallet-content glass-card">
        <div class="section-title-row">
          <h2>Deposit & Withdrawal Transactions</h2>
          <button class="refresh-btn" (click)="fetchTransactions()">Refresh</button>
        </div>

        <div *ngIf="isLoading" class="loading-state">
          <span>Loading transactions...</span>
        </div>

        <div *ngIf="!isLoading && transactions.length === 0" class="empty-state">
          <p>No transactions recorded yet. Initiate a deposit from the game to get started.</p>
        </div>

        <div *ngIf="!isLoading && transactions.length > 0" class="tx-table-wrap">
          <table class="tx-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Type</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Reference</th>
                <th>Date & Time</th>
              </tr>
            </thead>
            <tbody>
              <tr *ngFor="let tx of transactions">
                <td>#{{ tx.id }}</td>
                <td>
                  <span class="type-pill" [class.dep]="tx.type === 'deposit'" [class.wd]="tx.type === 'withdrawal'">
                    {{ tx.type | uppercase }}
                  </span>
                </td>
                <td class="amount-col">{{ tx.amount | number:'1.2-2' }} KES</td>
                <td>
                  <span class="status-badge" [class.completed]="tx.status === 'completed'" [class.failed]="tx.status === 'failed'" [class.pending]="tx.status === 'pending'">
                    <ng-container [ngSwitch]="tx.status">
                      <span *ngSwitchCase="'completed'">COMPLETED</span>
                      <span *ngSwitchCase="'failed'">FAILED</span>
                      <span *ngSwitchCase="'pending'">PENDING</span>
                      <span *ngSwitchDefault>{{ tx.status | uppercase }}</span>
                    </ng-container>
                  </span>
                </td>
                <td class="ref-col">{{ tx.reference || '-' }}</td>
                <td class="date-col">{{ tx.created_at | date:'medium' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </main>
    </div>
  `,
  styles: [`
    :host {
      --lb-green: #15a94b;
      --lb-green-dark: #0d7f36;
      --lb-page: #eceff1;
      --lb-card: #ffffff;
      --lb-border: #e3e7ea;
      --lb-text: #1f2937;
      --lb-muted: #6b7280;
      --lb-faint: #9aa4ae;
      display: block;
      font-family: 'Inter', 'Segoe UI', Roboto, Arial, sans-serif;
    }

    *, *::before, *::after { box-sizing: border-box; }

    .wallet-page-wrapper {
      min-height: 100vh;
      background: var(--lb-page);
      color: var(--lb-text);
      padding-bottom: 40px;
    }

    .wallet-header {
      background: var(--lb-green);
      display: flex;
      align-items: center;
      gap: 16px;
      flex-wrap: wrap;
      padding: 14px 20px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.14);
    }

    .back-btn {
      background: rgba(0, 0, 0, 0.18);
      border: 0;
      color: #fff;
      border-radius: 6px;
      padding: 9px 15px;
      font-size: 14px;
      font-weight: 700;
      font-family: inherit;
      cursor: pointer;
    }
    .back-btn:hover { background: rgba(0, 0, 0, 0.28); }

    .wallet-header h1 {
      margin: 0;
      flex: 1 1 auto;
      font-size: 18px;
      font-weight: 800;
      color: #fff;
    }

    .user-balance-box {
      display: flex;
      align-items: baseline;
      gap: 7px;
      background: rgba(0, 0, 0, 0.18);
      border-radius: 6px;
      padding: 8px 14px;
    }
    .user-balance-box .lbl { font-size: 11px; color: rgba(255, 255, 255, 0.82); text-transform: uppercase; letter-spacing: 0.4px; font-weight: 600; }
    .user-balance-box .val { font-size: 16px; font-weight: 800; color: #ffe000; }

    .wallet-content {
      max-width: 1180px;
      margin: 16px auto 0;
      background: var(--lb-card);
      border-radius: 8px;
      padding: 18px 20px 22px;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
    }

    .section-title-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      margin-bottom: 16px;
    }
    .section-title-row h2 { margin: 0; font-size: 16px; font-weight: 800; color: var(--lb-text); }

    .refresh-btn {
      background: var(--lb-green);
      border: 0;
      color: #fff;
      border-radius: 6px;
      padding: 9px 18px;
      font-size: 13.5px;
      font-weight: 700;
      font-family: inherit;
      cursor: pointer;
    }
    .refresh-btn:hover { background: var(--lb-green-dark); }

    .loading-state, .empty-state {
      padding: 46px 20px;
      text-align: center;
      color: var(--lb-faint);
      font-size: 14px;
    }
    .empty-state p { margin: 0; line-height: 1.55; }

    .tx-table-wrap { overflow-x: auto; }

    .tx-table {
      width: 100%;
      border-collapse: collapse;
      min-width: 720px;
    }
    .tx-table thead th {
      text-align: left;
      padding: 10px 12px;
      font-size: 11.5px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--lb-faint);
      border-bottom: 1px solid var(--lb-border);
      white-space: nowrap;
    }
    .tx-table tbody td {
      padding: 13px 12px;
      font-size: 13.5px;
      border-bottom: 1px solid #eef1f3;
      color: var(--lb-text);
    }
    .tx-table tbody tr:hover { background: #f6f8f9; }
    .tx-table tbody tr:last-child td { border-bottom: 0; }

    .amount-col { font-weight: 800; white-space: nowrap; }
    .ref-col { color: var(--lb-muted); font-size: 12.5px; }
    .date-col { color: var(--lb-muted); font-size: 12.5px; white-space: nowrap; }

    .type-pill {
      display: inline-block;
      padding: 4px 11px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.3px;
      background: #eef1f3;
      color: var(--lb-muted);
    }
    .type-pill.dep { background: #e8f6ed; color: var(--lb-green-dark); }
    .type-pill.wd { background: #fff4e5; color: #b45309; }

    .status-badge {
      display: inline-block;
      padding: 4px 11px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.3px;
      background: #eef1f3;
      color: var(--lb-muted);
    }
    .status-badge.completed { background: #e8f6ed; color: var(--lb-green-dark); }
    .status-badge.failed { background: #fdecec; color: #b91c1c; }
    .status-badge.pending { background: #fff8e1; color: #92400e; }

    @media (max-width: 640px) {
      .wallet-header { padding: 12px 14px; gap: 10px; }
      .wallet-header h1 { font-size: 15px; width: 100%; order: 3; }
      .wallet-content { margin: 12px 10px 0; padding: 14px 14px 18px; border-radius: 8px; }
    }
  `]
})
export class WalletComponent implements OnInit, OnDestroy {
  private authService = inject(AuthService);
  private gameSocket = inject(GameSocketService);
  private router = inject(Router);
  private subscriptions: Subscription[] = [];

  public userBalance$ = this.authService.userBalance$;
  public transactions: TransactionRecord[] = [];
  public isLoading: boolean = false;

  ngOnInit() {
    this.fetchTransactions();
    const token = this.authService.getToken();
    if (token) this.gameSocket.connect(token);
    this.subscriptions.push(
      this.gameSocket.walletUpdated$.subscribe(event => {
        if (event?.balance !== undefined) this.authService.updateBalance(event.balance);
      }),
      this.gameSocket.transactionsUpdated$.subscribe(event => {
        if (event) this.fetchTransactions();
      }),
      this.gameSocket.depositsUpdated$.subscribe(event => {
        if (event) this.fetchTransactions();
      }),
      this.gameSocket.withdrawalsUpdated$.subscribe(event => {
        if (event) this.fetchTransactions();
      }),
      this.gameSocket.userUpdated$.subscribe(event => {
        if (event) this.authService.loadCurrentUser().subscribe();
      })
    );
  }

  ngOnDestroy() {
    this.subscriptions.forEach(subscription => subscription.unsubscribe());
    this.gameSocket.disconnect();
  }

  fetchTransactions() {
    this.isLoading = true;
    this.authService.getTransactionHistory().subscribe({
      next: (res) => {
        this.transactions = res.transactions || [];
        this.isLoading = false;
      },
      error: () => {
        this.isLoading = false;
      }
    });
  }

  goBack() {
    this.router.navigate(['/dashboard']);
  }
}
export class Wallet extends WalletComponent {}
