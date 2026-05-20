// ============================================================================
// Health Check Endpoint (public, no auth required)
// ============================================================================
// C26H/L1: respond with the bare minimum needed for a load balancer to
// decide live/not-live. We still run the DB ping internally and downgrade
// to 503 on failure, but we don't echo back which env vars are missing or
// whether the DB specifically failed — that's information an attacker can
// use to map our infrastructure.

import { createAdminClient } from '@/lib/supabase-server';
import { applySecurityHeaders } from '@/lib/api-security-headers';

export const dynamic = 'force-dynamic';

const REQUIRED_ENV_VARS = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'GEMINI_API_KEY',
  'JWT_SECRET',
];

export async function GET() {
  let healthy = REQUIRED_ENV_VARS.every((v) => !!process.env[v]);

  if (healthy) {
    try {
      const supabase = createAdminClient();
      const { error } = await supabase.from('users').select('id').limit(1);
      if (error) {
        console.error('Health check DB error:', error.message);
        healthy = false;
      }
    } catch (error) {
      console.error('Health check DB error:', error instanceof Error ? error.message : error);
      healthy = false;
    }
  }

  return applySecurityHeaders(
    Response.json({ ok: healthy }, { status: healthy ? 200 : 503 }),
  );
}
