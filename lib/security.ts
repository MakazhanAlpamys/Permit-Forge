// ============================================================================
// Security Utilities (Server-side only)
// ============================================================================
// Common security functions for Server Actions and API Routes
// ============================================================================

import { getQuickSession, logAuditEvent, getRequestMetadata, validateCSRFToken } from '@/lib/auth';
import { createAdminClient, checkRateLimit } from '@/lib/supabase-server';

/**
 * Per-action rate-limit gate (C8H/H11). Wraps the existing user-keyed
 * checkRateLimit RPC. The `action` label is captured for telemetry / future
 * per-endpoint buckets (C22H) but is otherwise ignored today — every action
 * shares one user-keyed bucket, which is strictly safer than "no limit".
 */
export async function requireActionRateLimit(
  userId: string,
  action: string,
): Promise<{ allowed: boolean; error?: string }> {
  const r = await checkRateLimit(userId);
  if (r.allowed) return { allowed: true };
  return {
    allowed: false,
    error: `Too many requests (${action}). Please slow down.`,
  };
}

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface AuthenticatedUser {
  id: string;
  username: string;
  role: 'admin' | 'user';
}

export interface SecurityCheckResult {
  success: boolean;
  user?: AuthenticatedUser;
  error?: string;
}

// -----------------------------------------------------------------------------
// Authentication Check
// -----------------------------------------------------------------------------

/**
 * Verify user is authenticated
 * Returns user data or error
 */
export async function requireAuth(): Promise<SecurityCheckResult> {
  try {
    const user = await getQuickSession();
    
    if (!user) {
      return {
        success: false,
        error: 'Authentication required'
      };
    }

    // Verify user is not blocked (JWT alone doesn't reflect current block status)
    const supabase = createAdminClient();
    const { data: dbUser } = await supabase
      .from('users')
      .select('blocked')
      .eq('id', user.id)
      .single();

    if (dbUser?.blocked) {
      return {
        success: false,
        error: 'Your account has been blocked',
      };
    }

    return {
      success: true,
      user
    };
  } catch (error) {
    console.error('Auth check error:', error);
    return { 
      success: false, 
      error: 'Authentication failed' 
    };
  }
}

// -----------------------------------------------------------------------------
// Admin Authorization Check
// -----------------------------------------------------------------------------

/**
 * Verify user is authenticated AND has admin role
 * Logs unauthorized attempts
 */
export async function requireAdmin(): Promise<SecurityCheckResult> {
  const authResult = await requireAuth();
  
  if (!authResult.success || !authResult.user) {
    return authResult;
  }
  
  if (authResult.user.role !== 'admin') {
    // Log unauthorized admin access attempt
    try {
      const metadata = await getRequestMetadata();
      await logAuditEvent({
        userId: authResult.user.id,
        action: 'login_failed', // Using existing action type
        metadata: { 
          reason: 'unauthorized_admin_attempt',
          attemptedRole: 'admin',
          actualRole: authResult.user.role,
        },
        ...metadata,
      });
    } catch (e) {
      console.error('Failed to log security event:', e);
    }
    
    return { 
      success: false, 
      error: 'Unauthorized: Admin access required' 
    };
  }
  
  return authResult;
}

// -----------------------------------------------------------------------------
// CSRF Validation
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Ownership check
// -----------------------------------------------------------------------------

/**
 * Generic "does row {table}({idColumn}={recordId}) belong to {userId}?" check.
 * Used to gate server actions on per-row ownership when the row also carries a
 * `user_id` FK. Returns false for any error (validation, DB, missing row) so
 * callers can fall through to a generic "access denied" path without leaking
 * which case fired. (F6 / Simplify #6)
 *
 * Skips records where the `idColumn` value isn't a valid UUID — callers should
 * not be passing arbitrary strings here, and a regex check up front is cheaper
 * than a roundtrip to Postgres that would also reject the value.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function verifyOwnership(
  table: string,
  idColumn: string,
  recordId: string,
  userId: string,
): Promise<boolean> {
  if (!UUID_RE.test(recordId)) return false;

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from(table)
    .select('user_id')
    .eq(idColumn, recordId)
    .single();

  if (error || !data) return false;
  return (data as { user_id: string }).user_id === userId;
}

/**
 * Validate CSRF token from client.
 * Returns { valid: true } or { valid: false, error: string }
 */
export async function requireCSRF(token: string | undefined | null): Promise<{ valid: boolean; error?: string }> {
  if (!token) {
    return { valid: false, error: 'CSRF token missing' };
  }

  const isValid = await validateCSRFToken(token);
  if (!isValid) {
    return { valid: false, error: 'CSRF token invalid' };
  }

  return { valid: true };
}
