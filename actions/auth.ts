'use server';

// ============================================================================
// Authentication Server Actions (with JWT, CSRF, and Audit Logging)
// ============================================================================

import crypto from 'crypto';
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
import { generateSixDigitCode, sendVerificationEmail, sendPasswordResetEmail } from '@/lib/email';

const LOGIN_WINDOW_SECONDS = 60;
const LOGIN_MAX_ATTEMPTS = 10;

/** Constant-time string comparison to prevent timing side-channel attacks on short codes */
function safeEqual(a: string, b: string): boolean {
  // Pad both to equal length before comparing (prevents length oracle)
  const maxLen = Math.max(a.length, b.length);
  const bufA = Buffer.alloc(maxLen);
  const bufB = Buffer.alloc(maxLen);
  bufA.write(a);
  bufB.write(b);
  return crypto.timingSafeEqual(bufA, bufB);
}

// In-memory code attempt tracker (keyed by "verify:<email>" or "reset:<email>")
// Prevents brute-force of 6-digit codes (1,000,000 possibilities / 5 tries = lockout)
const codeAttempts = new Map<string, { count: number; firstAttempt: number }>();
const CODE_ATTEMPT_WINDOW_MS = 15 * 60 * 1000; // 15 min (matches code TTL)
const CODE_MAX_ATTEMPTS = 5;

function checkCodeAttempts(key: string): boolean {
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

function resetCodeAttempts(key: string): void {
  codeAttempts.delete(key);
}

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

    // Use admin client for login - anon key doesn't have access to users table
    const supabase = createAdminClient();

    // Find user by username
    const { data: user, error } = await supabase
      .from('users')
      .select('id, username, password_hash, role, blocked, email, email_verified')
      .eq('username', validation.data.username)
      .single();

    if (error || !user) {
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
      await logAuditEvent({
        action: 'login_failed',
        userId: user.id,
        metadata: { reason: 'invalid_password' },
        ...metadata,
      });
      return { error: 'Invalid username or password' };
    }

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

export async function logoutAction(): Promise<void> {
  const user = await getQuickSession();
  const metadata = await getRequestMetadata();

  if (user) {
    await logAuditEvent({
      userId: user.id,
      action: 'logout',
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
    if (!checkCodeAttempts(attemptKey)) {
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

    resetCodeAttempts(attemptKey);
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
    if (!checkCodeAttempts(resetAttemptKey)) {
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

    resetCodeAttempts(resetAttemptKey);

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
