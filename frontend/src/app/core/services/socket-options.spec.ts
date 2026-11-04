import type { Socket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { retryTemporarySocketAuth } from './socket-options';

describe('temporary socket authentication recovery', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('reconnects after a temporary verification failure', () => {
    const connect = vi.fn();
    retryTemporarySocketAuth({ data: { retryable: true } }, { connected: false, connect } as unknown as Socket, () => true);
    vi.advanceTimersByTime(2000);
    expect(connect).toHaveBeenCalledOnce();
  });

  it('never reconnects rejected tokens, suspended users or obsolete connections', () => {
    const connect = vi.fn();
    const socket = { connected: false, connect } as unknown as Socket;
    for (const message of ['Invalid token', 'ACCOUNT_SUSPENDED', 'Admin privileges required']) {
      expect(retryTemporarySocketAuth({ message }, socket, () => true)).toBeNull();
    }
    retryTemporarySocketAuth({ data: { retryable: true } }, socket, () => false);
    vi.advanceTimersByTime(5000);
    expect(connect).not.toHaveBeenCalled();
  });
});
