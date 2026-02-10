// ============================================================================
// Health Check Endpoint (public, no auth required)
// ============================================================================

import { createAdminClient } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

export async function GET() {
  const checks: Record<string, { status: string; message?: string }> = {};
  let healthy = true;

  // Check required environment variables
  const requiredEnvVars = [
    'NEXT_PUBLIC_SUPABASE_URL',
    'SUPABASE_ANON_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'GEMINI_API_KEY',
    'JWT_SECRET',
  ];

  const missingVars = requiredEnvVars.filter(v => !process.env[v]);
  if (missingVars.length > 0) {
    checks.env = { status: 'fail', message: `Missing: ${missingVars.join(', ')}` };
    healthy = false;
  } else {
    checks.env = { status: 'ok' };
  }

  // Check Supabase database connectivity
  try {
    const supabase = createAdminClient();
    const { error } = await supabase.from('users').select('id').limit(1);
    if (error) {
      checks.database = { status: 'fail', message: error.message };
      healthy = false;
    } else {
      checks.database = { status: 'ok' };
    }
  } catch (error) {
    checks.database = {
      status: 'fail',
      message: error instanceof Error ? error.message : 'Connection failed',
    };
    healthy = false;
  }

  return Response.json(
    {
      status: healthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      checks,
    },
    { status: healthy ? 200 : 503 }
  );
}
