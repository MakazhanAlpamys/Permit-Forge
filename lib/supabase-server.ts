// ============================================================================
// Supabase Server Client (SERVICE_ROLE - Bypasses RLS)
// ============================================================================
// ⚠️ WARNING: This file should ONLY be imported in Server Actions and API routes
// NEVER import this file in client components ('use client')
// ============================================================================

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { SignJWT } from 'jose';
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
// User-Context Client (ANON KEY + minted user JWT — Respects RLS as that user)
// -----------------------------------------------------------------------------
//
// A2/C4: defense-in-depth for the ownership RLS policies introduced in A1.
// Callers that read on behalf of a specific user (chat history, permits list,
// permit detail, notifications) can use this instead of createAdminClient so
// that auth.uid() in the RLS policy resolves to the real user id and a logic
// bug in a server action can't accidentally read another user's rows.
//
// PREREQUISITE: SUPABASE_JWT_SECRET must be set (the Supabase project's JWT
// signing secret, found in Project Settings → API). If it is not set we fall
// back to createAdminClient() and log a one-time warning; behavior matches the
// pre-A2 state until the env var is configured.
//
// Do NOT use for cross-user reads or admin operations — those legitimately need
// service_role.

const SUPABASE_JWT_EXPIRY_S = 60 * 60; // 1 hour — refreshed on each call
let _missingSupabaseJwtSecretWarned = false;

function getSupabaseJwtSecret(): Uint8Array | null {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) return null;
  return new TextEncoder().encode(secret);
}

async function mintSupabaseUserJWT(userId: string): Promise<string | null> {
  const secret = getSupabaseJwtSecret();
  if (!secret) return null;
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({
    aud: 'authenticated',
    role: 'authenticated',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt(now)
    .setExpirationTime(now + SUPABASE_JWT_EXPIRY_S)
    .setIssuer('supabase')
    .sign(secret);
}

export async function createUserContextClient(userId: string): Promise<SupabaseClient> {
  const userJwt = await mintSupabaseUserJWT(userId);
  if (!userJwt) {
    if (!_missingSupabaseJwtSecretWarned) {
      _missingSupabaseJwtSecretWarned = true;
      console.warn(
        '[supabase] SUPABASE_JWT_SECRET not configured — createUserContextClient ' +
          'is falling back to service_role. RLS ownership policies (A1) will not engage ' +
          'until this env var is set. See LOCAL_NOTES.md.',
      );
    }
    return createAdminClient();
  }
  return createClient(getSupabaseUrl(), getAnonKey(), {
    global: { headers: { Authorization: `Bearer ${userJwt}` } },
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

export interface RateLimitOptions {
  /** Endpoint label — gives this caller its own bucket (C11H/C22H). */
  endpoint?: string;
  windowSeconds?: number;
  maxRequests?: number;
  minIntervalMs?: number;
}

export async function checkRateLimit(
  userId: string,
  options: RateLimitOptions = {},
): Promise<RateLimitResult> {
  try {
    // Use admin client to bypass RLS for rate limit check
    const supabase = createAdminClient();

    const { data, error } = await supabase.rpc('check_rate_limit', {
      p_user_id: userId,
      p_endpoint: options.endpoint ?? 'default',
      p_window_seconds: options.windowSeconds ?? RATE_LIMIT_WINDOW_SECONDS,
      p_max_requests: options.maxRequests ?? MAX_REQUESTS_PER_WINDOW,
      p_min_interval_ms: options.minIntervalMs ?? MIN_REQUEST_INTERVAL_MS,
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

