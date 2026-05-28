'use server';

// ============================================================================
// Authentication Server Actions (with JWT, CSRF, and Audit Logging)
// ============================================================================

import { createAdminClient } from '@/lib/supabase-server';
import {
  verifyPassword,
  hashPassword,
  createSession,
  destroySession,
  generateCSRFToken,
  logAuditEvent,
  logAuditWithMeta,
  getQuickSession
} from '@/lib/auth';
import {
  loginSchema,
  registerSchema,
  verifyEmailSchema,
  forgotPasswordSchema,
  resetPasswordSchema
} from '@/lib/validations';
import { redirect } from 'next/navigation';
import { getRequestMetadata, getCSRFToken } from '@/lib/auth';
import { requireCSRF } from '@/lib/security';
import { generateSixDigitCode, sendVerificationEmail, sendPasswordResetEmail } from '@/lib/email';
import { safeEqual, checkCodeAttempts, resetCodeAttempts } from '@/lib/code-verification';
import {
  isAccountLockedOut,
  recordFailedLogin,
  clearLoginAttempts,
} from '@/lib/login-lockout';

const LOGIN_WINDOW_SECONDS = 60;
const LOGIN_MAX_ATTEMPTS = 10;

// DB-backed IP rate limiter (works in serverless/multi-instance environments)
// Uses the ip_rate_limits table via check_ip_rate_limit() RPC (migration 001)
async function checkLoginRateLimit(ip: string): Promise<boolean> {
  try {
    const supabase = createAdminClient();
    const { data, error } = await supabase.rpc('check_ip_rate_limit', {
      p_ip: ip,
      p_window_seconds: LOGIN_WINDOW_SECONDS,
      p_max_requests: LOGIN_MAX_ATTEMPTS,
    });
    if (error) {
      // Fail-open: allow the request if the DB check fails to avoid lockouts
      console.error('IP rate limit check error:', error.message);
      return true;
    }
    return data?.[0]?.allowed ?? true;
  } catch {
    return true; // Fail-open
  }
}

// -----------------------------------------------------------------------------
// Login Action
// -----------------------------------------------------------------------------

export async function loginAction(
  formData: FormData,
): Promise<{ success?: boolean; role?: 'admin' | 'user'; error?: string }> {
  const metadata = await getRequestMetadata();
  
  try {
    // Rate limit by IP to prevent brute force attacks (in-memory, not DB)
    if (!await checkLoginRateLimit(metadata.ipAddress || 'unknown')) {
      return { error: 'Too many login attempts. Please try again later.' };
    }

    const username = formData.get('username') as string;
    const password = formData.get('password') as string;

    // Validate input with Zod
    const validation = loginSchema.safeParse({ username, password });
    if (!validation.success) {
      await logAuditEvent({
        action: 'login_failed',
        metadata: { reason: 'validation_failed', username },
        ...metadata,
      });
      return { error: validation.error.issues[0].message };
    }

    // C3H/H4: per-account lockout (defense-in-depth on top of IP limiter).
    // Checked BEFORE the DB lookup / bcrypt so a locked account skips the
    // expensive password verification entirely.
    const lockState = isAccountLockedOut(validation.data.username);
    if (lockState.locked) {
      await logAuditEvent({
        action: 'login_failed',
        metadata: {
          reason: 'account_locked',
          username: validation.data.username,
          retryAfterSec: Math.ceil(lockState.retryAfterMs / 1000),
        },
        ...metadata,
      });
      return {
        error: 'Too many failed attempts. Please try again in a few minutes.',
      };
    }

    // Use admin client for login - anon key doesn't have access to users table
    const supabase = createAdminClient();

    // Find user by username
    const { data: user, error } = await supabase
      .from('users')
      .select('id, username, password_hash, role, blocked, email, email_verified, token_version')
      .eq('username', validation.data.username)
      .single();

    if (error || !user) {
      recordFailedLogin(validation.data.username);
      await logAuditEvent({
        action: 'login_failed',
        metadata: { reason: 'user_not_found', username: validation.data.username },
        ...metadata,
      });
      return { error: 'Invalid username or password' };
    }

    // Check if user is blocked
    if (user.blocked) {
      await logAuditEvent({
        action: 'login_failed',
        userId: user.id,
        metadata: { reason: 'user_blocked' },
        ...metadata,
      });
      return { error: 'Your account has been blocked. Please contact an administrator.' };
    }

    // Check if email is verified (only for self-registered users who have an email)
    // Admin-created users without email can still log in
    if (user.email && user.email_verified === false) {
      return { error: 'Please verify your email before signing in.' };
    }

    // Verify password using bcrypt
    const isValidPassword = await verifyPassword(validation.data.password, user.password_hash);
    
    if (!isValidPassword) {
      const failState = recordFailedLogin(validation.data.username);
      await logAuditEvent({
        action: 'login_failed',
        userId: user.id,
        metadata: {
          reason: 'invalid_password',
          ...(failState.locked
            ? { lockedOut: true, retryAfterSec: Math.ceil(failState.retryAfterMs / 1000) }
            : {}),
        },
        ...metadata,
      });
      return { error: 'Invalid username or password' };
    }

    // Success — drop the lockout counter so the next failure starts fresh.
    clearLoginAttempts(validation.data.username);

    // Update last login
    await supabase
      .from('users')
      .update({ last_login: new Date().toISOString() })
      .eq('id', user.id);

    // Create JWT session
    await createSession({
      id: user.id,
      username: user.username,
      role: user.role as 'admin' | 'user',
      tokenVersion: (user as { token_version?: number }).token_version ?? 0,
    });

    // Generate CSRF token
    await generateCSRFToken();

    // Log successful login
    await logAuditEvent({
      userId: user.id,
      action: 'login_success',
      ...metadata,
    });

    // Return success + role and let the client navigate. Calling redirect()
    // here threw NEXT_REDIRECT, which the login page's await/try-catch caught
    // and rendered as a one-frame "login failed" banner before the navigation
    // committed. Client-side navigation has no such race.
    return { success: true, role: user.role as 'admin' | 'user' };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'An error occurred during login';
    console.error('Login error:', errorMessage);
    return { error: 'Login failed. Please try again.' };
  }
}

