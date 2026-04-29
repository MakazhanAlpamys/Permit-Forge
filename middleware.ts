import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { jwtVerify } from 'jose';
import { jwtPayloadSchema } from '@/lib/validations';
import { SESSION_COOKIE_NAME, getJWTSecret } from '@/lib/constants';

// P2-H7: block status check interval shortened from 5 min to 30 s. The previous
// 5-min window left a blocked user fully active for up to 5 minutes. A proper
// fix requires Redis pub-sub for cross-instance invalidation (out of scope);
// 30 s is a reasonable compromise — small extra DB load, much shorter exposure.
const BLOCK_CHECK_INTERVAL_MS = 30 * 1000;

// In-memory cache for blocked users (Edge Runtime compatible)
// Key: userId, Value: { blocked: boolean, reason: string | undefined, checkedAt: number }
const blockStatusCache = new Map<string, { blocked: boolean; reason?: string; checkedAt: number }>();

// Clear session and redirect to login
function clearSessionAndRedirect(request: NextRequest, reason?: string): NextResponse {
  const response = NextResponse.redirect(new URL('/login', request.url));
  response.cookies.delete(SESSION_COOKIE_NAME);
  response.cookies.delete('ef_csrf');
  if (reason) {
    // Set a cookie to show blocked message on login page
    // SECURITY: sanitize reason — strip HTML/scripts, limit length
    const safeReason = reason.replace(/[<>"'&]/g, '').slice(0, 100);
    response.cookies.set('ef_blocked_reason', safeReason, {
      httpOnly: false,
      // M2: harden cookie attributes — secure in prod, lax sameSite, scoped path.
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60, // 1 minute to display message
      path: '/',
    });
  }
  return response;
}

// Verify JWT token without database call
async function verifyToken(token: string): Promise<{ valid: true; payload: { sub: string; role: string } } | { valid: false }> {
  try {
    const secret = getJWTSecret();
    const { payload } = await jwtVerify(token, secret);
    
    const result = jwtPayloadSchema.safeParse(payload);
    if (!result.success) {
      return { valid: false };
    }
    
    return { 
      valid: true, 
      payload: { sub: result.data.sub, role: result.data.role } 
    };
  } catch {
    return { valid: false };
  }
}

// Check if user is blocked (with caching for performance)
async function checkUserBlocked(userId: string): Promise<{ blocked: boolean; reason?: string }> {
  const now = Date.now();
  const cached = blockStatusCache.get(userId);
  
  // Return cached result if still valid
  if (cached && (now - cached.checkedAt) < BLOCK_CHECK_INTERVAL_MS) {
    return { blocked: cached.blocked, reason: cached.reason };
  }
  
  try {
    // Direct fetch to Supabase REST API (Edge-compatible, no SDK needed)
    // Using service_role key to bypass RLS (anon doesn't have access to users table)
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    
    if (!supabaseUrl || !serviceRoleKey) {
      console.error('Supabase credentials missing for block check');
      // Fail-safe: don't block if we can't check
      return { blocked: false };
    }
    
    const response = await fetch(
      `${supabaseUrl}/rest/v1/users?id=eq.${userId}&select=blocked,blocked_reason`,
      {
        headers: {
          'apikey': serviceRoleKey,
          'Authorization': `Bearer ${serviceRoleKey}`,
          'Content-Type': 'application/json',
        },
        // Disable Next.js cache to ensure fresh data
        cache: 'no-store',
      }
    );
    
    if (!response.ok) {
      console.error('Block check failed:', response.status);
      // Fail-safe: don't block if we can't check
      return { blocked: false };
    }
    
    const users = await response.json();
    const user = users?.[0];
    
    if (!user) {
      // User not found - they're effectively blocked (deleted)
      blockStatusCache.set(userId, { blocked: true, reason: 'User not found', checkedAt: now });
      return { blocked: true, reason: 'User not found' };
    }

    const blocked = user.blocked === true;

    // Update cache (include reason so cached lookups show it)
    blockStatusCache.set(userId, { blocked, reason: user.blocked_reason, checkedAt: now });
    
    // Clean up old cache entries (prevent memory leak)
    if (blockStatusCache.size > 1000) {
      const oldestAllowed = now - BLOCK_CHECK_INTERVAL_MS * 2;
      const keysToDelete: string[] = [];
      for (const [key, value] of blockStatusCache) {
        if (value.checkedAt < oldestAllowed) keysToDelete.push(key);
      }
      keysToDelete.forEach(k => blockStatusCache.delete(k));
    }
    
    return { blocked, reason: user.blocked_reason };
  } catch (error) {
    console.error('Block check error:', error);
    // Fail-safe: don't block if we can't check
    return { blocked: false };
  }
}

export async function middleware(request: NextRequest) {
  // SECURITY: Strip x-middleware-subrequest header from external requests (CVE-2025-29927 defense-in-depth)
  if (request.headers.get('x-middleware-subrequest')) {
    return new NextResponse(null, { status: 403 });
  }

  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const { pathname } = request.nextUrl;

  // Public paths that don't require authentication
  const publicPaths = ['/login', '/register', '/verify-email', '/forgot-password'];
  const isPublicPath = publicPaths.some(path => pathname.startsWith(path));

  // If no token
  if (!token) {
    if (!isPublicPath) {
      return NextResponse.redirect(new URL('/login', request.url));
    }
    return NextResponse.next();
  }

  // Verify JWT token (NO DATABASE CALL!)
  const verification = await verifyToken(token);
  
  if (!verification.valid) {
    // Invalid token - clear and redirect
    return clearSessionAndRedirect(request);
  }

  const { sub: userId, role } = verification.payload;

  // =========================================================================
  // REAL-TIME BLOCK CHECK (with caching for performance)
  // =========================================================================
  const blockStatus = await checkUserBlocked(userId);
  
  if (blockStatus.blocked) {
    // User is blocked - terminate session immediately
    console.log(`Blocked user ${userId} attempted access`);
    return clearSessionAndRedirect(request, blockStatus.reason || 'Your account has been blocked');
  }

  // If logged in and trying to access public auth pages
  if (isPublicPath) {
    if (role === 'admin') {
      return NextResponse.redirect(new URL('/admin', request.url));
    }
    return NextResponse.redirect(new URL('/', request.url));
  }

  // Check admin access
  if (pathname.startsWith('/admin')) {
    if (role !== 'admin') {
      return NextResponse.redirect(new URL('/', request.url));
    }
  }

  // If admin trying to access user pages, redirect to admin
  if ((pathname === '/' || pathname.startsWith('/permits')) && role === 'admin') {
    return NextResponse.redirect(new URL('/admin', request.url));
  }

  // Add user info to headers for downstream use
  const response = NextResponse.next();
  response.headers.set('x-user-id', userId);
  response.headers.set('x-user-role', role);
  
  // =========================================================================
  // SECURITY HEADERS
  // =========================================================================
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-XSS-Protection', '1; mode=block');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // H8: HSTS — force HTTPS for 1y including subdomains. Production only (don't break local http).
  if (process.env.NODE_ENV === 'production') {
    response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  // H1: tighten CSP. Production drops 'unsafe-eval' (dev needs it for HMR/source maps).
  // 'unsafe-inline' on script-src remains because Next.js inlines small bootstrap scripts;
  // a full nonce-based migration is tracked in fix-plan as a follow-up.
  const scriptSrc = process.env.NODE_ENV === 'production'
    ? "script-src 'self' 'unsafe-inline'"
    : "script-src 'self' 'unsafe-inline' 'unsafe-eval'";
  response.headers.set('Content-Security-Policy', `default-src 'self'; ${scriptSrc}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' https://*.supabase.co; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'`);
  
  return response;
}

export const config = {
  matcher: [
    '/((?!api|_next/static|_next/image|favicon.ico|.*\\.svg|.*\\.png|.*\\.jpg|.*\\.jpeg|.*\\.gif|.*\\.webp).*)',
  ],
};
