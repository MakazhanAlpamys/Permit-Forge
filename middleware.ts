import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { jwtVerify } from 'jose';
import { jwtPayloadSchema } from '@/lib/validations';

const SESSION_COOKIE_NAME = 'ef_token';

// Get JWT secret as Uint8Array
function getJWTSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters');
  }
  return new TextEncoder().encode(secret);
}

// Clear session and redirect to login
function clearSessionAndRedirect(request: NextRequest): NextResponse {
  const response = NextResponse.redirect(new URL('/login', request.url));
  response.cookies.delete(SESSION_COOKIE_NAME);
  response.cookies.delete('ef_csrf');
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

  // If admin trying to access root, redirect to admin
  if (pathname === '/' && role === 'admin') {
    return NextResponse.redirect(new URL('/admin', request.url));
  }

  // Add user info to headers for downstream use
  const response = NextResponse.next();
  response.headers.set('x-user-id', userId);
  response.headers.set('x-user-role', role);
  
  return response;
}

export const config = {
  matcher: [
    '/((?!api|_next/static|_next/image|favicon.ico|.*\\.svg|.*\\.png|.*\\.jpg|.*\\.jpeg|.*\\.gif|.*\\.webp).*)',
  ],
};
