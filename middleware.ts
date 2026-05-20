import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { jwtVerify } from 'jose';
import { jwtPayloadSchema } from '@/lib/validations';
import { SESSION_COOKIE_NAME, getJWTSecret } from '@/lib/constants';
import { blockStatusCache } from '@/lib/block-status-cache';

// Block status check interval (5 minutes in milliseconds)
const BLOCK_CHECK_INTERVAL_MS = 5 * 60 * 1000;

// A5/H1: Build the per-request Content-Security-Policy. The previous policy
// allowed 'unsafe-inline' AND 'unsafe-eval' for script-src — any reflected XSS
// became a session takeover because attacker scripts could run. Replace with
// nonce + 'strict-dynamic': only scripts tagged with the per-request nonce
// (and scripts they load via document.createElement) can execute.
//
// 'unsafe-eval' is dropped entirely in production. Dev keeps it because
// Next.js HMR + React DevTools rely on eval; the cost in dev is acceptable.
// style-src keeps 'unsafe-inline' because Tailwind / framer-motion / Radix
// inject style="..." attributes that nonces don't cover. Tightening that
// requires hash-based CSP and is out of scope for this pass.
function buildCSP(nonce: string): string {
  const scriptSrc = process.env.NODE_ENV === 'production'
    ? `'self' 'nonce-${nonce}' 'strict-dynamic'`
    : `'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-eval'`;
  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' https://*.supabase.co",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function applyCommonSecurityHeaders(response: NextResponse, nonce: string): NextResponse {
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-XSS-Protection', '1; mode=block');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.headers.set('Content-Security-Policy', buildCSP(nonce));
  if (process.env.NODE_ENV === 'production') {
    response.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  }
  return response;
}

// Clear session and redirect to login
function clearSessionAndRedirect(request: NextRequest, nonce: string, reason?: string): NextResponse {
  const response = NextResponse.redirect(new URL('/login', request.url));
  response.cookies.delete(SESSION_COOKIE_NAME);
  response.cookies.delete('ef_csrf');
  if (reason) {
    // Set a cookie to show blocked message on login page
    // SECURITY: sanitize reason — strip HTML/scripts, limit length
    const safeReason = reason.replace(/[<>"'&]/g, '').slice(0, 100);
    response.cookies.set('ef_blocked_reason', safeReason, {
      httpOnly: false,
      maxAge: 60, // 1 minute to display message
      path: '/',
    });
  }
  return applyCommonSecurityHeaders(response, nonce);
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

  // A5: per-request nonce for script-src. Edge runtime exposes crypto.randomUUID().
  // We base64-url encode to keep the nonce CSP-safe (alphanumeric + -, _).
  const nonce = btoa(crypto.randomUUID().replace(/-/g, ''))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  // Forward the nonce to downstream React server components via a request
  // header — app/layout.tsx reads it via headers() and applies it to <Script>
  // tags it controls. Next.js itself also reads x-nonce internally for the
  // scripts it auto-injects (framework runtime, hydration, font preload).
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);

  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const { pathname } = request.nextUrl;

  // Public paths that don't require authentication
  const publicPaths = ['/login', '/register', '/verify-email', '/forgot-password'];
  const isPublicPath = publicPaths.some(path => pathname.startsWith(path));

  // If no token
  if (!token) {
    if (!isPublicPath) {
      return applyCommonSecurityHeaders(
        NextResponse.redirect(new URL('/login', request.url)),
        nonce,
      );
    }
    return applyCommonSecurityHeaders(
      NextResponse.next({ request: { headers: requestHeaders } }),
      nonce,
    );
  }

  // Verify JWT token (NO DATABASE CALL!)
  const verification = await verifyToken(token);

  if (!verification.valid) {
    // Invalid token - clear and redirect
    return clearSessionAndRedirect(request, nonce);
  }

  const { sub: userId, role } = verification.payload;

  // =========================================================================
  // REAL-TIME BLOCK CHECK (with caching for performance)
  // =========================================================================
  const blockStatus = await checkUserBlocked(userId);

  if (blockStatus.blocked) {
    // User is blocked - terminate session immediately
    console.log(`Blocked user ${userId} attempted access`);
    return clearSessionAndRedirect(request, nonce, blockStatus.reason || 'Your account has been blocked');
  }

  // If logged in and trying to access public auth pages
  if (isPublicPath) {
    const target = role === 'admin' ? '/admin' : '/';
    return applyCommonSecurityHeaders(
      NextResponse.redirect(new URL(target, request.url)),
      nonce,
    );
  }

  // Check admin access
  if (pathname.startsWith('/admin') && role !== 'admin') {
    return applyCommonSecurityHeaders(
      NextResponse.redirect(new URL('/', request.url)),
      nonce,
    );
  }

  // If admin trying to access user pages, redirect to admin
  if ((pathname === '/' || pathname.startsWith('/permits')) && role === 'admin') {
    return applyCommonSecurityHeaders(
      NextResponse.redirect(new URL('/admin', request.url)),
      nonce,
    );
  }

  // Authenticated, on-path. Pass the nonce-bearing request headers downstream.
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('x-user-id', userId);
  response.headers.set('x-user-role', role);
  return applyCommonSecurityHeaders(response, nonce);
}

export const config = {
  matcher: [
    '/((?!api|_next/static|_next/image|favicon.ico|.*\\.svg|.*\\.png|.*\\.jpg|.*\\.jpeg|.*\\.gif|.*\\.webp).*)',
  ],
};
