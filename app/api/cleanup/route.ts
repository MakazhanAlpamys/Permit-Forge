// ============================================================================
// Database Cleanup API Route (Admin only)
// ============================================================================

import { getQuickSession } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase-server';

export async function POST() {
  try {
    const user = await getQuickSession();
    if (!user || user.role !== 'admin') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const supabase = createAdminClient();
    const { data, error } = await supabase.rpc('run_all_cleanup', {
      session_retention_days: 90,
      audit_retention_days: 365,
    });

    if (error) {
      console.error('Cleanup RPC error:', error);
      return Response.json({ error: 'Cleanup failed', details: error.message }, { status: 500 });
    }

    const result = Array.isArray(data) ? data[0] : data;

    return Response.json({
      status: 'ok',
      cleaned: {
        sessions: result?.sessions_deleted ?? 0,
        auditLogs: result?.audit_logs_deleted ?? 0,
        rateLimits: result?.rate_limits_deleted ?? 0,
      },
    });
  } catch (error) {
    console.error('Cleanup error:', error);
    return Response.json({ error: 'Cleanup failed' }, { status: 500 });
  }
}
