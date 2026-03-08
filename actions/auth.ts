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
import { generateSixDigitCode, sendVerificationEmail, sendPasswordResetEmail } from '@/lib/email';

// In-memory login rate limiter (keyed by IP, not DB-backed)
// The DB check_rate_limit RPC requires a UUID user_id, which doesn't exist pre-login
const loginAttempts = new Map<string, { count: number; firstAttempt: number }>();
const LOGIN_WINDOW_MS = 60_000; // 1 minute
const LOGIN_MAX_ATTEMPTS = 10;

function checkLoginRateLimit(ip: string): boolean {
  const now = Date.now();

  // Periodically purge expired entries to prevent memory leak
  if (loginAttempts.size > 1000) {
    for (const [key, val] of loginAttempts) {
      if (now - val.firstAttempt > LOGIN_WINDOW_MS) {
        loginAttempts.delete(key);
      }
    }
  }

  const entry = loginAttempts.get(ip);
  if (!entry || now - entry.firstAttempt > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, firstAttempt: now });
    return true;
  }
  entry.count++;
  return entry.count <= LOGIN_MAX_ATTEMPTS;
}

// -----------------------------------------------------------------------------
// Login Action
// -----------------------------------------------------------------------------

export async function loginAction(formData: FormData): Promise<{ error?: string }> {
  const metadata = await getRequestMetadata();
  
  try {
    // Rate limit by IP to prevent brute force attacks (in-memory, not DB)
    if (!checkLoginRateLimit(metadata.ipAddress || 'unknown')) {
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
    if (!checkLoginRateLimit(metadata.ipAddress || 'unknown')) {
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

    await sendVerificationEmail(validation.data.email, code);

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

    if (user.verification_code !== validation.data.code) {
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
    if (!checkLoginRateLimit(metadata.ipAddress || 'unknown')) {
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
        code_expires_at: expiresAt,
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
      .select('id, reset_code, code_expires_at')
      .eq('email', validation.data.email)
      .single();

    if (error || !user) {
      return { error: 'Invalid request' };
    }

    if (!user.reset_code || !user.code_expires_at) {
      return { error: 'No reset code found. Please request a new one.' };
    }

    if (new Date(user.code_expires_at) < new Date()) {
      return { error: 'Reset code has expired. Please request a new one.' };
    }

    if (user.reset_code !== validation.data.code) {
      return { error: 'Invalid reset code' };
    }

    const password_hash = await hashPassword(validation.data.newPassword);

    const { error: updateError } = await supabase
      .from('users')
      .update({
        password_hash,
        reset_code: null,
        code_expires_at: null,
      })
      .eq('id', user.id);

    if (updateError) {
      return { error: 'Password reset failed. Please try again.' };
    }

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
