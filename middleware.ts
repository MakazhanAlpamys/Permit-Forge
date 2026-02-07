import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { jwtVerify } from 'jose';
import { jwtPayloadSchema } from '@/lib/validations';
import { SESSION_COOKIE_NAME, getJWTSecret } from '@/lib/constants';

// Block status check interval (5 minutes in milliseconds)
const BLOCK_CHECK_INTERVAL_MS = 5 * 60 * 1000;

// In-memory cache for blocked users (Edge Runtime compatible)
// Key: userId, Value: { blocked: boolean, checkedAt: number }
const blockStatusCache = new Map<string, { blocked: boolean; checkedAt: number }>();

// Clear session and redirect to login
function clearSessionAndRedirect(request: NextRequest, reason?: string): NextResponse {
  const response = NextResponse.redirect(new URL('/login', request.url));
  response.cookies.delete(SESSION_COOKIE_NAME);
  response.cookies.delete('ef_csrf');
  if (reason) {
    // Set a cookie to show blocked message on login page
    response.cookies.set('ef_blocked_reason', reason, {
      httpOnly: false,
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
    return { blocked: cached.blocked };
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
      blockStatusCache.set(userId, { blocked: true, checkedAt: now });
      return { blocked: true, reason: 'User not found' };
    }
    
    const blocked = user.blocked === true;
    
    // Update cache
    blockStatusCache.set(userId, { blocked, checkedAt: now });
    
    // Clean up old cache entries (prevent memory leak)
    if (blockStatusCache.size > 1000) {
      const oldestAllowed = now - BLOCK_CHECK_INTERVAL_MS * 2;
      for (const [key, value] of blockStatusCache) {
        if (value.checkedAt < oldestAllowed) {
          blockStatusCache.delete(key);
        }
      }
    }
    
    return { blocked, reason: user.blocked_reason };
  } catch (error) {
    console.error('Block check error:', error);
    // Fail-safe: don't block if we can't check
    return { blocked: false };
  }
}

export async function middleware(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const { pathname } = request.nextUrl;

  // Public paths that don't require authentication
  const publicPaths = ['/login'];
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

  // If logged in and trying to access login page
  if (pathname === '/login') {
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
  
  return response;
}

export const config = {
  matcher: [
    '/((?!api|_next/static|_next/image|favicon.ico|.*\\.svg|.*\\.png|.*\\.jpg|.*\\.jpeg|.*\\.gif|.*\\.webp).*)',
  ],
};
