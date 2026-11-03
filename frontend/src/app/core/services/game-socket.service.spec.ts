import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GameSocketService } from './game-socket.service';

const fake = vi.hoisted(() => ({
  handlers: new Map<string, (data: any) => void>(),
  socket: { connected: true, on: vi.fn(), emit: vi.fn(), removeAllListeners: vi.fn(), disconnect: vi.fn() }
}));
vi.mock('socket.io-client', () => ({ io: () => fake.socket }));

describe('instant confirmed cashout feedback', () => {
  let service: GameSocketService;
  beforeEach(() => {
    fake.handlers.clear();
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
});
