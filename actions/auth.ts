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

export async function loginAction(formData: FormData): Promise<{ error?: string }> {
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

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'An error occurred during login';
    console.error('Login error:', errorMessage);
    return { error: 'Login failed. Please try again.' };
  }

  redirect('/');
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

    const supabase = createAdminClient();

    const { data: user, error } = await supabase
      .from('users')
      .select('id, verification_code, code_expires_at, email_verified')
      .eq('email', validation.data.email)
      .single();

    if (error || !user) {
      return { error: 'User not found' };
    }

    if (user.email_verified) {
      return { error: 'Email is already verified' };
    }

    if (!user.verification_code || !user.code_expires_at) {
      return { error: 'No verification code found. Please register again.' };
    }

    if (new Date(user.code_expires_at) < new Date()) {
      return { error: 'Verification code has expired. Please register again.' };
    }

    // Brute-force protection: max 5 attempts per email within the code TTL window
    const attemptKey = `verify:${validation.data.email}`;
    if (!(await checkCodeAttempts(attemptKey))) {
      // Invalidate the code so attacker must trigger a new one
      await supabase
        .from('users')
        .update({ verification_code: null, code_expires_at: null })
        .eq('id', user.id);
      return { error: 'Too many failed attempts. Please request a new verification code.' };
    }

    if (!safeEqual(user.verification_code, validation.data.code)) {
      return { error: 'Invalid verification code' };
    }

    const { error: updateError } = await supabase
      .from('users')
      .update({
        email_verified: true,
        verification_code: null,
        code_expires_at: null,
      })
      .eq('id', user.id);

    if (updateError) {
      return { error: 'Verification failed. Please try again.' };
    }

    await resetCodeAttempts(attemptKey);
    return { success: true };
  } catch (error) {
    console.error('Email verification error:', error);
    return { error: 'Verification failed. Please try again.' };
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

    await sendPasswordResetEmail(user.email, code);

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

    const supabase = createAdminClient();

    const { data: user, error } = await supabase
      .from('users')
      .select('id, reset_code, reset_code_expires_at')
      .eq('email', validation.data.email)
      .single();

    if (error || !user) {
      return { error: 'Invalid request' };
    }

    if (!user.reset_code || !user.reset_code_expires_at) {
      return { error: 'No reset code found. Please request a new one.' };
    }

    if (new Date(user.reset_code_expires_at) < new Date()) {
      return { error: 'Reset code has expired. Please request a new one.' };
    }

    // Brute-force protection: max 5 attempts per email within the code TTL window
    const resetAttemptKey = `reset:${validation.data.email}`;
    if (!(await checkCodeAttempts(resetAttemptKey))) {
      // Invalidate the reset code so attacker must request a new one
      await supabase
        .from('users')
        .update({ reset_code: null, reset_code_expires_at: null })
        .eq('id', user.id);
      return { error: 'Too many failed attempts. Please request a new reset code.' };
    }

    if (!safeEqual(user.reset_code, validation.data.code)) {
      return { error: 'Invalid reset code' };
    }

    const password_hash = await hashPassword(validation.data.newPassword);

    const { error: updateError } = await supabase
      .from('users')
      .update({
        password_hash,
        reset_code: null,
        reset_code_expires_at: null,
      })
      .eq('id', user.id);

    if (updateError) {
      return { error: 'Password reset failed. Please try again.' };
    }

    // C14H: bump token_version so any device still holding the old JWT is
    // logged out at its next middleware hop.
    await supabase.rpc('bump_user_token_version', { p_user_id: user.id });

    await resetCodeAttempts(resetAttemptKey);

    const metadata = await getRequestMetadata();
    await logAuditEvent({
      userId: user.id,
      action: 'password_reset',
      metadata: { method: 'email_code' },
      ...metadata,
    });

    return { success: true };
  } catch (error) {
    console.error('Reset password error:', error);
    return { error: 'Password reset failed. Please try again.' };
  }
}
