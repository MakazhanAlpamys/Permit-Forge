'use client';

import { CSRF_COOKIE_NAME } from './constants';

/**
 * Read the CSRF token straight from the (non-HttpOnly) `ef_csrf` cookie.
 *
 * The double-submit cookie is set non-HttpOnly at login precisely so the
 * client can echo it back. Reading it here — instead of round-tripping to
 * `getCSRFTokenAction()` — means a transient network blip (e.g. ERR_NETWORK_CHANGED
 * when the connection/VPN flips) can't leave a cached token null and wedge every
 * subsequent mutation with "CSRF token missing".
 */
export function readCsrfCookie(): string | null {
  if (typeof document === 'undefined') return null;
  for (const part of document.cookie.split('; ')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq) === CSRF_COOKIE_NAME) {
      return decodeURIComponent(part.slice(eq + 1));
    }
  }
  return null;
}
