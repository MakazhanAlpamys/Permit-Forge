import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createServerClient } from '@/lib/supabase';
import { cookies } from 'next/headers';

// Helper to clear session cookies and redirect to login
function clearSessionAndRedirect(request: NextRequest): NextResponse {
  const response = NextResponse.redirect(new URL('/login', request.url));
  response.cookies.delete('ef_session');
  response.cookies.delete('ef_user_id');
  return response;
}

export async function middleware(request: NextRequest) {
  const session = request.cookies.get('ef_session');
  const userId = request.cookies.get('ef_user_id');
  const { pathname } = request.nextUrl;

  // Public paths that don't require authentication
  const publicPaths = ['/login'];
  const isPublicPath = publicPaths.some(path => pathname.startsWith(path));

  // If trying to access protected route without session, redirect to login
  if (!session || !userId) {
    if (!isPublicPath) {
      return NextResponse.redirect(new URL('/login', request.url));
    }
  } else {
    // Validate that user exists in database
    const cookieStore = await cookies();
    const userIdValue = cookieStore.get('ef_user_id')?.value;
    
    if (!userIdValue) {
      if (!isPublicPath) {
        return clearSessionAndRedirect(request);
      }
    } else {
      const supabase = createServerClient();
      const { data: user, error } = await supabase
        .from('users')
        .select('id, role')
        .eq('id', userIdValue)
        .single();

      // If user not found in DB (deleted or DB reset), clear session
      if (error || !user) {
        return clearSessionAndRedirect(request);
      }

      // If logged in and trying to access login page, redirect based on role
      if (pathname === '/login') {
        if (user.role === 'admin') {
          return NextResponse.redirect(new URL('/admin', request.url));
        } else {
          return NextResponse.redirect(new URL('/', request.url));
        }
      }

      // Check if user is trying to access admin page
      if (pathname.startsWith('/admin')) {
        if (user.role !== 'admin') {
          return NextResponse.redirect(new URL('/', request.url));
        }
      }

      // If admin trying to access root, redirect to admin
      if (pathname === '/' && user.role === 'admin') {
        return NextResponse.redirect(new URL('/admin', request.url));
      }
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/((?!api|_next/static|_next/image|favicon.ico|.*\\.svg|.*\\.png|.*\\.jpg|.*\\.jpeg|.*\\.gif|.*\\.webp).*)',
  ],
};
