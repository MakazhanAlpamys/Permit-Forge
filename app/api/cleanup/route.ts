// ============================================================================
// Database Cleanup API Route (Admin only)
// ============================================================================

import { getQuickSession, logAuditEvent, getRequestMetadata } from '@/lib/auth';
import { createAdminClient, checkRateLimit } from '@/lib/supabase-server';

export async function POST() {
  try {
    const user = await getQuickSession();
    if (!user || user.role !== 'admin') {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // SECURITY: Add rate limiting to prevent abuse
    const rateLimitResult = await checkRateLimit(user.id);
    if (!rateLimitResult.allowed) {
      return Response.json({
        error: 'Rate limited',
        retryAfter: rateLimitResult.retryAfterMs,
      }, { status: 429 });
    }

    const supabase = createAdminClient();
    const { data, error } = await supabase.rpc('run_all_cleanup', {
      session_retention_days: 90,
      audit_retention_days: 365,
    });

    if (error) {
      console.error('Cleanup RPC error:', error);
      return Response.json({ error: 'Cleanup failed' }, { status: 500 });
    }

    const result = Array.isArray(data) ? data[0] : data;

    // SECURITY: Log cleanup actions for audit trail
    try {
      const metadata = await getRequestMetadata();
      await logAuditEvent({
        userId: user.id,
        action: 'database_cleanup',
        metadata: {
          sessions_deleted: result?.sessions_deleted ?? 0,
          audit_logs_deleted: result?.audit_logs_deleted ?? 0,
          rate_limits_deleted: result?.rate_limits_deleted ?? 0,
        },
        ...metadata,
      });
    } catch (auditError) {
      console.error('Failed to log cleanup action:', auditError);
      // Don't fail the response if audit logging fails
    }

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
