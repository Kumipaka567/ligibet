import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GameSocketService } from './game-socket.service';
import { io, Socket } from 'socket.io-client';

const fake = vi.hoisted(() => ({
  handlers: new Map<string, (data: any) => void>(),
  socket: { connected: true, on: vi.fn(), emit: vi.fn(), removeAllListeners: vi.fn(), disconnect: vi.fn() }
}));
vi.mock('socket.io-client', () => ({ io: vi.fn() }));

describe('instant confirmed cashout feedback', () => {
  let service: GameSocketService;
  beforeEach(() => {
    vi.mocked(io).mockReturnValue(fake.socket as unknown as Socket);
    fake.handlers.clear();
    fake.socket.emit.mockClear();
    fake.socket.on.mockImplementation((event, handler) => { fake.handlers.set(event, handler); return fake.socket; });
    service = new GameSocketService();
    service.connect('test-token');
  });

  it('updates the confirmed balance before resolving cashout, without waiting for a balance event or crash', () => {
    let balanceAtConfirmation: number | null = null;
    service.phase$.next('flying');
    service.cashOutSuccess$.subscribe(result => { if (result) balanceAtConfirmation = service.balance$.value; });
    fake.handlers.get('cash_out_success')!({ room: 1, slot: 1, multiplier: 2.5, payoutAmount: 250, balance: 750 });
    expect(balanceAtConfirmation).toBe(750);
    expect(service.cashOutSuccess$.value?.payoutAmount).toBe(250);
    expect(service.phase$.value).toBe('flying');
  });

  it('keeps older confirmations compatible and never invents or invalidates a wallet balance', () => {
    service.balance$.next(500);
    for (const balance of [undefined, null, 'bad', NaN, Infinity]) {
      fake.handlers.get('cash_out_success')!({ room: 1, slot: 1, multiplier: 2.5, payoutAmount: 250, balance });
      expect(service.balance$.value).toBe(500);
    }
    fake.handlers.get('cash_out_success')!({ room: 1, slot: 1, multiplier: 1, payoutAmount: 10, balance: 0 });
    expect(service.balance$.value).toBe(0);
  });

  it('updates the global wallet for a confirmed payment from another room without changing this room’s panel', () => {
    fake.handlers.get('cash_out_success')!({ room: 2, slot: 1, multiplier: 2.5, payoutAmount: 250, balance: 750 });
    expect(service.balance$.value).toBe(750);
    expect(service.cashOutSuccess$.value).toBeNull();
  });

  it('allows a polling connection when WebSockets are blocked and enables alternate transports', () => {
    expect(vi.mocked(io).mock.lastCall?.[1]).toMatchObject({ transports: ['polling', 'websocket'], tryAllTransports: true, timeout: 10000 });
  });

  it('rejoins the selected room after reconnect and ignores the default room snapshot', () => {
    service.changeRoom(3);
    fake.socket.emit.mockClear();
    fake.handlers.get('connect')!({});
    expect(fake.socket.emit).toHaveBeenCalledWith('change_room', { room: 3 });
    fake.handlers.get('room_state')!({ room: 1, phase: 'betting', history: [], activeBets: [] });
    expect(service.roomState$.value).toBeNull();
    const room = { room: 3, phase: 'flying', history: [], activeBets: [{ slot: 1, amount: 100, status: 'placed', payoutAmount: 0, cashoutMultiplier: null }] };
    fake.handlers.get('room_state')!(room);
    expect(service.roomState$.value).toEqual(room);
    service.cashOut(1);
    expect(fake.socket.emit).toHaveBeenCalledWith('cash_out', { slot: 1, room: 3 });
  });
});
