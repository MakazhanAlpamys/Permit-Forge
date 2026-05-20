'use server';

// ============================================================================
// Profile Server Actions (User profile management + password change via email)
// ============================================================================

import { createAdminClient } from '@/lib/supabase-server';
import { requireAuth, requireAdmin, requireCSRF } from '@/lib/security';
import { hashPassword, verifyPassword, logAuditEvent, getRequestMetadata, createSession } from '@/lib/auth';
import { updateProfileSchema, validatePassword } from '@/lib/validations';
import { generateSixDigitCode, sendPasswordChangeCodeEmail } from '@/lib/email';
import { safeEqual } from '@/lib/code-verification';

const CODE_EXPIRY_MINUTES = 15;

// -----------------------------------------------------------------------------
// Get Profile Data
// -----------------------------------------------------------------------------

export async function getProfileAction(): Promise<{
  error?: string;
  data?: { id: string; username: string; full_name: string | null; email: string | null; email_verified: boolean };
}> {
  const auth = await requireAuth();
  if (!auth.success || !auth.user) return { error: auth.error };

  const supabase = createAdminClient();
  const { data: user, error } = await supabase
    .from('users')
    .select('id, username, full_name, email, email_verified')
    .eq('id', auth.user.id)
    .single();

  if (error || !user) return { error: 'Failed to load profile' };
  return { data: user };
}

// -----------------------------------------------------------------------------
// Update Profile (username, full_name)
// -----------------------------------------------------------------------------

export async function updateProfileAction(
  formData: { username?: string; full_name?: string },
  csrfToken: string
): Promise<{ error?: string; success?: boolean }> {
  const auth = await requireAuth();
  if (!auth.success || !auth.user) return { error: auth.error };

  const csrf = await requireCSRF(csrfToken);
  if (!csrf.valid) return { error: csrf.error };

  const validation = updateProfileSchema.safeParse(formData);
  if (!validation.success) return { error: validation.error.issues[0].message };

  const updates: Record<string, string> = {};
  if (validation.data.username !== undefined) updates.username = validation.data.username;
  if (validation.data.full_name !== undefined) updates.full_name = validation.data.full_name;

  if (Object.keys(updates).length === 0) return { error: 'No changes to save' };

  const supabase = createAdminClient();

  // If username is changing, check uniqueness
  if (updates.username && updates.username !== auth.user.username) {
    const { data: existing } = await supabase
      .from('users')
      .select('id')
      .eq('username', updates.username)
      .single();

    if (existing) return { error: 'Username is already taken' };
  }

  const { error } = await supabase
    .from('users')
    .update(updates)
    .eq('id', auth.user.id);

  if (error) return { error: 'Failed to update profile' };

  // If username changed, update session (JWT)
  if (updates.username && updates.username !== auth.user.username) {
    await createSession({
      id: auth.user.id,
      username: updates.username,
      role: auth.user.role,
    });
  }

  const metadata = await getRequestMetadata();
  await logAuditEvent({
    userId: auth.user.id,
    action: 'user_updated',
    metadata: { fields: Object.keys(updates) },
    ...metadata,
  });

  return { success: true };
}

// -----------------------------------------------------------------------------
// Request Password Change Code (User — sends code to email)
// -----------------------------------------------------------------------------

export async function requestPasswordChangeCodeAction(
  csrfToken: string
): Promise<{ error?: string; success?: boolean }> {
  const auth = await requireAuth();
  if (!auth.success || !auth.user) return { error: auth.error };

  const csrf = await requireCSRF(csrfToken);
  if (!csrf.valid) return { error: csrf.error };

  const supabase = createAdminClient();

  const { data: user } = await supabase
    .from('users')
    .select('email, email_verified')
    .eq('id', auth.user.id)
    .single();

  if (!user?.email) return { error: 'No email associated with your account' };
  if (!user.email_verified) return { error: 'Your email is not verified' };

  const code = generateSixDigitCode();
  const expiresAt = new Date(Date.now() + CODE_EXPIRY_MINUTES * 60 * 1000).toISOString();

  await supabase
    .from('users')
    .update({ reset_code: code, reset_code_expires_at: expiresAt })
    .eq('id', auth.user.id);

  await sendPasswordChangeCodeEmail(user.email, code);

  return { success: true };
}

// -----------------------------------------------------------------------------
// Confirm Password Change (User — verify code + set new password)
// -----------------------------------------------------------------------------

