'use server';

// ============================================================================
// Authentication Server Actions (with JWT, CSRF, and Audit Logging)
// ============================================================================

import { createPublicClient, createServerClient } from '@/lib/supabase';
import { 
  hashPassword, 
  verifyPassword, 
  createSession, 
  destroySession,
  generateCSRFToken,
  logAuditEvent,
  getQuickSession
} from '@/lib/auth';
import { loginSchema, createUserSchema } from '@/lib/validations';
import { redirect } from 'next/navigation';
import { getRequestMetadata } from '@/lib/auth';

// -----------------------------------------------------------------------------
// Login Action
// -----------------------------------------------------------------------------

export async function loginAction(formData: FormData): Promise<{ error?: string }> {
  const metadata = await getRequestMetadata();
  
  try {
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
      return { error: validation.error.errors[0].message };
    }

    const supabase = createPublicClient();

    // Find user by username
    const { data: user, error } = await supabase
      .from('users')
      .select('id, username, password_hash, role, blocked')
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
    return { error: `Login failed: ${errorMessage}` };
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
// Create User Action (Admin only)
// -----------------------------------------------------------------------------

export async function createUserAction(data: {
  username: string;
  password: string;
  full_name?: string;
  role?: string;
}): Promise<{ success: boolean; error?: string; userId?: string }> {
  try {
    // Verify admin access
    const currentUser = await getQuickSession();
    if (!currentUser || currentUser.role !== 'admin') {
      return { success: false, error: 'Unauthorized' };
    }

    // Validate input
    const validation = createUserSchema.safeParse(data);
    if (!validation.success) {
      return { success: false, error: validation.error.errors[0].message };
    }

    const { username, password, full_name, role } = validation.data;
    const supabase = createServerClient();
    const passwordHash = await hashPassword(password);

    const { data: newUser, error } = await supabase
      .from('users')
      .insert({
        username,
        password_hash: passwordHash,
        full_name,
        role,
      })
      .select('id')
      .single();

    if (error) {
      if (error.code === '23505') { // Unique constraint violation
        return { success: false, error: 'Username already exists' };
      }
      return { success: false, error: error.message };
    }

    // Log the action
    const metadata = await getRequestMetadata();
    await logAuditEvent({
      userId: currentUser.id,
      action: 'user_created',
      targetUserId: newUser.id,
      metadata: { username, role },
      ...metadata,
    });

    return { success: true, userId: newUser.id };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: `Failed to create user: ${errorMessage}` };
  }
}

// -----------------------------------------------------------------------------
// Change Own Password Action (for authenticated users)
// -----------------------------------------------------------------------------

export async function changeOwnPasswordAction(data: {
  currentPassword: string;
  newPassword: string;
}): Promise<{ success: boolean; error?: string }> {
  try {
    // Verify user is authenticated
    const currentUser = await getQuickSession();
    if (!currentUser) {
      return { success: false, error: 'Unauthorized' };
    }

    // Import validation schema
    const { changePasswordSchema, validatePassword } = await import('@/lib/validations');
    
    // Validate input
    const validation = changePasswordSchema.safeParse(data);
    if (!validation.success) {
      return { success: false, error: validation.error.errors[0].message };
    }

    const { currentPassword, newPassword } = validation.data;

    // Get user's current password hash
    const supabase = createServerClient();
    const { data: user, error: fetchError } = await supabase
      .from('users')
      .select('password_hash')
      .eq('id', currentUser.id)
      .single();

    if (fetchError || !user) {
      return { success: false, error: 'User not found' };
    }

    // Verify current password
    const isValidPassword = await verifyPassword(currentPassword, user.password_hash);
    if (!isValidPassword) {
      return { success: false, error: 'Current password is incorrect' };
    }

    // Validate new password complexity
    const passwordValidation = validatePassword(newPassword);
    if (!passwordValidation.valid) {
      return { success: false, error: passwordValidation.error };
    }

    // Hash new password
    const newPasswordHash = await hashPassword(newPassword);

    // Update password in database
    const { error: updateError } = await supabase
      .from('users')
      .update({ password_hash: newPasswordHash })
      .eq('id', currentUser.id);

    if (updateError) {
      return { success: false, error: 'Failed to update password' };
    }

    // Log the action
    const metadata = await getRequestMetadata();
    await logAuditEvent({
      userId: currentUser.id,
      action: 'password_changed',
      ...metadata,
    });

    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: `Failed to change password: ${errorMessage}` };
  }
}

// -----------------------------------------------------------------------------
// Get CSRF Token Action (for client-side forms)
// -----------------------------------------------------------------------------

export async function getCSRFTokenAction(): Promise<{ token: string | null }> {
  const token = await generateCSRFToken();
  return { token };
}
