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
  /**
   * CP-C-1 / v1.1.0 Part A: users.token_version snapshot from the verified JWT.
   * Callers that mint a replacement JWT (e.g. updateProfileAction after a
   * username change) MUST forward this value so the new token's `tv` claim
   * matches the DB; otherwise the next middleware hop sees `tv < db.tv` and
   * logs the user out.
   */
  tokenVersion?: number;
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
 *
 * AUTH-C1 / v1.0.0 Part E: the Edge middleware re-checks JWT.tv against
 * users.token_version on every page nav, but its matcher excludes `/api/*`.
 * Every API route boots through `requireAuth`, so the same comparison happens
 * here on the same DB hop that already reads `blocked` (no extra round-trip).
 * If `tv < users.token_version` the session has been revoked
 * (admin password reset, role change, forced logout) and we reject — without
 * this a stolen JWT survives on the API surface for the full 7-day expiry.
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

    // Verify user is not blocked AND JWT.tv hasn't been left behind by an
    // admin-side token_version bump. JWT alone doesn't reflect either.
    const supabase = createAdminClient();
    const { data: dbUser } = await supabase
      .from('users')
      .select('blocked, token_version')
      .eq('id', user.id)
      .single();

    if (dbUser?.blocked) {
      return {
        success: false,
        error: 'Your account has been blocked',
      };
    }

    const dbTokenVersion: number =
      typeof (dbUser as { token_version?: number } | null | undefined)?.token_version === 'number'
        ? (dbUser as { token_version: number }).token_version
        : 0;
    // v1.1.0 Part C re-audit M1: defensive `?? 0`. Today getQuickSession()
    // always returns tokenVersion: number, but AuthenticatedUser declares it
    // optional. Without this guard `undefined < N` evaluates to false (JS
    // coercion rules) — a silent fail-open if a future caller ever constructs
    // an AuthenticatedUser without the field and reuses this comparison.
    if ((user.tokenVersion ?? 0) < dbTokenVersion) {
      return {
        success: false,
        error: 'Session revoked',
      };
    }

    // CP-C-1: forward tokenVersion through so callers that mint replacement
    // JWTs (e.g. profile updates) can carry the correct `tv` claim. Without
    // this the new JWT defaults to tv=0 and the user is logged out on the
    // next middleware hop whenever DB.token_version > 0.
    return {
      success: true,
      user,
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
// withMutation — boilerplate-elimination wrapper (F1 / SIM-H-1 / R-H-2)
// -----------------------------------------------------------------------------

/**
 * Standard shape returned by every server-action mutation. Helper wraps:
 *   - requireAuth / requireAdmin gate
 *   - requireCSRF check
 *   - Optional Zod input validation
 *   - Optional per-action rate limit
 *   - try/catch with generic fail-safe error
 *
 * v1.8.0 Part A tightening (SIM-H-1 / R-H-2):
 *   - Return is a discriminated union: `{ success: true } & R` or
 *     `{ success: false; error: string }`. The handler's success-shape is
 *     FLATTENED into the result (was previously wrapped under `.data`), so
 *     adopting actions don't have to change their return contract.
 *   - Two explicit overloads make the schema-vs-no-schema distinction
 *     compile-checkable. With no schema the handler context has no `parsed`
 *     field; with schema, `parsed: T` is required and non-optional.
 */
export interface WithMutationOptionsBase {
  /** Require admin role. Defaults to false (any authenticated user). */
  admin?: boolean;
  /** CSRF token from the client (required). */
  csrfToken: string | undefined | null;
  /** Per-action rate-limit bucket (e.g. 'updatePermit'). */
  rateLimitAction?: string;
  /** Free-form error message for unexpected catch-all failures. */
  fallbackErrorMessage?: string;
}

export interface WithMutationOptionsWithSchema<T> extends WithMutationOptionsBase {
  /** Zod schema. The parsed value is passed to the handler as `parsed`. */
  schema: ZodSchema<T>;
  /** Raw input to validate. */
  input: unknown;
}

export type WithMutationOptions<T = never> =
  | WithMutationOptionsBase
  | WithMutationOptionsWithSchema<T>;

export type MutationOk<R extends object> = { success: true } & R;
export type MutationErr = { success: false; error: string };
export type MutationResult<R extends object = Record<string, never>> =
  | MutationOk<R>
  | MutationErr;

/**
 * v1.8.0 Part A: callers pick the schema-vs-no-schema variant by whether the
 * options object carries a `schema` key. Conditional `ctx` shape: with schema,
 * the handler context gains a typed `parsed: T`; without schema, it's just
 * `{ user }`.
 *
 * Discriminated union (single signature) — using overloads required widening
 * the impl return to `any`, defeating the typing tightening. The single
 * signature keeps narrowing at the handler boundary inside callers.
 */
export async function withMutation<
  R extends object = Record<string, never>,
  T = unknown,
>(
  options: WithMutationOptionsBase | WithMutationOptionsWithSchema<T>,
  handler: (
    ctx: { user: AuthenticatedUser; parsed: T },
  ) => Promise<R | MutationErr>,
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

    // Schema validation (when supplied). Discriminate via the `schema` key.
    let parsed: T = undefined as T;
    if ('schema' in options) {
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
    if (
      result !== null &&
      typeof result === 'object' &&
      'success' in result &&
      (result as { success?: unknown }).success === false
    ) {
      return result as MutationErr;
    }

    return { success: true, ...(result as R) };
  } catch (error) {
    console.error('withMutation caught error:', error);
    return {
      success: false,
      error: options.fallbackErrorMessage || 'Operation failed',
    };
  }
}
