'use server';

// ============================================================================
// Admin Permit Server Actions
// ============================================================================

import { createAdminClient } from '@/lib/supabase-server';
import { logAuditEvent, getRequestMetadata } from '@/lib/auth';
import { requireAdmin, requireCSRF } from '@/lib/security';
import { uuidSchema, reviewPermitSchema, type ReviewPermitInput } from '@/lib/validations';
import type { PermitApplication, PermitStats } from '@/types';
import { transformPermit } from '@/lib/transforms';

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

    return { data: (data || []).map(transformPermit) };
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
): Promise<{ success: boolean; error?: string }> {
  try {
    const authCheck = await requireAdmin();
    if (!authCheck.success || !authCheck.user) {
      return { success: false, error: authCheck.error };
    }

    const csrf = await requireCSRF(csrfToken);
    if (!csrf.valid) return { success: false, error: csrf.error };

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

    // Verify permit exists and is reviewable
    const { data: permit } = await supabase
      .from('permit_applications')
      .select('status, user_id, project_name')
      .eq('id', permitId)
      .single();

    if (!permit) {
      return { success: false, error: 'Permit not found' };
    }

    if (permit.status !== 'submitted' && permit.status !== 'under_review') {
      return { success: false, error: 'Permit is not in a reviewable state' };
    }

    // Build update data
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateData: any = {
      status: newStatus,
      reviewed_by: authCheck.user.id,
      reviewed_at: new Date().toISOString(),
      review_comments: comments,
    };

    // For revision requests, also store revision notes
    if (action === 'request_revision') {
      updateData.revision_notes = comments;
    }

    const { error } = await supabase
      .from('permit_applications')
      .update(updateData)
      .eq('id', permitId);

    if (error) throw error;

    await supabase.from('permit_status_history').insert({
      permit_id: permitId,
      from_status: permit.status,
      to_status: newStatus,
      changed_by: authCheck.user.id,
      comment: comments,
    });

    const metadata = await getRequestMetadata();
    await logAuditEvent({
      userId: authCheck.user.id,
      action: action === 'request_revision' ? 'permit_revision_requested' : 'permit_reviewed',
      metadata: { permitId, decision: action, comments },
      ...metadata,
    });

    // Send notification to permit owner
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
    } catch { /* notification failure should not break review */ }

    return { success: true };
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
): Promise<{ success: boolean; error?: string }> {
  try {
    const authCheck = await requireAdmin();
    if (!authCheck.success || !authCheck.user) {
      return { success: false, error: authCheck.error };
    }

    const csrf = await requireCSRF(csrfToken);
    if (!csrf.valid) return { success: false, error: csrf.error };

    const idValidation = uuidSchema.safeParse(permitId);
    if (!idValidation.success) {
      return { success: false, error: 'Invalid permit ID' };
    }

    const supabase = createAdminClient();
    const { data: permit } = await supabase
      .from('permit_applications')
      .select('status, user_id, project_name')
      .eq('id', permitId)
      .single();

    if (!permit) {
      return { success: false, error: 'Permit not found' };
    }

    if (permit.status !== 'submitted') {
      return { success: false, error: 'Can only review submitted permits' };
    }

    const { error } = await supabase
      .from('permit_applications')
      .update({ status: 'under_review' })
      .eq('id', permitId);

    if (error) throw error;

    await supabase.from('permit_status_history').insert({
      permit_id: permitId,
      from_status: 'submitted',
      to_status: 'under_review',
      changed_by: authCheck.user.id,
      comment: 'Review started',
    });

    // Notify permit owner
    try {
      const { createNotification, getNotificationContent } = await import('@/lib/notifications');
      const content = getNotificationContent('permit_under_review', permit.project_name);
      await createNotification({
        userId: permit.user_id,
        type: 'permit_under_review',
        ...content,
        data: { permitId, permitName: permit.project_name },
      });
    } catch { /* notification failure should not break status change */ }

    return { success: true };
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
