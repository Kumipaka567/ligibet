import type { Socket } from 'socket.io-client';

/** Polling establishes a connection even on networks that block WebSocket upgrades. */
export function socketOptions() {
  return {
    transports: ['polling', 'websocket'],
    tryAllTransports: true,
    timeout: 10000,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000
  };
}
export function retryTemporarySocketAuth(error: unknown, socket: Socket | null, isCurrent: () => boolean) {
  const failure = error as { data?: { retryable?: boolean }; message?: string };
  const temporary = failure?.data?.retryable === true
    || ['Account verification temporarily unavailable', 'Database verification failed'].includes(failure?.message || '');
  if (!temporary || !socket) return null;
  return setTimeout(() => {
    if (isCurrent() && !socket.connected) socket.connect();
  }, 2000);
}
