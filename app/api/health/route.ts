// ============================================================================
// Health Check Endpoint (public, no auth required)
// ============================================================================

import { createAdminClient } from '@/lib/supabase-server';
import { applySecurityHeaders } from '@/lib/api-security-headers';

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
    // SECURITY: Don't reveal env variable names to unauthenticated users
    checks.env = { status: 'fail', message: `${missingVars.length} required variable(s) not configured` };
    healthy = false;
  } else {
    checks.env = { status: 'ok' };
  }

  // Check Supabase database connectivity
  try {
    const supabase = createAdminClient();
    const { error } = await supabase.from('users').select('id').limit(1);
    if (error) {
      console.error('Health check DB error:', error.message);
      checks.database = { status: 'fail', message: 'Database connection failed' };
      healthy = false;
    } else {
      checks.database = { status: 'ok' };
    }
  } catch (error) {
    console.error('Health check DB error:', error instanceof Error ? error.message : error);
    checks.database = {
      status: 'fail',
      message: 'Database connection failed',
    };
    healthy = false;
  }

  return applySecurityHeaders(
    Response.json(
      {
        status: healthy ? 'ok' : 'degraded',
        timestamp: new Date().toISOString(),
        checks,
      },
      { status: healthy ? 200 : 503 }
    )
  );
}
