import { TestBed, ComponentFixture } from '@angular/core/testing';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { BehaviorSubject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PaymentGatewaySettingsComponent } from './payment-gateway-settings.component';
import { AuthService } from '../../core/services/auth.service';
import { AdminSocketService } from '../../core/services/admin-socket.service';
import { AdminPinService, adminPinInterceptor } from '../../core/services/admin-pin.service';

describe('Admin deposit gateway settings', () => {
  let fixture: ComponentFixture<PaymentGatewaySettingsComponent>;
  let http: HttpTestingController;
  let events: BehaviorSubject<any>;
  const settings = (activeGateway = 'payhero', configured = true) => ({ activeGateway,
    gateways: [{ id: 'payhero', name: 'PayHero', configured: true }, { id: 'nexuspay', name: 'Nexus Pay', configured }] });
  beforeEach(async () => {
    events = new BehaviorSubject(null);
    await TestBed.configureTestingModule({ imports: [PaymentGatewaySettingsComponent], providers: [
      provideHttpClient(withInterceptors([adminPinInterceptor])), provideHttpClientTesting(),
      { provide: AuthService, useValue: { getToken: () => 'admin-token' } },
      { provide: AdminSocketService, useValue: { dashboardStatsUpdated$: events } }
    ] }).compileComponents();
    fixture = TestBed.createComponent(PaymentGatewaySettingsComponent);
    http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
  });
  afterEach(() => { fixture.destroy(); TestBed.inject(AdminPinService).clear(); http.verify(); });
  const match = (request: { url: string }) => request.url.endsWith('/api/admin/payment-gateway');

  it('loads the saved choice and disables Nexus Pay until credentials are configured', () => {
    const request = http.expectOne(match);
    expect(request.request.headers.get('Authorization')).toBe('Bearer admin-token');
    request.flush(settings('payhero', false));
    fixture.detectChanges();
    const options = fixture.nativeElement.querySelectorAll('option');
    expect(options[1].disabled).toBe(true);
    fixture.componentInstance.selectedGateway = 'nexuspay';
    fixture.componentInstance.save();
    http.expectNone(match);
    expect(fixture.componentInstance.activeGateway).toBe('payhero');
  });

  it('only changes the displayed active gateway after the server confirms the switch', () => {
    http.expectOne(match).flush(settings());
    fixture.componentInstance.selectedGateway = 'nexuspay';
    fixture.componentInstance.save();
    expect(fixture.componentInstance.activeGateway).toBe('payhero');
    const request = http.expectOne(match);
    expect(request.request.method).toBe('PUT');
    expect(request.request.body).toEqual({ gateway: 'nexuspay' });
    request.flush(settings('nexuspay'));
    expect(fixture.componentInstance.activeGateway).toBe('nexuspay');
    expect(fixture.componentInstance.saving).toBe(false);
  });

  it('preserves the existing gateway and releases the button on a failed save', () => {
    http.expectOne(match).flush(settings());
    fixture.componentInstance.selectedGateway = 'nexuspay';
    fixture.componentInstance.save();
    http.expectOne(match).flush({ error: 'Nexus Pay is unavailable.' }, { status: 503, statusText: 'Unavailable' });
    expect(fixture.componentInstance.activeGateway).toBe('payhero');
    expect(fixture.componentInstance.saving).toBe(false);
    expect(fixture.componentInstance.error).toBe('Nexus Pay is unavailable.');
  });

  it('handles another client claim during a gateway save without discarding the acknowledgement', () => {
    http.expectOne(match).flush(settings());
    fixture.componentInstance.selectedGateway = 'nexuspay';
    fixture.componentInstance.save();
    const request = http.expectOne(match);
    TestBed.inject(AdminPinService).refresh();
    request.flush({ ...settings('nexuspay'), api_key: 'must-not-be-returned' });
    expect(fixture.componentInstance.activeGateway).toBe('nexuspay');
    expect(fixture.componentInstance.saving).toBe(false);
  });

  it('refreshes the selected gateway when another administrator changes it', () => {
    http.expectOne(match).flush(settings());
    events.next({ action: 'payment_gateway_changed' });
    http.expectOne(match).flush(settings('nexuspay'));
    expect(fixture.componentInstance.activeGateway).toBe('nexuspay');
  });
});