// -----------------------------------------------------------------------------
// Logout Action
// -----------------------------------------------------------------------------

export async function logoutAction(formData?: FormData): Promise<void> {
  // C20H: require a CSRF token on logout so a cross-site form post can't
  // force a victim to be logged out (denial of service / session fixation
  // setup). On a CSRF failure we still proceed — destroying the session is
  // strictly safer than leaving it open, and the redirect path stays the
  // same. The audit log captures the bypass attempt.
  const csrfFromForm = formData?.get('csrfToken');
  const csrfToken = typeof csrfFromForm === 'string' ? csrfFromForm : null;
  const csrf = await requireCSRF(csrfToken);

  const user = await getQuickSession();
  const metadata = await getRequestMetadata();

  if (user) {
    // v1.1 Part B (S-M / logout): bump users.token_version BEFORE clearing
    // the cookie so any JWT still cached on another tab/device fails its
    // next middleware tv-check and is forced to /login. Without this an
    // attacker who copied the JWT before logout retains access for up to
    // SESSION_MAX_AGE (7 days) on the API surface and until block-cache
    // expiry (30s) on page nav.
    //
    // Failure-tolerant: if the RPC errors we still destroy the cookie —
    // a half-completed logout is strictly safer than refusing to log out.
    try {
      const supabase = createAdminClient();
      const { error } = await supabase.rpc('bump_user_token_version', { p_user_id: user.id });
      if (error) {
        console.error('logoutAction: token_version bump failed:', error.message);
      }
    } catch (e) {
      console.error('logoutAction: token_version bump threw:', e);
    }

    await logAuditEvent({
      userId: user.id,
      action: 'logout',
      metadata: csrf.valid ? undefined : { csrf: 'invalid_or_missing' },
      ...metadata,
    });
  }

  await destroySession();
  redirect('/login');
}

// -----------------------------------------------------------------------------
// Get CSRF Token (for client-side forms and API calls)
// -----------------------------------------------------------------------------

export async function getCSRFTokenAction(): Promise<string | null> {
  const user = await getQuickSession();
  if (!user) return null;
  return getCSRFToken();
}

// -----------------------------------------------------------------------------
// Registration Action
// -----------------------------------------------------------------------------

const CODE_EXPIRY_MINUTES = 15;