export async function confirmPasswordChangeAction(
  code: string,
  newPassword: string,
  csrfToken: string
): Promise<{ error?: string; success?: boolean }> {
  const auth = await requireAuth();
  if (!auth.success || !auth.user) return { error: auth.error };

  const csrf = await requireCSRF(csrfToken);
  if (!csrf.valid) return { error: csrf.error };

  const passwordValidation = validatePassword(newPassword);
  if (!passwordValidation.valid) return { error: passwordValidation.error };

  if (!/^\d{6}$/.test(code)) return { error: 'Invalid code format' };

  const supabase = createAdminClient();

  const { data: user } = await supabase
    .from('users')
    .select('reset_code, reset_code_expires_at')
    .eq('id', auth.user.id)
    .single();

  if (!user?.reset_code || !user?.reset_code_expires_at) {
    return { error: 'No code found. Please request a new one.' };
  }

  if (new Date(user.reset_code_expires_at) < new Date()) {
    return { error: 'Code has expired. Please request a new one.' };
  }

  // Brute-force protection: max 5 attempts within the code TTL window
  const { data: rlData, error: rlError } = await supabase.rpc('check_rate_limit', {
    p_user_id: auth.user.id,
    p_window_seconds: 15 * 60,
    p_max_requests: 5,
    p_min_interval_ms: 0,
  });
  if (!rlError && rlData?.[0]?.allowed === false) {
    await supabase
      .from('users')
      .update({ reset_code: null, reset_code_expires_at: null })
      .eq('id', auth.user.id);
    return { error: 'Too many failed attempts. Please request a new code.' };
  }

  if (!safeEqual(user.reset_code, code)) {
    return { error: 'Invalid code' };
  }

  const password_hash = await hashPassword(newPassword);

  const { error } = await supabase
    .from('users')
    .update({ password_hash, reset_code: null, reset_code_expires_at: null })
    .eq('id', auth.user.id);

  if (error) return { error: 'Password change failed' };

  // C14H: bump token_version so any other JWT outstanding for this user
  // (e.g. a leaked cookie on another device) is invalidated next time it
  // hits the middleware.
  const { data: bumpData } = await supabase.rpc('bump_user_token_version', { p_user_id: auth.user.id });
  const newTv = typeof bumpData === 'number' ? bumpData : 0;

  // C29H/L4: rotate the current session's JWT so this device stays logged
  // in (otherwise the next middleware hop sees tv mismatch and logs the
  // user out on the device they just used to change the password).
  await createSession({
    id: auth.user.id,
    username: auth.user.username,
    role: auth.user.role,
    tokenVersion: newTv,
  });

  const metadata = await getRequestMetadata();
  await logAuditEvent({
    userId: auth.user.id,
    action: 'password_changed',
    metadata: { method: 'email_code' },
    ...metadata,
  });

  return { success: true };
}

// -----------------------------------------------------------------------------
// Admin Change Password (no email code required)
// -----------------------------------------------------------------------------

export async function adminChangePasswordAction(
  currentPassword: string,
  newPassword: string,
  csrfToken: string
): Promise<{ error?: string; success?: boolean }> {
  const auth = await requireAdmin();
  if (!auth.success || !auth.user) return { error: auth.error };

  const csrf = await requireCSRF(csrfToken);
  if (!csrf.valid) return { error: csrf.error };

  const passwordValidation = validatePassword(newPassword);
  if (!passwordValidation.valid) return { error: passwordValidation.error };

  const supabase = createAdminClient();

  const { data: user } = await supabase
    .from('users')
    .select('password_hash')
    .eq('id', auth.user.id)
    .single();

  if (!user) return { error: 'User not found' };

  const isValid = await verifyPassword(currentPassword, user.password_hash);
  if (!isValid) return { error: 'Current password is incorrect' };

  const password_hash = await hashPassword(newPassword);

  const { error } = await supabase
    .from('users')
    .update({ password_hash })
    .eq('id', auth.user.id);

  if (error) return { error: 'Password change failed' };

  // C14H + C29H: bump token_version then rotate this device's session so
  // other sessions are invalidated but the caller stays logged in.
  const { data: bumpData } = await supabase.rpc('bump_user_token_version', { p_user_id: auth.user.id });
  const newTv = typeof bumpData === 'number' ? bumpData : 0;
  await createSession({
    id: auth.user.id,
    username: auth.user.username,
    role: auth.user.role,
    tokenVersion: newTv,
  });

  const metadata = await getRequestMetadata();
  await logAuditEvent({
    userId: auth.user.id,
    action: 'password_changed',
    metadata: { method: 'admin_direct' },
    ...metadata,
  });

  return { success: true };
}
