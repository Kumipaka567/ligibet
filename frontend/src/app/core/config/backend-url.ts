import { PRODUCTION_BACKEND_ORIGIN } from './backend-origin.generated';

/**
 * Local Angular builds use the matching local API, while deployed builds keep
 * using the API this bundle was built against. This prevents a local UI from
 * silently connecting to an older deployed game engine.
 *
 * The deployed origin comes from backend-origin.generated.ts, which the build
 * writes from BACKEND_ORIGIN. See frontend/scripts/write-backend-origin.js.
 */
export function getBackendOrigin(): string {
  if (typeof window === 'undefined') return PRODUCTION_BACKEND_ORIGIN;

  const hostname = window.location.hostname;
  const port = window.location.port;

  // If already served directly from the backend (e.g. on Render or backend static serving)
  if (hostname.endsWith('.onrender.com') || hostname === 'api.ligibet.site' || port === '3000') {
    return window.location.origin;
  }

  const isLocalOrLan = hostname === 'localhost'
    || hostname === '127.0.0.1'
    || /^192\.168\.\d+\.\d+$/.test(hostname)
    || /^10\.\d+\.\d+\.\d+$/.test(hostname)
    || /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(hostname);

  return isLocalOrLan ? `http://${hostname}:3000` : PRODUCTION_BACKEND_ORIGIN;
}
