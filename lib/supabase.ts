// ============================================================================
// Supabase Client Configuration
// ============================================================================

import { createClient } from '@supabase/supabase-js';

// Environment variables validation
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl) {
  throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL environment variable');
}

// -----------------------------------------------------------------------------
// Server Client (for server-side operations)
// Uses service role key to bypass RLS for admin operations
// -----------------------------------------------------------------------------
export function createServerClient() {
  if (!supabaseServiceRoleKey) {
    throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY environment variable');
  }
  
  return createClient(supabaseUrl!, supabaseServiceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
