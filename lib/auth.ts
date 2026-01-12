// ============================================================================
// JWT-based Authentication Library (Secure Implementation)
// ============================================================================

import { cookies, headers } from 'next/headers';
import { createServerClient, createPublicClient } from './supabase';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { SignJWT, jwtVerify } from 'jose';
import { jwtPayloadSchema, type JWTPayload } from './validations';

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const SESSION_COOKIE_NAME = 'ef_token';
const CSRF_COOKIE_NAME = 'ef_csrf';
const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 days
const BCRYPT_SALT_ROUNDS = 12;

// Get JWT secret as Uint8Array for jose
function getJWTSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters');
  }
  return new TextEncoder().encode(secret);
}

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
// JWT Token Management
// -----------------------------------------------------------------------------

export interface User {
  id: string;
  username: string;
  full_name?: string;
  role: 'admin' | 'user';
}

interface TokenUser {
  id: string;
  username: string;
  role: 'admin' | 'user';
}

/**
 * Create a signed JWT token for the user
 */
export async function createJWTToken(user: TokenUser): Promise<string> {
  const secret = getJWTSecret();
  
  const token = await new SignJWT({
    sub: user.id,
    username: user.username,
    role: user.role,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE}s`)
    .sign(secret);
  
  return token;
}

/**
 * Verify and decode a JWT token
 */
export async function verifyJWTToken(token: string): Promise<JWTPayload | null> {
  try {
    const secret = getJWTSecret();
    const { payload } = await jwtVerify(token, secret);
    
    // Validate payload structure
    const result = jwtPayloadSchema.safeParse(payload);
    if (!result.success) {
      console.error('JWT payload validation failed:', result.error);
      return null;
    }
    
    return result.data;
  } catch {
    // Token is invalid or expired
    return null;
  }
}

// -----------------------------------------------------------------------------
// Session Management
// -----------------------------------------------------------------------------

/**
 * Create session by setting secure HTTP-only cookie with JWT
 */
export async function createSession(user: TokenUser): Promise<void> {
  const token = await createJWTToken(user);
  const cookieStore = await cookies();
  
  cookieStore.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: SESSION_MAX_AGE,
    path: '/',
  });
}

/**
 * Destroy session by deleting the JWT cookie
 */
export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE_NAME);
  cookieStore.delete(CSRF_COOKIE_NAME);
}

/**
 * Get current session from JWT token (NO DATABASE CALL)
 * This is used for fast authentication checks
 */
export async function getSessionFromToken(): Promise<JWTPayload | null> {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
    
    if (!token) return null;
    
    return verifyJWTToken(token);
  } catch {
    return null;
  }
}

/**
 * Get current user with full data from database
 * Use this when you need the complete user object
 */
export async function getSession(): Promise<User | null> {
  const tokenPayload = await getSessionFromToken();
  if (!tokenPayload) return null;
  
  try {
    const supabase = createPublicClient();
    const { data: user, error } = await supabase
      .from('users')
      .select('id, username, full_name, role, blocked')
      .eq('id', tokenPayload.sub)
      .single();
    
    if (error || !user) return null;
    
    // Check if user is blocked
    if (user.blocked) return null;
    
    return {
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      role: user.role as 'admin' | 'user',
    };
  } catch {
    return null;
  }
}

/**
 * Quick token-only session check (no DB call)
 * Returns user info from token, or null
 */
export async function getQuickSession(): Promise<{ id: string; username: string; role: 'admin' | 'user' } | null> {
  const payload = await getSessionFromToken();
  if (!payload) return null;
  
  return {
    id: payload.sub,
    username: payload.username,
    role: payload.role,
  };
}

// -----------------------------------------------------------------------------
// CSRF Protection
// -----------------------------------------------------------------------------

/**
 * Generate CSRF token and store in cookie
 */
export async function generateCSRFToken(): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex');
  const cookieStore = await cookies();
  
  cookieStore.set(CSRF_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: SESSION_MAX_AGE,
    path: '/',
  });
  
  return token;
}

/**
 * Get current CSRF token from cookie
 */
export async function getCSRFToken(): Promise<string | null> {
  const cookieStore = await cookies();
  return cookieStore.get(CSRF_COOKIE_NAME)?.value ?? null;
}

/**
 * Validate CSRF token
 */
export async function validateCSRFToken(token: string): Promise<boolean> {
  const storedToken = await getCSRFToken();
  if (!storedToken || !token) return false;
  
  // Timing-safe comparison
  try {
    return crypto.timingSafeEqual(
      Buffer.from(storedToken),
      Buffer.from(token)
    );
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// Audit Logging
// -----------------------------------------------------------------------------

export type AuditAction = 
  | 'login_success'
  | 'login_failed'
  | 'logout'
  | 'user_created'
  | 'user_updated'
  | 'user_blocked'
  | 'user_unblocked'
  | 'role_changed'
  | 'password_reset'
  | 'password_changed'
  | 'pdf_ingested'
  | 'chunks_cleared'
  | 'session_deleted';

interface AuditLogEntry {
  userId?: string;
  action: AuditAction;
  targetUserId?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

export async function logAuditEvent(entry: AuditLogEntry): Promise<void> {
  try {
    const supabase = createServerClient();
    
    await supabase.from('audit_logs').insert({
      user_id: entry.userId,
      action: entry.action,
      target_user_id: entry.targetUserId,
      metadata: entry.metadata ?? {},
      ip_address: entry.ipAddress,
      user_agent: entry.userAgent,
    });
  } catch (error) {
    // Log to console but don't fail the main operation
    console.error('Failed to log audit event:', error);
  }
}

// -----------------------------------------------------------------------------
// Request Metadata Helper
// -----------------------------------------------------------------------------

export async function getRequestMetadata() {
  const headersList = await headers();
  return {
    ipAddress: headersList.get('x-forwarded-for') || headersList.get('x-real-ip') || 'unknown',
    userAgent: headersList.get('user-agent') || 'unknown',
  };
}
