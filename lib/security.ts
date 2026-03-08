// ============================================================================
// Security Utilities (Server-side only)
// ============================================================================
// Common security functions for Server Actions and API Routes
// ============================================================================

import { getQuickSession, logAuditEvent, getRequestMetadata, validateCSRFToken } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase-server';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface AuthenticatedUser {
  id: string;
  username: string;
  role: 'admin' | 'user';
}

export interface SecurityCheckResult {
  success: boolean;
  user?: AuthenticatedUser;
  error?: string;
}

// -----------------------------------------------------------------------------
// Authentication Check
// -----------------------------------------------------------------------------

/**
 * Verify user is authenticated
 * Returns user data or error
 */
export async function requireAuth(): Promise<SecurityCheckResult> {
  try {
    const user = await getQuickSession();
    
    if (!user) {
      return {
        success: false,
        error: 'Authentication required'
      };
    }

    // Verify user is not blocked (JWT alone doesn't reflect current block status)
    const supabase = createAdminClient();
    const { data: dbUser } = await supabase
      .from('users')
      .select('blocked')
      .eq('id', user.id)
      .single();

    if (dbUser?.blocked) {
      return {
        success: false,
        error: 'Your account has been blocked',
      };
    }

    return {
      success: true,
      user
    };
  } catch (error) {
    console.error('Auth check error:', error);
    return { 
      success: false, 
      error: 'Authentication failed' 
    };
  }
}

// -----------------------------------------------------------------------------
// Admin Authorization Check
// -----------------------------------------------------------------------------

/**
 * Verify user is authenticated AND has admin role
 * Logs unauthorized attempts
 */
export async function requireAdmin(): Promise<SecurityCheckResult> {
  const authResult = await requireAuth();
  
  if (!authResult.success || !authResult.user) {
    return authResult;
  }
  
  if (authResult.user.role !== 'admin') {
    // Log unauthorized admin access attempt
    try {
      const metadata = await getRequestMetadata();
      await logAuditEvent({
        userId: authResult.user.id,
        action: 'login_failed', // Using existing action type
        metadata: { 
          reason: 'unauthorized_admin_attempt',
          attemptedRole: 'admin',
          actualRole: authResult.user.role,
        },
        ...metadata,
      });
    } catch (e) {
      console.error('Failed to log security event:', e);
    }
    
    return { 
      success: false, 
      error: 'Unauthorized: Admin access required' 
    };
  }
  
  return authResult;
}

// -----------------------------------------------------------------------------
// CSRF Validation
// -----------------------------------------------------------------------------

/**
 * Validate CSRF token from client.
 * Returns { valid: true } or { valid: false, error: string }
 */
export async function requireCSRF(token: string | undefined | null): Promise<{ valid: boolean; error?: string }> {
  if (!token) {
    return { valid: false, error: 'CSRF token missing' };
  }

  const isValid = await validateCSRFToken(token);
  if (!isValid) {
    return { valid: false, error: 'CSRF token invalid' };
  }

  return { valid: true };
}
