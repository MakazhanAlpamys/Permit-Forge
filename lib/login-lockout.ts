// ============================================================================
// Per-account login lockout (C3H / H4)
// ============================================================================
// IP-based rate limiting (already in actions/auth.ts) is necessary but not
// sufficient — an attacker with a botnet rotates source IPs faster than the
// per-IP window expires, while still hammering a single victim account.
//
// This module adds a counter keyed by *username* (lowercased) so the lockout
// follows the targeted account regardless of where requests originate. Counts
// only failed login attempts; successful login resets the counter.
//
// In-memory only — survives within a process, not across restarts or instances.
// That's acceptable for the diploma scope: defense-in-depth on top of the
// DB-backed IP limiter; a determined attacker still has to outpace bcrypt.
// ============================================================================

interface LockoutEntry {
  count: number;
  firstAttempt: number;
  lockedUntil: number | null;
}

const attempts = new Map<string, LockoutEntry>();

const LOCKOUT_WINDOW_MS = 15 * 60 * 1000; // 15 min rolling window
const LOCKOUT_MAX_FAILURES = 5; // → lock the account
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 min lockout
const MAP_GC_THRESHOLD = 500;

function key(username: string): string {
  return username.trim().toLowerCase();
}

function gcIfNeeded(now: number): void {
  if (attempts.size < MAP_GC_THRESHOLD) return;
  for (const [k, v] of attempts) {
    const expired =
      now - v.firstAttempt > LOCKOUT_WINDOW_MS &&
      (v.lockedUntil === null || now > v.lockedUntil);
    if (expired) attempts.delete(k);
  }
}

/**
 * Check whether the account is currently locked out. Does NOT mutate state.
 * Returns `{ locked: true, retryAfterMs }` when the caller should refuse the
 * login attempt outright; otherwise `{ locked: false }`.
 */
export function isAccountLockedOut(
  username: string,
): { locked: false } | { locked: true; retryAfterMs: number } {
  if (!username) return { locked: false };
  const entry = attempts.get(key(username));
  if (!entry || entry.lockedUntil === null) return { locked: false };
  const now = Date.now();
  if (now < entry.lockedUntil) {
    return { locked: true, retryAfterMs: entry.lockedUntil - now };
  }
  return { locked: false };
}

/**
 * Record a failed login. Returns the resulting state (`{ locked }` or
 * `{ locked: true, retryAfterMs }` if this failure tipped the account over the
 * threshold).
 */
export function recordFailedLogin(
  username: string,
): { locked: false } | { locked: true; retryAfterMs: number } {
  if (!username) return { locked: false };
  const k = key(username);
  const now = Date.now();
  gcIfNeeded(now);

  const entry = attempts.get(k);

  // Reset the window if previous data is stale and not in an active lockout.
  if (!entry || (now - entry.firstAttempt > LOCKOUT_WINDOW_MS && (entry.lockedUntil === null || now > entry.lockedUntil))) {
    attempts.set(k, { count: 1, firstAttempt: now, lockedUntil: null });
    return { locked: false };
  }

  // Already locked — keep the lockout, don't extend it on additional attempts.
  if (entry.lockedUntil !== null && now < entry.lockedUntil) {
    return { locked: true, retryAfterMs: entry.lockedUntil - now };
  }

  entry.count += 1;
  if (entry.count >= LOCKOUT_MAX_FAILURES) {
    entry.lockedUntil = now + LOCKOUT_DURATION_MS;
    return { locked: true, retryAfterMs: LOCKOUT_DURATION_MS };
  }
  return { locked: false };
}

/** Reset counters on successful login. */
export function clearLoginAttempts(username: string): void {
  if (!username) return;
  attempts.delete(key(username));
}

/** Test-only escape hatch. */
export function _clearAllLoginAttempts(): void {
  attempts.clear();
}

export const LOCKOUT_LIMITS = {
  LOCKOUT_WINDOW_MS,
  LOCKOUT_MAX_FAILURES,
  LOCKOUT_DURATION_MS,
} as const;
