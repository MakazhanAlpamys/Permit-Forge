// ============================================================================
// Tests: lib/login-lockout (C3H / H4)
// ============================================================================

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  isAccountLockedOut,
  recordFailedLogin,
  clearLoginAttempts,
  _clearAllLoginAttempts,
  LOCKOUT_LIMITS,
} from '@/lib/login-lockout';

describe('login lockout', () => {
  beforeEach(() => {
    _clearAllLoginAttempts();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports not locked for a fresh account', () => {
    expect(isAccountLockedOut('alice')).toEqual({ locked: false });
  });

  it('locks after MAX_FAILURES consecutive failures', () => {
    for (let i = 0; i < LOCKOUT_LIMITS.LOCKOUT_MAX_FAILURES - 1; i++) {
      expect(recordFailedLogin('alice')).toEqual({ locked: false });
    }
    const final = recordFailedLogin('alice');
    expect(final.locked).toBe(true);
    if (final.locked) {
      expect(final.retryAfterMs).toBeGreaterThan(0);
    }
    expect(isAccountLockedOut('alice').locked).toBe(true);
  });

  it('treats usernames case-insensitively', () => {
    for (let i = 0; i < LOCKOUT_LIMITS.LOCKOUT_MAX_FAILURES; i++) {
      recordFailedLogin('Alice');
    }
    expect(isAccountLockedOut('ALICE').locked).toBe(true);
    expect(isAccountLockedOut('alice').locked).toBe(true);
  });

  it('clearLoginAttempts removes the lockout', () => {
    for (let i = 0; i < LOCKOUT_LIMITS.LOCKOUT_MAX_FAILURES; i++) {
      recordFailedLogin('alice');
    }
    expect(isAccountLockedOut('alice').locked).toBe(true);
    clearLoginAttempts('alice');
    expect(isAccountLockedOut('alice')).toEqual({ locked: false });
  });

  it('expires after LOCKOUT_DURATION_MS', () => {
    for (let i = 0; i < LOCKOUT_LIMITS.LOCKOUT_MAX_FAILURES; i++) {
      recordFailedLogin('alice');
    }
    expect(isAccountLockedOut('alice').locked).toBe(true);

    vi.advanceTimersByTime(LOCKOUT_LIMITS.LOCKOUT_DURATION_MS + 1000);
    expect(isAccountLockedOut('alice')).toEqual({ locked: false });
  });

  it('locks separately per username', () => {
    for (let i = 0; i < LOCKOUT_LIMITS.LOCKOUT_MAX_FAILURES; i++) {
      recordFailedLogin('alice');
    }
    expect(isAccountLockedOut('alice').locked).toBe(true);
    expect(isAccountLockedOut('bob')).toEqual({ locked: false });
  });

  it('rolling window resets when no failures inside window', () => {
    recordFailedLogin('alice');
    recordFailedLogin('alice');
    vi.advanceTimersByTime(LOCKOUT_LIMITS.LOCKOUT_WINDOW_MS + 1000);
    // Next failure starts a fresh window — should NOT immediately lock.
    expect(recordFailedLogin('alice')).toEqual({ locked: false });
  });

  it('returns same lockedUntil even with extra attempts during lockout', () => {
    for (let i = 0; i < LOCKOUT_LIMITS.LOCKOUT_MAX_FAILURES; i++) {
      recordFailedLogin('alice');
    }
    const first = recordFailedLogin('alice');
    expect(first.locked).toBe(true);
    vi.advanceTimersByTime(60_000);
    const second = recordFailedLogin('alice');
    expect(second.locked).toBe(true);
    if (first.locked && second.locked) {
      // second should be ~60s sooner — lockout doesn't extend on extra hits
      expect(second.retryAfterMs).toBeLessThan(first.retryAfterMs);
    }
  });

  it('no-ops on empty username', () => {
    expect(isAccountLockedOut('')).toEqual({ locked: false });
    expect(recordFailedLogin('')).toEqual({ locked: false });
  });
});
