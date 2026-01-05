import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createServerClient } from '@/lib/supabase';
import { cookies } from 'next/headers';

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
    // If logged in and trying to access login page, redirect based on role
    if (pathname === '/login') {
      // Get user role
      const cookieStore = await cookies();
      const userIdValue = cookieStore.get('ef_user_id')?.value;
      
      if (userIdValue) {
        const supabase = createServerClient();
        const { data: user } = await supabase
          .from('users')
          .select('role')
          .eq('id', userIdValue)
          .single();

        if (user?.role === 'admin') {
          return NextResponse.redirect(new URL('/admin', request.url));
        } else {
          return NextResponse.redirect(new URL('/', request.url));
        }
      }
    }

    // Check if user is trying to access admin page
    if (pathname.startsWith('/admin')) {
      const cookieStore = await cookies();
      const userIdValue = cookieStore.get('ef_user_id')?.value;
      
      if (userIdValue) {
        const supabase = createServerClient();
        const { data: user } = await supabase
          .from('users')
          .select('role')
          .eq('id', userIdValue)
          .single();

        // If not admin, redirect to home
        if (user?.role !== 'admin') {
          return NextResponse.redirect(new URL('/', request.url));
        }
      }
    }

    // Check if regular user is trying to access root
    if (pathname === '/') {
      const cookieStore = await cookies();
      const userIdValue = cookieStore.get('ef_user_id')?.value;
      
      if (userIdValue) {
        const supabase = createServerClient();
        const { data: user } = await supabase
          .from('users')
          .select('role')
          .eq('id', userIdValue)
          .single();

        // If admin trying to access root, redirect to admin
        if (user?.role === 'admin') {
          return NextResponse.redirect(new URL('/admin', request.url));
        }
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
