// ============================================================================
// Code Verification Helpers — constant-time compare + in-memory attempt limiter
// Shared by actions/auth.ts and actions/profile.ts (F2 / Simplify #2).
// ============================================================================

import crypto from 'crypto';

/**
 * Constant-time string comparison. Pads both inputs to the same length first to
 * avoid leaking length through the comparison itself.
 *
 * Used for 6-digit code checks (email verification, password reset, password
 * change) where any timing or length signal would let an attacker enumerate
 * codes server-side.
 */
export function safeEqual(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length);
  const bufA = Buffer.alloc(maxLen);
  const bufB = Buffer.alloc(maxLen);
  bufA.write(a);
  bufB.write(b);
  return crypto.timingSafeEqual(bufA, bufB);
}

// In-memory code-attempt tracker. Keyed by "<purpose>:<identifier>" — e.g.
// "verify:<userId>" or "reset:<email>". 1,000,000 possible 6-digit codes /
// CODE_MAX_ATTEMPTS = effective lockout against brute force within the window.
const codeAttempts = new Map<string, { count: number; firstAttempt: number }>();
const CODE_ATTEMPT_WINDOW_MS = 15 * 60 * 1000; // matches the 15-min code TTL
const CODE_MAX_ATTEMPTS = 5;

/**
 * Returns true if the attempt should proceed, false if the key has exceeded
 * CODE_MAX_ATTEMPTS inside CODE_ATTEMPT_WINDOW_MS. Mutates internal state on
 * every call. Also opportunistically GCs expired entries when the map gets
 * large enough to matter.
 */
export function checkCodeAttempts(key: string): boolean {
  const now = Date.now();
  if (codeAttempts.size > 500) {
    for (const [k, v] of codeAttempts) {
      if (now - v.firstAttempt > CODE_ATTEMPT_WINDOW_MS) codeAttempts.delete(k);
    }
  }
  const entry = codeAttempts.get(key);
  if (!entry || now - entry.firstAttempt > CODE_ATTEMPT_WINDOW_MS) {
    codeAttempts.set(key, { count: 1, firstAttempt: now });
    return true;
  }
  entry.count++;
  return entry.count <= CODE_MAX_ATTEMPTS;
}

/** Drop the attempt counter for a key after a successful verification. */
export function resetCodeAttempts(key: string): void {
  codeAttempts.delete(key);
}

/** Test-only escape hatch — clear all in-memory state between tests. */
export function _clearAllCodeAttempts(): void {
  codeAttempts.clear();
}
