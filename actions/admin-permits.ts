'use server';

// ============================================================================
// Admin Permit Server Actions
// ============================================================================

import { createAdminClient, createServerClient } from '@/lib/supabase-server';
import { logAuditEvent, getRequestMetadata } from '@/lib/auth';
import { requireAdmin } from '@/lib/security';
import { uuidSchema, reviewPermitSchema, type ReviewPermitInput } from '@/lib/validations';
import type { PermitApplication, PermitStats } from '@/types';

export type { ReviewPermitInput };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function transformPermit(row: any): PermitApplication & { username?: string } {
  return {
    id: row.id,
    userId: row.user_id,
    status: row.status,
    projectName: row.project_name,
    projectType: row.project_type,
    projectAddress: row.project_address,
    plotNumber: row.plot_number || undefined,
    projectDescription: row.project_description || undefined,
    buildingDetails: row.building_details || {},
    complianceRequirements: row.compliance_requirements || {},
    complianceCheckResult: row.compliance_check_result || null,
    reviewedBy: row.reviewed_by || null,
    reviewedAt: row.reviewed_at || null,
    reviewComments: row.review_comments || null,
    submittedAt: row.submitted_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    username: row.users?.username || undefined,
  };
}

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
      error: error instanceof Error ? error.message : 'Failed to fetch permits',
    };
  }
}

// -----------------------------------------------------------------------------
// Review Permit (Approve/Reject)
// -----------------------------------------------------------------------------

export async function reviewPermit(
  data: ReviewPermitInput
): Promise<{ success: boolean; error?: string }> {
  try {
    const authCheck = await requireAdmin();
    if (!authCheck.success || !authCheck.user) {
      return { success: false, error: authCheck.error };
    }

    const validation = reviewPermitSchema.safeParse(data);
    if (!validation.success) {
      return { success: false, error: validation.error.issues[0].message };
    }

    const { permitId, action, comments } = validation.data;
    const newStatus = action === 'approve' ? 'approved' : 'rejected';

    const supabase = createAdminClient();

    // Verify permit exists and is reviewable
    const { data: permit } = await supabase
      .from('permit_applications')
      .select('status')
      .eq('id', permitId)
      .single();

    if (!permit) {
      return { success: false, error: 'Permit not found' };
    }

    if (permit.status !== 'submitted' && permit.status !== 'under_review') {
      return { success: false, error: 'Permit is not in a reviewable state' };
    }

    const { error } = await supabase
      .from('permit_applications')
      .update({
        status: newStatus,
        reviewed_by: authCheck.user.id,
        reviewed_at: new Date().toISOString(),
        review_comments: comments,
      })
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
      action: 'permit_reviewed',
      metadata: { permitId, decision: action, comments },
      ...metadata,
    });

    return { success: true };
  } catch (error) {
    console.error('reviewPermit error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to review permit',
    };
  }
}

// -----------------------------------------------------------------------------
// Set Permit Under Review
// -----------------------------------------------------------------------------

export async function setPermitUnderReview(
  permitId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const authCheck = await requireAdmin();
    if (!authCheck.success || !authCheck.user) {
      return { success: false, error: authCheck.error };
    }

    const idValidation = uuidSchema.safeParse(permitId);
    if (!idValidation.success) {
      return { success: false, error: 'Invalid permit ID' };
    }

    const supabase = createAdminClient();
    const { data: permit } = await supabase
      .from('permit_applications')
      .select('status')
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

    return { success: true };
  } catch (error) {
    console.error('setPermitUnderReview error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update permit status',
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
        permitsToday: Number(stats.permits_today) || 0,
      },
    };
  } catch (error) {
    console.error('getPermitStats error:', error);
    return {
      data: null,
      error: error instanceof Error ? error.message : 'Failed to fetch permit stats',
    };
  }
}
