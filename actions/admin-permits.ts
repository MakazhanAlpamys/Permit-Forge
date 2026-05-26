'use server';

// ============================================================================
// Admin Permit Server Actions
// ============================================================================

import { revalidatePath } from 'next/cache';
import { createAdminClient } from '@/lib/supabase-server';
import { logAuditWithMeta } from '@/lib/auth';
import { requireAdmin, requireCSRF, requireActionRateLimit } from '@/lib/security';
import { uuidSchema, reviewPermitSchema, type ReviewPermitInput } from '@/lib/validations';
import type { PermitApplication, PermitStats } from '@/types';
import { rowsToPermits, firstRpcRow } from '@/lib/transforms';

export type { ReviewPermitInput };

// -----------------------------------------------------------------------------
// Get All Permits (Admin)
// -----------------------------------------------------------------------------

export async function getAdminPermits(
  status?: string,
  limit: number = 50,
  offset: number = 0
): Promise<{ data: (PermitApplication & { username?: string })[]; error?: string }> {
  try {
    const authCheck = await requireAdmin();
    if (!authCheck.success || !authCheck.user) {
      return { data: [], error: authCheck.error };
    }

    const supabase = createAdminClient();
    let query = supabase
      .from('permit_applications')
      .select('*, users!permit_applications_user_id_fkey(username)')
      .order('updated_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status && status !== 'all') {
      query = query.eq('status', status);
    }

    const { data, error } = await query;

    if (error) throw error;

    // TS-H-1 / v1.6.0 Part A: rowsToPermits centralises the boundary cast.
    return { data: rowsToPermits(data) };
  } catch (error) {
    console.error('getAdminPermits error:', error);
    return {
      data: [],
      error: 'Failed to fetch permits',
    };
  }
}

// -----------------------------------------------------------------------------
// Review Permit (Approve/Reject/Request Revision)
// -----------------------------------------------------------------------------

export async function reviewPermit(
  data: ReviewPermitInput,
  csrfToken?: string
): Promise<{ success: boolean; error?: string; warning?: string }> {
  try {
    const authCheck = await requireAdmin();
    if (!authCheck.success || !authCheck.user) {
      return { success: false, error: authCheck.error };
    }

    const csrf = await requireCSRF(csrfToken);
    if (!csrf.valid) return { success: false, error: csrf.error };

    const rl = await requireActionRateLimit(authCheck.user.id, 'reviewPermit');
    if (!rl.allowed) return { success: false, error: rl.error };

    const validation = reviewPermitSchema.safeParse(data);
    if (!validation.success) {
      return { success: false, error: validation.error.issues[0].message };
    }

    const { permitId, action, comments } = validation.data;
    const newStatus = action === 'approve'
      ? 'approved'
      : action === 'request_revision'
        ? 'revision_requested'
        : 'rejected';

    const supabase = createAdminClient();

    // C17H/M6: atomic UPDATE + permit_status_history INSERT. The RPC takes
    // FOR UPDATE on the permit row internally and refuses to transition out
    // of any non-reviewable status, so this replaces the previous SELECT-
    // then-UPDATE-with-status-guard sequence.
    const { data: rpcRows, error } = await supabase.rpc('review_permit_atomic', {
      p_permit_id: permitId,
      p_admin_id: authCheck.user.id,
      p_new_status: newStatus,
      p_comments: comments ?? null,
    });

    if (error) {
      const msg = error.message ?? '';
      if (msg.includes('PERMIT_NOT_FOUND')) {
        return { success: false, error: 'Permit not found' };
      }
      throw error;
    }

    const rpcResult = firstRpcRow<{
      status_changed?: boolean;
      project_name?: string;
      permit_user_id?: string;
    }>(rpcRows);

    if (!rpcResult?.status_changed) {
      return { success: false, error: 'Permit status has changed. Please refresh and try again.' };
    }

    const permit = {
      user_id: rpcResult.permit_user_id ?? '',
      project_name: rpcResult.project_name ?? '',
    };

    await logAuditWithMeta(
      authCheck.user.id,
      action === 'request_revision' ? 'permit_revision_requested' : 'permit_reviewed',
      { metadata: { permitId, decision: action, comments } },
    );

    // B8: notify the permit owner. Failure must not roll back the review
    // (the DB transition already committed) but the admin should see a warning
    // so they can manually contact the user if the notification didn't land.
    let notificationWarning: string | undefined;
    try {
      const { createNotification, getNotificationContent } = await import('@/lib/notifications');
      const notifType = action === 'approve'
        ? 'permit_approved' as const
        : action === 'request_revision'
          ? 'permit_revision_requested' as const
          : 'permit_rejected' as const;

      const content = getNotificationContent(notifType, permit.project_name, comments);
      await createNotification({
        userId: permit.user_id,
        type: notifType,
        ...content,
        data: { permitId, permitName: permit.project_name },
      });
    } catch (notifyError) {
      console.error('reviewPermit notification failed:', notifyError);
      notificationWarning = 'Decision recorded, but the applicant notification could not be delivered.';
    }

    // X15: a permit's status just changed. Invalidate the user-facing
    // /permits list and the permit detail page so the owner sees the new
    // state on next mount in any open tab.
    revalidatePath('/permits');
    revalidatePath(`/permits/${permitId}`);
    revalidatePath('/admin');

    return notificationWarning
      ? { success: true, warning: notificationWarning }
      : { success: true };
  } catch (error) {
    console.error('reviewPermit error:', error);
    return {
      success: false,
      error: 'Failed to review permit',
    };
  }
}

