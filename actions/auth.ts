'use server';

// ============================================================================
// Authentication Server Actions
// ============================================================================

import { createServerClient } from '@/lib/supabase';
import { hashPassword, verifyPassword, createSession, destroySession, setUserIdCookie } from '@/lib/auth';
import { redirect } from 'next/navigation';

// -----------------------------------------------------------------------------
// Login Action
// -----------------------------------------------------------------------------

export async function loginAction(formData: FormData): Promise<{ error?: string }> {
  try {
    const username = formData.get('username') as string;
    const password = formData.get('password') as string;

    if (!username || !password) {
      return { error: 'Username and password are required' };
    }

    const supabase = createServerClient();

    // Find user by username
    const { data: user, error } = await supabase
      .from('users')
      .select('id, username, password_hash, role')
      .eq('username', username)
      .single();

    if (error || !user) {
      return { error: 'Invalid username or password' };
    }

    // Verify password using bcrypt
    const isValidPassword = await verifyPassword(password, user.password_hash);
    
    if (!isValidPassword) {
      return { error: 'Invalid username or password' };
    }

    // Update last login
    await supabase
      .from('users')
      .update({ last_login: new Date().toISOString() })
      .eq('id', user.id);

    // Create session
    await createSession(user.id);
    await setUserIdCookie(user.id);

  } catch (error) {
    console.error('Login error:', error);
    return { error: 'An error occurred during login' };
  }

  redirect('/');
}

// -----------------------------------------------------------------------------
// Logout Action
// -----------------------------------------------------------------------------

export async function logoutAction(): Promise<void> {
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
}): Promise<{ success: boolean; error?: string }> {
  try {
    const { username, password, full_name, role } = data;

    if (!username || !password) {
      return { success: false, error: 'Username and password are required' };
    }

    const supabase = createServerClient();
    const passwordHash = await hashPassword(password);

    const { error } = await supabase
      .from('users')
      .insert({
        username,
        password_hash: passwordHash,
        full_name,
        role: role || 'user',
      });

    if (error) {
      if (error.code === '23505') { // Unique constraint violation
        return { success: false, error: 'Username already exists' };
      }
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (error) {
    console.error('Create user error:', error);
    return { success: false, error: 'Failed to create user' };
  }
}
