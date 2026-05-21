// ============================================================================
// Security Utilities (Server-side only)
// ============================================================================
// Common security functions for Server Actions and API Routes
// ============================================================================

import { getQuickSession, logAuditEvent, getRequestMetadata, validateCSRFToken } from '@/lib/auth';
import { createAdminClient, checkRateLimit } from '@/lib/supabase-server';
import type { ZodSchema } from 'zod';

/**
 * Per-action rate-limit gate (C8H/H11). Each `action` gets its own bucket
 * (C11H/C22H) so a heavy endpoint can't starve unrelated user actions.
 */
export async function requireActionRateLimit(
  userId: string,
  action: string,
): Promise<{ allowed: boolean; error?: string }> {
  const r = await checkRateLimit(userId, { endpoint: action });
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
    // C28H/L3: log as permission_denied, not login_failed — escalation
    // attempts and bad-password retries are different signals and they
    // shouldn't share an event type.
    try {
      const metadata = await getRequestMetadata();
      await logAuditEvent({
        userId: authResult.user.id,
        action: 'permission_denied',
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

// -----------------------------------------------------------------------------
// withMutation — boilerplate-elimination wrapper (F1 / Simplify #1)
// -----------------------------------------------------------------------------

/**
 * Standard shape returned by every server-action mutation. Helper wraps:
 *   - requireAuth / requireAdmin gate
 *   - requireCSRF check
 *   - Optional Zod input validation
 *   - Optional per-action rate limit
 *   - try/catch with generic fail-safe error
 *
 * Use for any mutation that returns `{ success, error, ...rest }`. Query-style
 * actions returning `{ data, error }` should keep their bespoke shape.
 */
export interface WithMutationOptions<T> {
  /** Require admin role. Defaults to false (any authenticated user). */
  admin?: boolean;
  /** CSRF token from the client (required). */
  csrfToken: string | undefined | null;
  /** Optional Zod schema. The parsed value is passed to the handler. */
  schema?: ZodSchema<T>;
  /** Raw input to validate. Only used when `schema` is provided. */
  input?: unknown;
  /** Per-action rate-limit bucket (e.g. 'updatePermit'). */
  rateLimitAction?: string;
  /** Free-form error message for unexpected catch-all failures. */
  fallbackErrorMessage?: string;
}

export interface MutationResult<R extends object = object> {
  success: boolean;
  error?: string;
  data?: R;
}

export async function withMutation<T, R extends object = object>(
  options: WithMutationOptions<T>,
  handler: (ctx: { user: AuthenticatedUser; parsed: T }) => Promise<R | { success: false; error: string }>,
): Promise<MutationResult<R>> {
  try {
    // Auth gate
    const authCheck = options.admin ? await requireAdmin() : await requireAuth();
    if (!authCheck.success || !authCheck.user) {
      return { success: false, error: authCheck.error || 'Unauthorized' };
    }

    // CSRF gate
    const csrf = await requireCSRF(options.csrfToken);
    if (!csrf.valid) {
      return { success: false, error: csrf.error || 'CSRF token invalid' };
    }

    // Per-action rate limit
    if (options.rateLimitAction) {
      const rl = await requireActionRateLimit(authCheck.user.id, options.rateLimitAction);
      if (!rl.allowed) {
        return { success: false, error: rl.error || 'Too many requests' };
      }
    }

    // Schema validation (when supplied)
    let parsed: T = undefined as T;
    if (options.schema) {
      const validation = options.schema.safeParse(options.input);
      if (!validation.success) {
        return {
          success: false,
          error: validation.error.issues[0]?.message || 'Validation failed',
        };
      }
      parsed = validation.data as T;
    }

    const result = await handler({ user: authCheck.user, parsed });

    // Handlers may short-circuit with their own typed error result.
    if ('success' in result && result.success === false) {
      return { success: false, error: result.error };
    }

    return { success: true, data: result as R };
  } catch (error) {
    console.error('withMutation caught error:', error);
    return {
      success: false,
      error: options.fallbackErrorMessage || 'Operation failed',
    };
  }
}