export async function registerAction(formData: FormData): Promise<{ error?: string; success?: boolean }> {
  const metadata = await getRequestMetadata();

  try {
    if (!await checkLoginRateLimit(metadata.ipAddress || 'unknown')) {
      return { error: 'Too many attempts. Please try again later.' };
    }

    const username = formData.get('username') as string;
    const email = formData.get('email') as string;
    const password = formData.get('password') as string;

    const validation = registerSchema.safeParse({ username, email, password });
    if (!validation.success) {
      return { error: validation.error.issues[0].message };
    }

    const supabase = createAdminClient();

    // Check if username already exists
    const { data: existingUser } = await supabase
      .from('users')
      .select('id')
      .eq('username', validation.data.username)
      .single();

    if (existingUser) {
      return { error: 'Username is already taken' };
    }

    // Check if email already exists
    const { data: existingEmail } = await supabase
      .from('users')
      .select('id')
      .eq('email', validation.data.email)
      .single();

    if (existingEmail) {
      return { error: 'Email is already registered' };
    }

    const password_hash = await hashPassword(validation.data.password);
    const code = generateSixDigitCode();
    const expiresAt = new Date(Date.now() + CODE_EXPIRY_MINUTES * 60 * 1000).toISOString();

    const { error: insertError } = await supabase.from('users').insert({
      username: validation.data.username,
      email: validation.data.email,
      password_hash,
      role: 'user',
      email_verified: false,
      verification_code: code,
      code_expires_at: expiresAt,
    });

    if (insertError) {
      console.error('Registration insert error:', insertError.message);
      return { error: 'Registration failed. Please try again.' };
    }

    const emailSent = await sendVerificationEmail(validation.data.email, code);
    if (!emailSent) {
      // Roll back the user creation so they don't end up with an unverifiable account
      await supabase.from('users').delete().eq('email', validation.data.email);
      return { error: 'Failed to send verification email. Please try again.' };
    }

    await logAuditEvent({
      action: 'user_created',
      metadata: { username: validation.data.username, email: validation.data.email, self_registered: true },
      ...metadata,
    });

    return { success: true };
  } catch (error) {
    console.error('Registration error:', error);
    return { error: 'Registration failed. Please try again.' };
  }
}

// -----------------------------------------------------------------------------
// SIM-H-8 / v1.8.0 Part D — shared "verify a 6-digit code" pipeline.
// -----------------------------------------------------------------------------
// verifyEmailAction and resetPasswordAction had the same ~30-line block:
// look up user → check the code column + expiry → run the brute-force
// attempt limiter → constant-time compare → clear-on-too-many-attempts.
// Only the column names + attempt-key prefix differed. This helper unifies
// the pipeline so the two callers only own the "what to mutate on success"
// part (email_verified=true vs password_hash=...).

interface VerifyAndConsumeCodeOptions {
  /** Column on `users` holding the bcrypt'd 6-digit code. */
  codeColumn: 'verification_code' | 'reset_code';
  /** Column on `users` holding the code's expiry timestamp. */
  expiryColumn: 'code_expires_at' | 'reset_code_expires_at';
  /** Prefix for the per-email attempt counter ('verify:' or 'reset:'). */
  attemptKeyPrefix: 'verify' | 'reset';
  /** Pre-baked user-facing error copy so each caller keeps its own phrasing. */
  errorCopy: {
    userNotFound: string;
    noCode: string;
    expired: string;
    tooManyAttempts: string;
    invalid: string;
  };
  /** Optional pre-check (e.g. "email already verified") run AFTER the user fetch. */
  precheck?: (user: Record<string, unknown>) => string | undefined;
}

interface VerifyAndConsumeCodeSuccess {
  user: { id: string; [k: string]: unknown };
  attemptKey: string;
}

async function verifyAndConsumeCode(
  email: string,
  code: string,
  opts: VerifyAndConsumeCodeOptions,
): Promise<{ success: true; data: VerifyAndConsumeCodeSuccess } | { success: false; error: string }> {
  const supabase = createAdminClient();

  // Select id + email_verified (verifyEmail precheck reads it) + the two
  // dynamic columns. PostgREST is happy with literal column names here.
  const selectColumns = `id, email_verified, ${opts.codeColumn}, ${opts.expiryColumn}`;

  const { data, error } = await supabase
    .from('users')
    .select(selectColumns)
    .eq('email', email)
    .single();

  // The dynamic .select() loses PostgREST's static row typing, so we narrow
  // back to a Record at the boundary.
  const user = data as unknown as Record<string, unknown> | null;

  if (error || !user) {
    return { success: false, error: opts.errorCopy.userNotFound };
  }

  if (opts.precheck) {
    const precheckErr = opts.precheck(user);
    if (precheckErr) {
      return { success: false, error: precheckErr };
    }
  }

  const codeValue = user[opts.codeColumn] as string | null | undefined;
  const expiryValue = user[opts.expiryColumn] as string | null | undefined;

  if (!codeValue || !expiryValue) {
    return { success: false, error: opts.errorCopy.noCode };
  }

  if (new Date(expiryValue) < new Date()) {
    return { success: false, error: opts.errorCopy.expired };
  }

  // Brute-force protection: max 5 attempts per email within the code TTL window.
  const attemptKey = `${opts.attemptKeyPrefix}:${email}`;
  // v1.8.0 re-audit Medium-2: a future edit to `selectColumns` that drops
  // `id` would silently turn `.eq('id', undefined)` into a zero-row UPDATE
  // and leave the attacker's code in place. Hard fail at the boundary
  // instead of trusting the dynamic select.
  const userId = user.id;
  if (typeof userId !== 'string' || userId.length === 0) {
    return { success: false, error: opts.errorCopy.userNotFound };
  }
  if (!(await checkCodeAttempts(attemptKey))) {
    // Invalidate the code so the attacker must trigger a new one.
    await supabase
      .from('users')
      .update({ [opts.codeColumn]: null, [opts.expiryColumn]: null })
      .eq('id', userId);
    return { success: false, error: opts.errorCopy.tooManyAttempts };
  }

  if (!safeEqual(codeValue, code)) {
    return { success: false, error: opts.errorCopy.invalid };
  }

  return {
    success: true,
    data: { user: { ...user, id: userId }, attemptKey },
  };
}

