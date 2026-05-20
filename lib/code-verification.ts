// ============================================================================
// Code Verification Helpers — constant-time compare + DB-backed attempt limiter
// Shared by actions/auth.ts and actions/profile.ts (F2 / Simplify #2).
// C15H/M4: attempt counter persists in Postgres so it survives serverless
// restarts and scales across instances.
// ============================================================================

import crypto from 'crypto';
import { createAdminClient } from './supabase-server';

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

const CODE_ATTEMPT_WINDOW_SECONDS = 15 * 60; // matches the 15-min code TTL
const CODE_MAX_ATTEMPTS = 5;

/**
 * Returns true if the attempt should proceed, false if `key` has exceeded
 * CODE_MAX_ATTEMPTS inside CODE_ATTEMPT_WINDOW_SECONDS. Each call increments
 * the counter atomically via the incr_code_attempt RPC.
 *
 * On any DB error we fail-open (return true). The 6-digit code itself plus
 * the per-account login lockout (C3H) provide the actual brute-force defense;
 * this counter is a defense-in-depth layer, not the sole gate.
 */
export async function checkCodeAttempts(key: string): Promise<boolean> {
  try {
    const supabase = createAdminClient();
    const { data, error } = await supabase.rpc('incr_code_attempt', {
      p_key: key,
      p_window_seconds: CODE_ATTEMPT_WINDOW_SECONDS,
      p_max: CODE_MAX_ATTEMPTS,
    });
    if (error) {
      console.error('incr_code_attempt failed:', error.message);
      return true;
    }
    const row = Array.isArray(data) ? data[0] : data;
    return row?.allowed !== false;
  } catch (e) {
    console.error('checkCodeAttempts threw:', e);
    return true;
  }
}

/** Drop the attempt counter for a key after a successful verification. */
export async function resetCodeAttempts(key: string): Promise<void> {
  try {
    const supabase = createAdminClient();
    await supabase.rpc('clear_code_attempt', { p_key: key });
  } catch (e) {
    console.error('resetCodeAttempts threw:', e);
  }
}