// -----------------------------------------------------------------------------
// Set Permit Under Review
// -----------------------------------------------------------------------------

export async function setPermitUnderReview(
  permitId: string,
  csrfToken?: string
): Promise<{ success: boolean; error?: string; warning?: string }> {
  try {
    const authCheck = await requireAdmin();
    if (!authCheck.success || !authCheck.user) {
      return { success: false, error: authCheck.error };
    }

    const csrf = await requireCSRF(csrfToken);
    if (!csrf.valid) return { success: false, error: csrf.error };

    const rl = await requireActionRateLimit(authCheck.user.id, 'setPermitUnderReview');
    if (!rl.allowed) return { success: false, error: rl.error };

    const idValidation = uuidSchema.safeParse(permitId);
    if (!idValidation.success) {
      return { success: false, error: 'Invalid permit ID' };
    }

    const supabase = createAdminClient();

    // A-C-5 / v1.3.0 Part D: atomic SELECT + UPDATE + permit_status_history
    // INSERT via start_review_permit_atomic. Replaces the previous 3-statement
    // SELECT → UPDATE → INSERT sequence where a history-INSERT failure left
    // the permit in `under_review` with no audit row.
    const { data: rpcRows, error } = await supabase.rpc('start_review_permit_atomic', {
      p_permit_id: permitId,
      p_admin_id: authCheck.user.id,
    });

    if (error) {
      const msg = error.message ?? '';
      if (msg.includes('PERMIT_NOT_FOUND')) {
        return { success: false, error: 'Permit not found' };
      }
      throw error;
    }

    const rpcResult = firstRpcRow<{
      status_changed?: boolean;
      project_name?: string;
      permit_user_id?: string;
      prev_status?: string;
    }>(rpcRows);

    if (!rpcResult?.status_changed) {
      return { success: false, error: 'Permit status has changed. Please refresh and try again.' };
    }

    const permit = {
      user_id: rpcResult.permit_user_id ?? '',
      project_name: rpcResult.project_name ?? '',
    };

    // PR1 (v1.3.0 re-audit): record an explicit audit_logs row for the
    // submitted→under_review transition. permit_status_history already captures
    // the DB-level change, but admin-action queries hit audit_logs, so without
    // this entry "who started reviewing what, when" is unanswerable from the
    // admin pane.
    await logAuditWithMeta(authCheck.user.id, 'permit_review_started', {
      metadata: { permitId, prevStatus: rpcResult.prev_status ?? 'submitted' },
    });

    // B8: same pattern as reviewPermit — notification failure is reported as
    // a warning so the admin UI can surface it without rolling back the status.
    let notificationWarning: string | undefined;
    try {
      const { createNotification, getNotificationContent } = await import('@/lib/notifications');
      const content = getNotificationContent('permit_under_review', permit.project_name);
      await createNotification({
        userId: permit.user_id,
        type: 'permit_under_review',
        ...content,
        data: { permitId, permitName: permit.project_name },
      });
    } catch (notifyError) {
      console.error('setPermitUnderReview notification failed:', notifyError);
      notificationWarning = 'Status updated, but the applicant notification could not be delivered.';
    }

    // X15: status flipped to under_review — refresh user-facing list + detail.
    revalidatePath('/permits');
    revalidatePath(`/permits/${permitId}`);
    revalidatePath('/admin');

    return notificationWarning
      ? { success: true, warning: notificationWarning }
      : { success: true };
  } catch (error) {
    console.error('setPermitUnderReview error:', error);
    return {
      success: false,
      error: 'Failed to update permit status',
    };
  }
}

// -----------------------------------------------------------------------------
// Get Permit Statistics
// -----------------------------------------------------------------------------

export async function getPermitStats(): Promise<{ data: PermitStats | null; error?: string }> {
  try {
    const authCheck = await requireAdmin();
    if (!authCheck.success || !authCheck.user) {
      return { data: null, error: authCheck.error };
    }

    const supabase = createAdminClient();
    const { data, error } = await supabase.rpc('get_permit_stats');

    if (error) throw error;

    const stats = data?.[0];
    if (!stats) {
      return { data: null, error: 'No stats available' };
    }

    return {
      data: {
        totalPermits: Number(stats.total_permits) || 0,
        draftCount: Number(stats.draft_count) || 0,
        submittedCount: Number(stats.submitted_count) || 0,
        underReviewCount: Number(stats.under_review_count) || 0,
        approvedCount: Number(stats.approved_count) || 0,
        rejectedCount: Number(stats.rejected_count) || 0,
        revisionRequestedCount: Number(stats.revision_requested_count) || 0,
        permitsToday: Number(stats.permits_today) || 0,
      },
    };
  } catch (error) {
    console.error('getPermitStats error:', error);
    return {
      data: null,
      error: 'Failed to fetch permit stats',
    };
  }
}
