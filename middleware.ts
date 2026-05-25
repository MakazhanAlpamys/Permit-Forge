import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { jwtVerify } from 'jose';
import { jwtPayloadSchema } from '@/lib/validations';
import { SESSION_COOKIE_NAME, getJWTSecret } from '@/lib/constants';
import { blockStatusCache } from '@/lib/block-status-cache';

// v1.1.0 Part C (A-C-4 / A-M-3): block-status / token_version cache TTL.
// This is the FLOOR on staleness: between two middleware hops within this
// window, a user who was just blocked (or had their role / token_version
// changed) may still slip through one request before the cache refreshes.
//
// Tightened from 5 min → 30s to bound the blast radius for the diploma
// demo. Production needs Redis (or a shorter TTL) because Edge isolates
// don't share Map instances across V8 workers — `invalidateBlockStatus`
// only punches the local isolate's cache, not its siblings.
const BLOCK_CHECK_INTERVAL_MS = 30 * 1000;

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
    // C13H/M2: harden the blocked-reason cookie (used to display the
    // "your account was blocked" message on /login). Same secure + strict
    // defaults as the session/CSRF cookies; DEV_INSECURE_COOKIES=1 is the dev
    // escape hatch. v1.5.0 Part D renamed from NEXT_PUBLIC_DEV_INSECURE_COOKIES
    // — the legacy name is still honored at runtime (see lib/cookie-options).
    const devInsecure =
      process.env.DEV_INSECURE_COOKIES === '1' ||
      process.env.NEXT_PUBLIC_DEV_INSECURE_COOKIES === '1';
    response.cookies.set('ef_blocked_reason', safeReason, {
      httpOnly: false,
      secure: !devInsecure,
      sameSite: devInsecure ? 'lax' : 'strict',
      maxAge: 60, // 1 minute to display message
      path: '/',
    });
  }
  return applyCommonSecurityHeaders(response, nonce);
}

// Verify JWT token without database call
async function verifyToken(token: string): Promise<{ valid: true; payload: { sub: string; role: string; tv: number } } | { valid: false }> {
  try {
    const secret = getJWTSecret();
    const { payload } = await jwtVerify(token, secret);

    const result = jwtPayloadSchema.safeParse(payload);
    if (!result.success) {
      return { valid: false };
    }

    return {
      valid: true,
      payload: { sub: result.data.sub, role: result.data.role, tv: result.data.tv ?? 0 },
    };
  } catch {
    return { valid: false };
  }
}

// Check if user is blocked and read their current token_version
// (C14H: same DB hop, so the version check costs zero extra round-trips).
async function checkUserBlocked(
  userId: string,
): Promise<{ blocked: boolean; reason?: string; tokenVersion?: number }> {
  const now = Date.now();
  const cached = blockStatusCache.get(userId);

  // Return cached result if still valid
  if (cached && (now - cached.checkedAt) < BLOCK_CHECK_INTERVAL_MS) {
    return {
      blocked: cached.blocked,
      reason: cached.reason,
      tokenVersion: cached.tokenVersion,
    };
  }

  try {
    // Direct fetch to Supabase REST API (Edge-compatible, no SDK needed)
    // Using service_role key to bypass RLS (anon doesn't have access to users table)
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceRoleKey) {
      // AUTH-H1 / v1.1.0 Part C: fail CLOSED rather than open. Previously
      // returned {blocked:false} which let blocked users through whenever
      // env vars were misconfigured. The diploma deployment hosts Supabase
      // in the same project as the app, so a missing credential is an
      // operator error, not a transient outage we should paper over.
      console.error('Supabase credentials missing for block check — failing closed');
      return { blocked: true, reason: 'Authentication service unavailable' };
    }

    const response = await fetch(
      `${supabaseUrl}/rest/v1/users?id=eq.${userId}&select=blocked,blocked_reason,token_version`,
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
      // AUTH-H1: fail CLOSED. A 4xx/5xx from Supabase REST is not a reason
      // to grant access — a blocked attacker would benefit. Emit the status
      // for incident triage.
      console.error('Block check failed — failing closed. Status:', response.status);
      return { blocked: true, reason: 'Authentication service unavailable' };
    }

    const users = await response.json();
    const user = users?.[0];

    if (!user) {
      // User not found - they're effectively blocked (deleted)
      blockStatusCache.set(userId, { blocked: true, reason: 'User not found', checkedAt: now });
      return { blocked: true, reason: 'User not found' };
    }

    const blocked = user.blocked === true;
    const tokenVersion: number =
      typeof user.token_version === 'number' ? user.token_version : 0;

    // Update cache (include reason + tv so cached lookups don't need a DB hit)
    blockStatusCache.set(userId, {
      blocked,
      reason: user.blocked_reason,
      tokenVersion,
      checkedAt: now,
    });

    // Clean up old cache entries (prevent memory leak)
    if (blockStatusCache.size > 1000) {
      const oldestAllowed = now - BLOCK_CHECK_INTERVAL_MS * 2;
      const keysToDelete: string[] = [];
      for (const [key, value] of blockStatusCache) {
        if (value.checkedAt < oldestAllowed) keysToDelete.push(key);
      }
      keysToDelete.forEach(k => blockStatusCache.delete(k));
    }

    return { blocked, reason: user.blocked_reason, tokenVersion };
  } catch (error) {
    // AUTH-H2: fail CLOSED. Network/DNS error: redirect the user to /login
    // rather than letting their JWT carry them through unauthenticated state.
    console.error('Block check error — failing closed:', error);
    return { blocked: true, reason: 'Authentication service unavailable' };
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

  const { sub: userId, role, tv: tokenVersion } = verification.payload;

  // =========================================================================
  // REAL-TIME BLOCK CHECK + TOKEN VERSION (C14H/M3) — single DB hop.
  // =========================================================================
  const blockStatus = await checkUserBlocked(userId);

  if (blockStatus.blocked) {
    // User is blocked - terminate session immediately
    console.log(`Blocked user ${userId} attempted access`);
    return clearSessionAndRedirect(request, nonce, blockStatus.reason || 'Your account has been blocked');
  }

  // C14H: if token_version in the DB has advanced past the value baked into
  // this JWT, an admin role change / password change / forced logout has
  // happened since the session was issued. Treat as logged out.
  if (
    blockStatus.tokenVersion !== undefined &&
    tokenVersion < blockStatus.tokenVersion
  ) {
    return clearSessionAndRedirect(request, nonce);
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
