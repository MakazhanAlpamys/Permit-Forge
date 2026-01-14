// ============================================================================
// Supabase Client Configuration (Multi-tier Access)
// ============================================================================

import { createClient, SupabaseClient } from '@supabase/supabase-js';

// -----------------------------------------------------------------------------
// Environment Variables Validation (lazy - don't throw at module load)
// -----------------------------------------------------------------------------

function getSupabaseUrl(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) {
    throw new Error('Configuration error: NEXT_PUBLIC_SUPABASE_URL environment variable is missing. Please set it in your .env file.');
  }
  return url;
}

function getAnonKey(): string {
  const key = process.env.SUPABASE_ANON_KEY;
  if (!key) {
    throw new Error('Configuration error: SUPABASE_ANON_KEY environment variable is missing. Please set it in your .env file.');
  }
  return key;
}

function getServiceRoleKey(): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    throw new Error('Configuration error: SUPABASE_SERVICE_ROLE_KEY environment variable is missing. Please set it in your .env file.');
  }
  return key;
}

// -----------------------------------------------------------------------------
// Public Client (respects RLS - use for user-facing operations)
// Creates a new client each time to avoid issues in serverless environment
// -----------------------------------------------------------------------------

export function createPublicClient(): SupabaseClient {
  return createClient(getSupabaseUrl(), getAnonKey(), {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

// -----------------------------------------------------------------------------
// Server Client (bypasses RLS - use ONLY for admin operations)
// Uses service role key - be careful with this!
// Creates a new client each time to avoid issues in serverless environment
// -----------------------------------------------------------------------------

export function createServerClient(): SupabaseClient {
  return createClient(getSupabaseUrl(), getServiceRoleKey(), {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

// -----------------------------------------------------------------------------
// Rate Limiting Helper (consolidated)
// -----------------------------------------------------------------------------

interface RateLimitResult {
  allowed: boolean;
  retryAfterMs?: number;
  currentCount?: number;
}

const RATE_LIMIT_WINDOW_SECONDS = 60;
const MAX_REQUESTS_PER_WINDOW = 10;
const MIN_REQUEST_INTERVAL_MS = 2000;

export async function checkRateLimit(userId: string): Promise<RateLimitResult> {
  try {
    const supabase = createServerClient();
    
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
