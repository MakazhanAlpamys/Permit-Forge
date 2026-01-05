// ============================================================================
// Simple Authentication Library
// ============================================================================

import { cookies } from 'next/headers';
import { createServerClient } from './supabase';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

const SESSION_COOKIE_NAME = 'ef_session';
const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 days
const BCRYPT_SALT_ROUNDS = 12;

// -----------------------------------------------------------------------------
// Password Hashing (bcrypt)
// -----------------------------------------------------------------------------

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// -----------------------------------------------------------------------------
// Session Management
// -----------------------------------------------------------------------------

export interface User {
  id: string;
  username: string;
  full_name?: string;
  role: string;
}

export async function createSession(_userId: string): Promise<string> {
  const sessionToken = crypto.randomBytes(32).toString('hex');
  const cookieStore = await cookies();
  
  cookieStore.set(SESSION_COOKIE_NAME, sessionToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: SESSION_MAX_AGE,
    path: '/',
  });

  // Store session in memory or Redis (for now, we'll use cookie-based session)
  // In production, use Redis or database
  return sessionToken;
}

export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE_NAME);
}

export async function getSession(): Promise<User | null> {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(SESSION_COOKIE_NAME);
  
  if (!sessionToken) {
    return null;
  }

  // In a real app, verify session token against database/Redis
  // For now, we'll decode userId from token (simplified)
  try {
    // This is a simplified version - in production use proper session storage
    const supabase = createServerClient();
    
    // Get user from database based on session
    // Since we don't have session table, we'll use cookie to store userId
    const userId = cookieStore.get('ef_user_id')?.value;
    
    if (!userId) return null;

    const { data: user } = await supabase
      .from('users')
      .select('id, username, full_name, role')
      .eq('id', userId)
      .single();

    return user as User | null;
  } catch (error) {
    console.error('Session error:', error);
    return null;
  }
}

export async function setUserIdCookie(userId: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set('ef_user_id', userId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: SESSION_MAX_AGE,
    path: '/',
  });
}
