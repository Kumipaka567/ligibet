import { NgZone } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Socket, io } from 'socket.io-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminSocketService } from './admin-socket';

vi.mock('socket.io-client', () => ({ io: vi.fn() }));

describe('Admin socket live delivery', () => {
  let service: AdminSocketService;
  let handlers: Map<string, (payload?: any) => void>;
  let socket: any;

  beforeEach(() => {
    handlers = new Map();
    socket = {
      connected: true,
      on: vi.fn((event: string, handler: (payload?: any) => void) => {
        handlers.set(event, handler);
        return socket;
      }),
      disconnect: vi.fn(), emit: vi.fn()
    };
    vi.mocked(io).mockReturnValue(socket as Socket);
    TestBed.configureTestingModule({});
    service = TestBed.inject(AdminSocketService);
  });

  it('delivers incoming wallet events inside Angular and reconnects the status stream', () => {
    service.connect('token');
    const zone = TestBed.inject(NgZone);
    const run = vi.spyOn(zone, 'run');
    const wallet = { action: 'deposit_completed', userId: 7, balance: 600, occurredAt: 'now' };
    handlers.get('connect')!();
    handlers.get('wallet_updated')!(wallet);
    expect(service.isConnected$.value).toBe(true);
    expect(service.walletUpdated$.value).toEqual(wallet);
    expect(run).toHaveBeenCalled();
    handlers.get('disconnect')!('transport close');
    expect(service.isConnected$.value).toBe(false);
    handlers.get('connect')!();
    expect(service.isConnected$.value).toBe(true);
    expect(service.error$.value).toBeNull();
  });

  it('clears replayed financial and account events before a fresh connection', () => {
    service.walletUpdated$.next({ action: 'balance_adjusted', userId: 7, balance: 300, occurredAt: 'old' });
    service.userUpdated$.next({ action: 'role_updated', userId: 7, role: 'admin', occurredAt: 'old' });
    service.connect('new-token');
    expect(service.walletUpdated$.value).toBeNull();
    expect(service.userUpdated$.value).toBeNull();
  });

  it('stops reconnecting when administrator access is revoked', () => {
    service.connect('token');
    handlers.get('connect')!();
    const event = { userId: 7, reason: 'Your administrator access was removed.' };
    handlers.get('admin_access_revoked')!(event);
    expect(socket.disconnect).toHaveBeenCalled();
    expect(service.accessRevoked$.value).toEqual(event);
    expect(service.isConnected$.value).toBe(false);
    expect(service.error$.value).toBe(event.reason);
  });
});