// -----------------------------------------------------------------------------
// Email Verification Action
// -----------------------------------------------------------------------------

export async function verifyEmailAction(
  email: string,
  code: string
): Promise<{ error?: string; success?: boolean }> {
  try {
    const validation = verifyEmailSchema.safeParse({ email, code });
    if (!validation.success) {
      return { error: validation.error.issues[0].message };
    }

    const verifyResult = await verifyAndConsumeCode(
      validation.data.email,
      validation.data.code,
      {
        codeColumn: 'verification_code',
        expiryColumn: 'code_expires_at',
        attemptKeyPrefix: 'verify',
        errorCopy: {
          userNotFound: 'User not found',
          noCode: 'No verification code found. Please register again.',
          expired: 'Verification code has expired. Please register again.',
          tooManyAttempts: 'Too many failed attempts. Please request a new verification code.',
          invalid: 'Invalid verification code',
        },
        precheck: (u) => (u.email_verified ? 'Email is already verified' : undefined),
      },
    );

    if (!verifyResult.success) {
      return { error: verifyResult.error };
    }

    const supabase = createAdminClient();
    const { error: updateError } = await supabase
      .from('users')
      .update({
        email_verified: true,
        verification_code: null,
        code_expires_at: null,
      })
      .eq('id', verifyResult.data.user.id);

    if (updateError) {
      return { error: 'Verification failed. Please try again.' };
    }

    await resetCodeAttempts(verifyResult.data.attemptKey);
    return { success: true };
  } catch (error) {
    console.error('Email verification error:', error);
    return { error: 'Verification failed. Please try again.' };
  }
}

// -----------------------------------------------------------------------------
// CP-E-1 (v1.2.0 Part E): resend verification code.
// -----------------------------------------------------------------------------
// Issue: when the verification code expired or got lost in spam, the user
// had no way to refresh it from the verify-email screen — they had to
// re-register, which was confusing and triggered duplicate-email errors.
//
// This action re-mints the 6-digit code for an existing (unverified) email,
// gated by the same IP rate limit as login/register so we can't be abused
// to spam someone's inbox. Email enumeration is preserved by always
// returning success; the caller cannot distinguish "no such user" from
// "code re-sent".

export async function resendVerificationCodeAction(
  email: string
): Promise<{ error?: string; success?: boolean }> {
  const metadata = await getRequestMetadata();

  try {
    if (!await checkLoginRateLimit(metadata.ipAddress || 'unknown')) {
      return { error: 'Too many attempts. Please try again later.' };
    }

    const validation = forgotPasswordSchema.safeParse({ email });
    if (!validation.success) {
      return { error: validation.error.issues[0].message };
    }

    const supabase = createAdminClient();

    const { data: user } = await supabase
      .from('users')
      .select('id, email, email_verified, blocked')
      .eq('email', validation.data.email)
      .single();

    // Always-success path to preserve email enumeration safety.
    if (!user || user.blocked || user.email_verified) {
      return { success: true };
    }

    const code = generateSixDigitCode();
    const expiresAt = new Date(Date.now() + CODE_EXPIRY_MINUTES * 60 * 1000).toISOString();

    await supabase
      .from('users')
      .update({ verification_code: code, code_expires_at: expiresAt })
      .eq('id', user.id);

    await sendVerificationEmail(user.email, code);

    await logAuditEvent({
      userId: user.id,
      action: 'user_updated',
      metadata: { reason: 'verification_code_resent' },
      ...metadata,
    });

    return { success: true };
  } catch (error) {
    console.error('Resend verification code error:', error);
    return { error: 'Something went wrong. Please try again.' };
  }
}

