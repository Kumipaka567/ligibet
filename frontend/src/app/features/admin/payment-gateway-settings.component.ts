import { ChangeDetectorRef, Component, OnDestroy, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { Subscription, finalize, skip, timeout } from 'rxjs';
import { AuthService } from '../../core/services/auth.service';
import { AdminSocketService } from '../../core/services/admin-socket.service';
import { getBackendOrigin } from '../../core/config/backend-url';

type Gateway = 'payhero' | 'nexuspay';
interface GatewaySettings {
  activeGateway: Gateway;
  gateways: { id: Gateway; name: string; configured: boolean }[];
}

@Component({
  selector: 'app-payment-gateway-settings', standalone: true, imports: [CommonModule, FormsModule],
  template: `
    <section class="gateway-panel" aria-labelledby="gateway-title">
      <h2 id="gateway-title">Deposit payment gateway</h2>
      <p>Choose the gateway for new M-Pesa deposits. Payments already started continue through their original gateway.</p>
      <p *ngIf="activeGateway" class="active-gateway">Active: <strong>{{ activeGateway === 'payhero' ? 'PayHero' : 'Nexus Pay' }}</strong></p>
      <p *ngIf="loading" role="status">Loading payment settings...</p>
      <form *ngIf="activeGateway" (ngSubmit)="save()">
        <label for="active-deposit-gateway">Payment gateway</label>
        <select id="active-deposit-gateway" name="gateway" [(ngModel)]="selectedGateway" [disabled]="loading || saving">
          <option *ngFor="let gateway of gateways" [ngValue]="gateway.id" [disabled]="!gateway.configured">
            {{ gateway.name }}{{ gateway.configured ? '' : ' — not configured' }}
          </option>
        </select>
        <p class="gateway-note">Only administrators can switch gateways. Customers use the same deposit screen.</p>
        <button type="submit" [disabled]="loading || saving || selectedGateway === activeGateway || !selectedConfigured">
          {{ saving ? 'Switching...' : 'Save active gateway' }}
        </button>
      </form>
      <p *ngIf="error" role="alert" class="gateway-error">{{ error }}</p>
      <p *ngIf="message" role="status" class="gateway-success">{{ message }}</p>
      <button *ngIf="error && !loading" type="button" (click)="load()" [disabled]="saving">Reload payment settings</button>
      <p *ngIf="nexusUnconfigured" class="gateway-note">Configure the Nexus Pay API key on the backend server before switching to Nexus Pay.</p>
    </section>
  `,
  styles: [`
    :host{display:block;margin-bottom:20px;color:inherit}
    .gateway-panel{border:1px solid rgba(148,163,184,.18);border-radius:14px;padding:22px;background:rgba(15,23,42,.45)}
    h2{margin:0 0 9px;font-size:19px}p{line-height:1.5;color:#aab7c9;font-size:13px}label{display:block;font-size:13px;margin:12px 0 8px}
    select{display:block;box-sizing:border-box;width:min(100%,420px);padding:12px;background:#162033;color:#f1f5f9;border:1px solid #3b475c;border-radius:8px;font:inherit}
    button{padding:10px 15px;border:1px solid #475569;border-radius:8px;background:#263a53;color:#fff;font:inherit;cursor:pointer}button:disabled{opacity:.5;cursor:default}
    .gateway-note{font-size:12px}.gateway-error{color:#fca5a5}.gateway-success{color:#86efac}.active-gateway{color:#e2e8f0}
  `]
})
export class PaymentGatewaySettingsComponent implements OnInit, OnDestroy {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly socket = inject(AdminSocketService);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly subscriptions = new Subscription();
  private readonly url = `${getBackendOrigin()}/api/admin/payment-gateway`;
  public activeGateway: Gateway | null = null;
  public selectedGateway: Gateway = 'payhero';
  public gateways: GatewaySettings['gateways'] = [];
  public loading = false;
  public saving = false;
  public error = '';
  public message = '';
  public get selectedConfigured(): boolean { return !!this.gateways.find(gateway => gateway.id === this.selectedGateway)?.configured; }
  public get nexusUnconfigured(): boolean { return this.gateways.some(gateway => gateway.id === 'nexuspay' && !gateway.configured); }
  public ngOnInit(): void {
    this.load();
    this.subscriptions.add(this.socket.dashboardStatsUpdated$.pipe(skip(1)).subscribe(event => {
      if (event?.action === 'payment_gateway_changed' && !this.saving) this.load();
    }));
  }
  private headers() { return { Authorization: `Bearer ${this.auth.getToken()}` }; }
  public load(): void {
    if (this.loading || this.saving) return;
    this.loading = true;
    this.error = '';
    this.subscriptions.add(this.http.get<GatewaySettings>(this.url, { headers: this.headers() }).pipe(timeout(10000),
      finalize(() => { this.loading = false; this.cdr.markForCheck(); })).subscribe({
      next: result => { this.activeGateway = result.activeGateway; this.selectedGateway = result.activeGateway; this.gateways = result.gateways; },
      error: () => { this.error = 'Unable to load the active gateway. Please reload payment settings.'; }
    }));
  }
  public save(): void {
    if (!this.activeGateway || !this.selectedConfigured || this.selectedGateway === this.activeGateway || this.saving || this.loading) return;
    this.saving = true;
    this.error = '';
    this.message = '';
    this.subscriptions.add(this.http.put<GatewaySettings>(this.url, { gateway: this.selectedGateway }, { headers: this.headers() }).pipe(timeout(10000),
      finalize(() => { this.saving = false; this.cdr.markForCheck(); })).subscribe({
      next: result => {
        this.activeGateway = result.activeGateway; this.selectedGateway = result.activeGateway; this.gateways = result.gateways;
        this.message = `${result.activeGateway === 'payhero' ? 'PayHero' : 'Nexus Pay'} is now active for new deposits.`;
      },
      error: response => { this.error = response?.error?.error || 'Could not confirm the switch. Reload payment settings to check the active gateway.'; }
    }));
  }
  public ngOnDestroy(): void { this.subscriptions.unsubscribe(); }
}
