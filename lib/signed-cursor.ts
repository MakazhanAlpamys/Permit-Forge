// ============================================================================
// Signed pagination cursors (C27H / L2)
// ============================================================================
// Pagination cursors are returned to the client and then echoed back on the
// next request. Without a signature the client can rewrite the cursor value
// to any timestamp it wants, which doesn't expose other users' data (the
// WHERE user_id = current_user clause stays), but it does let a curious user
// page from arbitrary points in their own history and can confuse server-
// side telemetry / rate-limiting derived from cursor values.
//
// We attach an HMAC-SHA256 signature to each cursor using JWT_SECRET. Cursors
// from a previous JWT_SECRET become invalid (which is fine — the user can
// re-paginate from the start).
// ============================================================================

import crypto from 'crypto';

function getSecret(): Buffer {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters');
  }
  return Buffer.from(secret);
}

function base64UrlEncode(buf: Buffer | string): string {
  const b = typeof buf === 'string' ? Buffer.from(buf) : buf;
  return b.toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function hmac(value: string): string {
  return crypto.createHmac('sha256', getSecret()).update(value).digest('base64')
    .replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/**
 * Encode a cursor value (typically an ISO timestamp) into a signed token of
 * the form `<base64url(value)>.<base64url(hmac)>`.
 */
export function signCursor(value: string): string {
  const v = base64UrlEncode(value);
  const sig = hmac(value);
  return `${v}.${sig}`;
}

/**
 * Verify a signed cursor and return the original value, or null if the
 * signature is missing or doesn't match.
 */
export function verifyCursor(token: string | undefined | null): string | null {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  const valueB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  let value: string;
  try {
    value = base64UrlDecode(valueB64).toString('utf8');
  } catch {
    return null;
  }

  const expected = hmac(value);
  if (sig.length !== expected.length) return null;
  try {
    if (crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      return value;
    }
  } catch {
    return null;
  }
  return null;
}