// -----------------------------------------------------------------------------
// Forgot Password Action
// -----------------------------------------------------------------------------

export async function forgotPasswordAction(
  email: string
): Promise<{ error?: string; success?: boolean }> {
  const metadata = await getRequestMetadata();

  try {
    if (!await checkLoginRateLimit(metadata.ipAddress || 'unknown')) {
      return { error: 'Too many attempts. Please try again later.' };
    }

    const validation = forgotPasswordSchema.safeParse({ email });
    if (!validation.success) {
      return { error: validation.error.issues[0].message };
    }

    const supabase = createAdminClient();

    const { data: user } = await supabase
      .from('users')
      .select('id, email, blocked, email_verified')
      .eq('email', validation.data.email)
      .single();

    // Always return success to prevent email enumeration
    if (!user || user.blocked || !user.email_verified) {
      return { success: true };
    }

    const code = generateSixDigitCode();
    const expiresAt = new Date(Date.now() + CODE_EXPIRY_MINUTES * 60 * 1000).toISOString();

    await supabase
      .from('users')
      .update({
        reset_code: code,
        reset_code_expires_at: expiresAt,
      })
      .eq('id', user.id);

    // A-H-6 / v1.7.0 Part D: inspect the SMTP result. Pre-v1.7 we fired and
    // forgot — a SMTP-down window left users staring at "code sent" with no
    // code arriving, with a live reset_code in the DB that an attacker who
    // later compromised the table could redeem. Failure path: wipe the
    // reset_code so the half-completed reset can't be exploited, and surface
    // an error so the user retries (instead of waiting forever).
    //
    // Email enumeration safety is preserved by the no-such-user / blocked /
    // unverified branch above (always-success). Reaching this point means
    // we already confirmed the account exists for this email.
    const emailSent = await sendPasswordResetEmail(user.email, code);
    if (!emailSent) {
      await supabase
        .from('users')
        .update({ reset_code: null, reset_code_expires_at: null })
        .eq('id', user.id);
      return { error: 'Failed to send reset email. Please try again in a few minutes.' };
    }

    return { success: true };
  } catch (error) {
    console.error('Forgot password error:', error);
    return { error: 'Something went wrong. Please try again.' };
  }
}

// -----------------------------------------------------------------------------
// Reset Password Action
// -----------------------------------------------------------------------------

export async function resetPasswordAction(
  email: string,
  code: string,
  newPassword: string
): Promise<{ error?: string; success?: boolean }> {
  try {
    const validation = resetPasswordSchema.safeParse({ email, code, newPassword });
    if (!validation.success) {
      return { error: validation.error.issues[0].message };
    }

    const verifyResult = await verifyAndConsumeCode(
      validation.data.email,
      validation.data.code,
      {
        codeColumn: 'reset_code',
        expiryColumn: 'reset_code_expires_at',
        attemptKeyPrefix: 'reset',
        errorCopy: {
          userNotFound: 'Invalid request',
          noCode: 'No reset code found. Please request a new one.',
          expired: 'Reset code has expired. Please request a new one.',
          tooManyAttempts: 'Too many failed attempts. Please request a new reset code.',
          invalid: 'Invalid reset code',
        },
      },
    );

    if (!verifyResult.success) {
      return { error: verifyResult.error };
    }

    const userId = verifyResult.data.user.id;
    const password_hash = await hashPassword(validation.data.newPassword);

    const supabase = createAdminClient();
    const { error: updateError } = await supabase
      .from('users')
      .update({
        password_hash,
        reset_code: null,
        reset_code_expires_at: null,
      })
      .eq('id', userId);

    if (updateError) {
      return { error: 'Password reset failed. Please try again.' };
    }

    // C14H: bump token_version so any device still holding the old JWT is
    // logged out at its next middleware hop.
    await supabase.rpc('bump_user_token_version', { p_user_id: userId });

    await resetCodeAttempts(verifyResult.data.attemptKey);

    await logAuditWithMeta(userId, 'password_reset', {
      metadata: { method: 'email_code' },
    });

    return { success: true };
  } catch (error) {
    console.error('Reset password error:', error);
    return { error: 'Password reset failed. Please try again.' };
  }
}
