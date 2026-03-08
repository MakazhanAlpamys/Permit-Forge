// ============================================================================
// Supabase Server Client (SERVICE_ROLE - Bypasses RLS)
// ============================================================================
// ⚠️ WARNING: This file should ONLY be imported in Server Actions and API routes
// NEVER import this file in client components ('use client')
// ============================================================================

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  RATE_LIMIT_WINDOW_SECONDS,
  MAX_REQUESTS_PER_WINDOW,
  MIN_REQUEST_INTERVAL_MS,
} from './constants';

// -----------------------------------------------------------------------------
// Environment Variables Validation (Server-side only)
// -----------------------------------------------------------------------------

function getSupabaseUrl(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) {
    throw new Error(
      'Configuration error: NEXT_PUBLIC_SUPABASE_URL environment variable is missing.'
    );
  }
  return url;
}

function getServiceRoleKey(): string {
  // This key should NEVER have NEXT_PUBLIC_ prefix
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    throw new Error(
      'Configuration error: SUPABASE_SERVICE_ROLE_KEY environment variable is missing.'
    );
  }
  return key;
}

function getAnonKey(): string {
  // For server-side operations that should respect RLS
  const key = process.env.SUPABASE_ANON_KEY;
  if (!key) {
    throw new Error(
      'Configuration error: SUPABASE_ANON_KEY environment variable is missing.'
    );
  }
  return key;
}

// -----------------------------------------------------------------------------
// Admin Client (SERVICE_ROLE - Bypasses RLS)
// Use ONLY for admin operations: user management, analytics, etc.
// Singleton: safe to reuse because autoRefreshToken and persistSession are false.
// -----------------------------------------------------------------------------

let _adminClient: SupabaseClient | null = null;

export function createAdminClient(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(getSupabaseUrl(), getServiceRoleKey(), {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });
  }
  return _adminClient;
}

// -----------------------------------------------------------------------------
// Server Client (ANON KEY - Respects RLS)
// Use for user operations that should be restricted by RLS policies
// -----------------------------------------------------------------------------

export function createServerClient(): SupabaseClient {
  return createClient(getSupabaseUrl(), getAnonKey(), {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

// -----------------------------------------------------------------------------
// Rate Limiting Helper
// -----------------------------------------------------------------------------

interface RateLimitResult {
  allowed: boolean;
  retryAfterMs?: number;
  currentCount?: number;
}

// Rate limit constants imported from @/lib/constants

export async function checkRateLimit(userId: string): Promise<RateLimitResult> {
  try {
    // Use admin client to bypass RLS for rate limit check
    const supabase = createAdminClient();

    const { data, error } = await supabase.rpc('check_rate_limit', {
      p_user_id: userId,
      p_window_seconds: RATE_LIMIT_WINDOW_SECONDS,
      p_max_requests: MAX_REQUESTS_PER_WINDOW,
      p_min_interval_ms: MIN_REQUEST_INTERVAL_MS,
    });

    if (error) {
      console.error('Rate limit check error:', error.message || error);
      // IMPORTANT: On error, deny the request (fail-safe)
      return { allowed: false, retryAfterMs: 5000 };
    }

    const result = data?.[0];

    if (!result) {
      // No result means something is wrong, deny request
      return { allowed: false, retryAfterMs: 5000 };
    }

    return {
      allowed: result.allowed,
      retryAfterMs: result.allowed ? undefined : result.retry_after_ms,
      currentCount: result.current_count,
    };
  } catch (error) {
    console.error('Rate limit error:', error instanceof Error ? error.message : error);
    // IMPORTANT: On error, deny the request (fail-safe)
    return { allowed: false, retryAfterMs: 5000 };
  }
}

