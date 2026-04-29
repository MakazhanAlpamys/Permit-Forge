// ============================================================================
// Health Check Endpoint (public, no auth required)
// ============================================================================
// L1: minimal response — only {status, timestamp}. Don't disclose which check
// failed (env vs DB), service topology, or env-var names to unauthenticated
// callers; that information is only useful to operators (who can read logs).

import { createAdminClient } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

export async function GET() {
  let healthy = true;

  // Required env vars — fail health if any missing.
  const requiredEnvVars = [
    'NEXT_PUBLIC_SUPABASE_URL',
    'SUPABASE_ANON_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'GEMINI_API_KEY',
    'JWT_SECRET',
  ];
  if (requiredEnvVars.some(v => !process.env[v])) {
    healthy = false;
  }

  // DB connectivity probe — log details but don't return them.
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

  return Response.json(
    {
      status: healthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
    },
    { status: healthy ? 200 : 503 }
  );
}
