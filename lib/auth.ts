// ============================================================================
// JWT-based Authentication Library (Secure Implementation)
// ============================================================================

import { cookies, headers } from 'next/headers';
import { createAdminClient } from './supabase-server';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { SignJWT, jwtVerify } from 'jose';
import { jwtPayloadSchema, type JWTPayload } from './validations';
import { SESSION_COOKIE_NAME, CSRF_COOKIE_NAME, SESSION_MAX_AGE, getJWTSecret } from './constants';

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

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
  } catch (error) {
    // Log the actual error for debugging
    console.error('JWT verification failed:', error instanceof Error ? error.message : 'Unknown error');
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
    
    if (!token) {
      return null;
    }
    
    const payload = await verifyJWTToken(token);
    return payload;
  } catch (error) {
    console.error('Session token retrieval failed:', error instanceof Error ? error.message : 'Unknown error');
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
    // Use admin client because anon role has no access to users table (REVOKED in migration)
    const supabase = createAdminClient();
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
  } catch (error) {
    console.error('Session retrieval failed:', error instanceof Error ? error.message : 'Unknown error');
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
// Timing-safe string comparison (S2: previously duplicated in actions/auth.ts
// and actions/profile.ts). Pad both inputs to equal length before comparing so
// the length itself can't leak through timing.
// -----------------------------------------------------------------------------

export function safeEqual(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return a === b;
  const bufA = Buffer.alloc(maxLen);
  const bufB = Buffer.alloc(maxLen);
  bufA.write(a);
  bufB.write(b);
  return crypto.timingSafeEqual(bufA, bufB);
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
  } catch (error) {
    console.error('CSRF validation failed:', error instanceof Error ? error.message : 'Invalid token format');
    return false;
  }
}

// -----------------------------------------------------------------------------
// Audit Logging
// -----------------------------------------------------------------------------

export type AuditAction =
  | 'login_success'
  | 'login_failed'
  // L3: dedicated event for non-admin attempts at admin endpoints. Previously
  // logged as `login_failed`, which polluted the brute-force-detection signal.
  | 'admin_escalation_attempt'
  | 'logout'
  | 'user_created'
  | 'user_updated'
  | 'user_deleted'
  | 'user_blocked'
  | 'user_unblocked'
  | 'role_changed'
  | 'password_reset'
  | 'password_changed'
  | 'pdf_ingested'
  | 'chunks_cleared'
  | 'session_deleted'
  | 'permit_created'
  | 'permit_submitted'
  | 'permit_reviewed'
  | 'permit_deleted'
  | 'permit_compliance_checked'
  | 'permit_attachment_uploaded'
  | 'permit_attachment_deleted'
  | 'permit_revision_requested'
  | 'permit_revised'
  | 'permit_certificate_generated'
  | 'database_cleanup';

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
    // Use admin client because anon role has no access to audit_logs table (REVOKED in migration)
    const supabase = createAdminClient();
    
    const { error } = await supabase.from('audit_logs').insert({
      user_id: entry.userId,
      action: entry.action,
      target_user_id: entry.targetUserId,
      metadata: entry.metadata ?? {},
      ip_address: entry.ipAddress,
      user_agent: entry.userAgent,
    });
    
    if (error) {
      // Log to console but don't fail the main operation
      console.error('Audit log insert failed:', error.message);
    }
  } catch (error) {
    // Log to console but don't fail the main operation
    console.error('Failed to log audit event:', error);
  }
}

// -----------------------------------------------------------------------------
// Request Metadata Helper
// -----------------------------------------------------------------------------

// H3: Only trust X-Forwarded-For when we're behind a known proxy hop count. The
// platform (Vercel) sets `x-vercel-forwarded-for`; a single trusted hop is the
// rightmost entry of XFF when TRUSTED_PROXY_HOPS is set, otherwise we fall back
// to `x-real-ip`. This prevents an attacker from spoofing client IP by pre-pending
// fake IPs to XFF.
const TRUSTED_PROXY_HOPS = Number(process.env.TRUSTED_PROXY_HOPS || '0');
const IP_REGEX = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-fA-F:]+)$/;
function safeIp(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return IP_REGEX.test(trimmed) ? trimmed : undefined;
}

export function getClientIp(headersList: { get: (name: string) => string | null }): string {
  // Vercel's purpose-built header is the most trustworthy when present.
  const vercelIp = safeIp(headersList.get('x-vercel-forwarded-for'));
  if (vercelIp) return vercelIp;

  const realIp = safeIp(headersList.get('x-real-ip'));
  if (realIp) return realIp;

  if (TRUSTED_PROXY_HOPS > 0) {
    const xff = headersList.get('x-forwarded-for');
    if (xff) {
      const parts = xff.split(',').map(s => s.trim()).filter(Boolean);
      // Trusted hop count: the client IP is `TRUSTED_PROXY_HOPS` from the right.
      const idx = parts.length - TRUSTED_PROXY_HOPS;
      const candidate = safeIp(parts[idx >= 0 ? idx : 0]);
      if (candidate) return candidate;
    }
  }

  return 'unknown';
}

export async function getRequestMetadata() {
  const headersList = await headers();
  return {
    ipAddress: getClientIp(headersList),
    userAgent: (headersList.get('user-agent') || 'unknown').slice(0, 512),
  };
}
