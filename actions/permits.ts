'use server';

// ============================================================================
// Permit Application Server Actions (User-Facing)
// ============================================================================

import { createAdminClient } from '@/lib/supabase-server';
import { getQuickSession, logAuditEvent, getRequestMetadata } from '@/lib/auth';
import { requireAuth, requireCSRF, verifyOwnership } from '@/lib/security';
import {
  uuidSchema,
  createPermitSchema,
  updateBuildingDetailsSchema,
  updateComplianceRequirementsSchema,
  type CreatePermitInput,
  type UpdateBuildingDetailsInput,
  type UpdateComplianceRequirementsInput,
} from '@/lib/validations';
import type {
  PermitApplication,
  PermitStatusHistoryEntry,
} from '@/types';
import { transformPermit } from '@/lib/transforms';
import { FILE_UPLOAD_LIMITS } from '@/lib/constants';

// Re-export input types for components
export type { CreatePermitInput, UpdateBuildingDetailsInput, UpdateComplianceRequirementsInput };

// -----------------------------------------------------------------------------
// Helper: Verify Permit Ownership — thin wrapper around the generic helper so
// existing callers stay readable. (F6 collapsed the body into lib/security.ts.)
// -----------------------------------------------------------------------------

async function verifyPermitOwnership(permitId: string, userId: string): Promise<boolean> {
  return verifyOwnership('permit_applications', 'id', permitId, userId);
}

// -----------------------------------------------------------------------------
// Create Permit Application (Draft)
// -----------------------------------------------------------------------------

export async function createPermit(
  data: CreatePermitInput,
  csrfToken: string
): Promise<{ success: boolean; permitId?: string; error?: string }> {
  try {
    const authCheck = await requireAuth();
    if (!authCheck.success || !authCheck.user) {
      return { success: false, error: authCheck.error };
    }

    const csrf = await requireCSRF(csrfToken);
    if (!csrf.valid) return { success: false, error: csrf.error };

    const validation = createPermitSchema.safeParse(data);
    if (!validation.success) {
      return { success: false, error: validation.error.issues[0].message };
    }

    const supabase = createAdminClient();
    const { data: permit, error } = await supabase
      .from('permit_applications')
      .insert({
        user_id: authCheck.user.id,
        status: 'draft',
        project_name: validation.data.projectName,
        project_type: validation.data.projectType,
        project_address: validation.data.projectAddress,
        plot_number: validation.data.plotNumber || null,
        project_description: validation.data.projectDescription || null,
      })
      .select('id')
      .single();

    if (error) throw error;

    // Record status history
    await supabase.from('permit_status_history').insert({
      permit_id: permit.id,
      from_status: null,
      to_status: 'draft',
      changed_by: authCheck.user.id,
      comment: 'Permit application created',
    });

    const metadata = await getRequestMetadata();
    await logAuditEvent({
      userId: authCheck.user.id,
      action: 'permit_created',
      metadata: { permitId: permit.id, projectName: validation.data.projectName },
      ...metadata,
    });

    return { success: true, permitId: permit.id };
  } catch (error) {
    console.error('createPermit error:', error);
    return {
      success: false,
      error: 'Failed to create permit',
    };
  }
}

// -----------------------------------------------------------------------------
// Update Building Details (Step 2)
// -----------------------------------------------------------------------------

export async function updatePermitBuildingDetails(
  data: UpdateBuildingDetailsInput,
  csrfToken: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const authCheck = await requireAuth();
    if (!authCheck.success || !authCheck.user) {
      return { success: false, error: authCheck.error };
    }

    const csrf = await requireCSRF(csrfToken);
    if (!csrf.valid) return { success: false, error: csrf.error };

    const validation = updateBuildingDetailsSchema.safeParse(data);
    if (!validation.success) {
      return { success: false, error: validation.error.issues[0].message };
    }

    const isOwner = await verifyPermitOwnership(validation.data.permitId, authCheck.user.id);
    if (!isOwner) {
      return { success: false, error: 'Access denied' };
    }

    // Verify status is draft
    const supabase = createAdminClient();
    const { data: permit } = await supabase
      .from('permit_applications')
      .select('status')
      .eq('id', validation.data.permitId)
      .single();

    if (permit?.status !== 'draft') {
      return { success: false, error: 'Can only edit draft permits' };
    }

    const { error } = await supabase
      .from('permit_applications')
      .update({ building_details: validation.data.buildingDetails })
      .eq('id', validation.data.permitId)
      .eq('user_id', authCheck.user.id);

    if (error) throw error;

    return { success: true };
  } catch (error) {
    console.error('updatePermitBuildingDetails error:', error);
    return {
      success: false,
      error: 'Failed to update building details',
    };
  }
}

// -----------------------------------------------------------------------------
// Update Compliance Requirements (Step 3)
// -----------------------------------------------------------------------------

export async function updatePermitComplianceRequirements(
  data: UpdateComplianceRequirementsInput,
  csrfToken: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const authCheck = await requireAuth();
    if (!authCheck.success || !authCheck.user) {
      return { success: false, error: authCheck.error };
    }

    const csrf = await requireCSRF(csrfToken);
    if (!csrf.valid) return { success: false, error: csrf.error };

    const validation = updateComplianceRequirementsSchema.safeParse(data);
    if (!validation.success) {
      return { success: false, error: validation.error.issues[0].message };
    }

    const isOwner = await verifyPermitOwnership(validation.data.permitId, authCheck.user.id);
    if (!isOwner) {
      return { success: false, error: 'Access denied' };
    }

    const supabase = createAdminClient();
    const { data: permit } = await supabase
      .from('permit_applications')
      .select('status')
      .eq('id', validation.data.permitId)
      .single();

    if (permit?.status !== 'draft') {
      return { success: false, error: 'Can only edit draft permits' };
    }

    const { error } = await supabase
      .from('permit_applications')
      .update({ compliance_requirements: validation.data.complianceRequirements })
      .eq('id', validation.data.permitId)
      .eq('user_id', authCheck.user.id);

    if (error) throw error;

    return { success: true };
  } catch (error) {
    console.error('updatePermitComplianceRequirements error:', error);
    return {
      success: false,
      error: 'Failed to update compliance requirements',
    };
  }
}

// -----------------------------------------------------------------------------
// Submit Permit Application
// -----------------------------------------------------------------------------

export async function submitPermit(
  permitId: string,
  csrfToken: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const authCheck = await requireAuth();
    if (!authCheck.success || !authCheck.user) {
      return { success: false, error: authCheck.error };
    }

    const csrf = await requireCSRF(csrfToken);
    if (!csrf.valid) return { success: false, error: csrf.error };

    const idValidation = uuidSchema.safeParse(permitId);
    if (!idValidation.success) {
      return { success: false, error: 'Invalid permit ID' };
    }

    const isOwner = await verifyPermitOwnership(permitId, authCheck.user.id);
    if (!isOwner) {
      return { success: false, error: 'Access denied' };
    }

    const supabase = createAdminClient();
    const { data: permit } = await supabase
      .from('permit_applications')
      .select('status, building_details, compliance_requirements, project_name, revision_count')
      .eq('id', permitId)
      .single();

    if (!permit) {
      return { success: false, error: 'Permit not found' };
    }

    if (permit.status !== 'draft' && permit.status !== 'revision_requested') {
      return { success: false, error: 'Can only submit draft or revision permits' };
    }

    // Check that building details and compliance requirements are filled
    const bd = permit.building_details;
    if (!bd || !bd.numberOfFloors || !bd.totalBuiltUpArea || !bd.plotArea || !bd.buildingHeight) {
      return { success: false, error: 'Please complete building details before submitting' };
    }

    const isResubmission = permit.status === 'revision_requested';

    const { error } = await supabase
      .from('permit_applications')
      .update({
        status: 'submitted',
        submitted_at: new Date().toISOString(),
        revision_count: isResubmission ? (permit.revision_count || 0) + 1 : permit.revision_count || 0,
        revision_notes: isResubmission ? null : undefined,
      })
      .eq('id', permitId)
      .eq('user_id', authCheck.user.id);

    if (error) throw error;

    await supabase.from('permit_status_history').insert({
      permit_id: permitId,
      from_status: permit.status,
      to_status: 'submitted',
      changed_by: authCheck.user.id,
      comment: isResubmission ? 'Application resubmitted after revision' : 'Application submitted for review',
    });

    const metadata = await getRequestMetadata();
    await logAuditEvent({
      userId: authCheck.user.id,
      action: 'permit_submitted',
      metadata: { permitId, isResubmission },
      ...metadata,
    });

    // Send notification
    try {
      const { createNotification, getNotificationContent } = await import('@/lib/notifications');
      const content = getNotificationContent('permit_submitted', permit.project_name);
      await createNotification({
        userId: authCheck.user.id,
        type: 'permit_submitted',
        ...content,
        data: { permitId, permitName: permit.project_name },
      });
    } catch { /* notification failure should not break submit */ }

    return { success: true };
  } catch (error) {
    console.error('submitPermit error:', error);
    return {
      success: false,
      error: 'Failed to submit permit',
    };
  }
}

// -----------------------------------------------------------------------------
// Get My Permits
// -----------------------------------------------------------------------------

export async function getMyPermits(): Promise<{ data: PermitApplication[]; error?: string }> {
  try {
    const user = await getQuickSession();
    if (!user) {
      return { data: [], error: 'Not authenticated' };
    }

    const supabase = createAdminClient();
    // List view only renders project_name, project_type, project_address,
    // status, plot_number, and the two timestamps (see permit-card.tsx). Skip
    // the heavy JSONB columns (building_details, compliance_requirements,
    // compliance_check_result) and free-text fields (project_description,
    // review_comments, revision_notes) — they balloon the payload and the
    // list never touches them.
    const { data, error } = await supabase
      .from('permit_applications')
      .select(
        'id, user_id, status, project_name, project_type, project_address, plot_number, ' +
          'reviewed_by, reviewed_at, revision_count, submitted_at, created_at, updated_at',
      )
      .eq('user_id', user.id)
      .order('updated_at', { ascending: false });

    if (error) throw error;

    return { data: (data || []).map(transformPermit) };
  } catch (error) {
    console.error('getMyPermits error:', error);
    return {
      data: [],
      error: 'Failed to fetch permits',
    };
  }
}

// -----------------------------------------------------------------------------
// Get Permit By ID
// -----------------------------------------------------------------------------

export async function getPermitById(
  permitId: string
): Promise<{ data: PermitApplication | null; error?: string }> {
  try {
    const user = await getQuickSession();
    if (!user) {
      return { data: null, error: 'Not authenticated' };
    }

    const idValidation = uuidSchema.safeParse(permitId);
    if (!idValidation.success) {
      return { data: null, error: 'Invalid permit ID' };
    }

    const supabase = createAdminClient();

    // Detail view needs every column transformPermit references.
    let query = supabase
      .from('permit_applications')
      .select(
        'id, user_id, status, project_name, project_type, project_address, plot_number, ' +
          'project_description, building_details, compliance_requirements, ' +
          'compliance_check_result, reviewed_by, reviewed_at, review_comments, ' +
          'revision_count, revision_notes, submitted_at, created_at, updated_at',
      )
      .eq('id', permitId);

    if (user.role !== 'admin') {
      query = query.eq('user_id', user.id);
    }

    const { data, error } = await query.single();

    if (error || !data) {
      return { data: null, error: error?.message || 'Permit not found' };
    }

    return { data: transformPermit(data) };
  } catch (error) {
    console.error('getPermitById error:', error);
    return {
      data: null,
      error: 'Failed to fetch permit',
    };
  }
}

// -----------------------------------------------------------------------------
// Get Permit Status History
// -----------------------------------------------------------------------------

export async function getPermitHistory(
  permitId: string
): Promise<{ data: PermitStatusHistoryEntry[]; error?: string }> {
  try {
    const user = await getQuickSession();
    if (!user) {
      return { data: [], error: 'Not authenticated' };
    }

    const idValidation = uuidSchema.safeParse(permitId);
    if (!idValidation.success) {
      return { data: [], error: 'Invalid permit ID' };
    }

    // Verify ownership or admin
    if (user.role !== 'admin') {
      const isOwner = await verifyPermitOwnership(permitId, user.id);
      if (!isOwner) {
        return { data: [], error: 'Access denied' };
      }
    }

    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from('permit_status_history')
      .select('id, permit_id, from_status, to_status, changed_by, comment, created_at')
      .eq('permit_id', permitId)
      .order('created_at', { ascending: true });

    if (error) throw error;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { data: (data || []).map((row: any) => ({
      id: row.id,
      permitId: row.permit_id,
      fromStatus: row.from_status,
      toStatus: row.to_status,
      changedBy: row.changed_by,
      comment: row.comment || undefined,
      createdAt: row.created_at,
    })) };
  } catch (error) {
    console.error('getPermitHistory error:', error);
    return {
      data: [],
      error: 'Failed to fetch history',
    };
  }
}

// -----------------------------------------------------------------------------
// Delete Permit (Draft Only)
// -----------------------------------------------------------------------------

export async function deletePermit(
  permitId: string,
  csrfToken: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const authCheck = await requireAuth();
    if (!authCheck.success || !authCheck.user) {
      return { success: false, error: authCheck.error };
    }

    const csrf = await requireCSRF(csrfToken);
    if (!csrf.valid) return { success: false, error: csrf.error };

    const idValidation = uuidSchema.safeParse(permitId);
    if (!idValidation.success) {
      return { success: false, error: 'Invalid permit ID' };
    }

    const isOwner = await verifyPermitOwnership(permitId, authCheck.user.id);
    if (!isOwner) {
      return { success: false, error: 'Access denied' };
    }

    const supabase = createAdminClient();
    const { data: permit } = await supabase
      .from('permit_applications')
      .select('status')
      .eq('id', permitId)
      .single();

    if (permit?.status !== 'draft') {
      return { success: false, error: 'Can only delete draft permits' };
    }

    // Fetch attachment paths before deleting (needed for storage cleanup after DB delete)
    const { data: attachments } = await supabase
      .from('permit_attachments')
      .select('storage_path')
      .eq('permit_id', permitId);

    // Delete permit record FIRST — if this fails, no files are touched (prevents orphans)
    const { error } = await supabase
      .from('permit_applications')
      .delete()
      .eq('id', permitId)
      .eq('user_id', authCheck.user.id);

    if (error) throw error;

    // Only clean up storage after the DB delete succeeds
    if (attachments && attachments.length > 0) {
      const paths = attachments.map((a: { storage_path: string }) => a.storage_path);
      await supabase.storage
        .from(FILE_UPLOAD_LIMITS.storageBucket)
        .remove(paths);
    }

    const metadata = await getRequestMetadata();
    await logAuditEvent({
      userId: authCheck.user.id,
      action: 'permit_deleted',
      metadata: { permitId },
      ...metadata,
    });

    return { success: true };
  } catch (error) {
    console.error('deletePermit error:', error);
    return {
      success: false,
      error: 'Failed to delete permit',
    };
  }
}

// -----------------------------------------------------------------------------
// Run AI Compliance Check
// -----------------------------------------------------------------------------

export async function runComplianceCheck(
  permitId: string,
  csrfToken: string
): Promise<{ success: boolean; data?: import('@/types').ComplianceCheckResult; error?: string }> {
  try {
    const authCheck = await requireAuth();
    if (!authCheck.success || !authCheck.user) {
      return { success: false, error: authCheck.error };
    }

    const csrf = await requireCSRF(csrfToken);
    if (!csrf.valid) return { success: false, error: csrf.error };

    const idValidation = uuidSchema.safeParse(permitId);
    if (!idValidation.success) {
      return { success: false, error: 'Invalid permit ID' };
    }

    const isOwner = await verifyPermitOwnership(permitId, authCheck.user.id);
    if (!isOwner) {
      return { success: false, error: 'Access denied' };
    }

    const supabase = createAdminClient();
    const { data: permit } = await supabase
      .from('permit_applications')
      .select('status, building_details, compliance_requirements, project_type')
      .eq('id', permitId)
      .single();

    if (!permit) {
      return { success: false, error: 'Permit not found' };
    }

    if (permit.status !== 'draft' && permit.status !== 'revision_requested') {
      return { success: false, error: 'Can only run compliance check on draft or revision-requested permits' };
    }

    const bd = permit.building_details;
    if (!bd || !bd.numberOfFloors || !bd.totalBuiltUpArea) {
      return { success: false, error: 'Please complete building details before running compliance check' };
    }

    // B3: server-side budget so a hung LLM call eventually frees the request
    // slot and doesn't keep burning Gemini quota forever. AbortSignal.timeout
    // is supported in Node 18+ which Next 15 requires.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);

    let result: import('@/types').ComplianceCheckResult;
    try {
      const { checkPermitCompliance } = await import('@/lib/permit-compliance');
      result = await checkPermitCompliance(
        permit.building_details,
        permit.compliance_requirements || {},
        permit.project_type,
        controller.signal,
      );
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return { success: false, error: 'Compliance check timed out — please try again.' };
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }

    // B3: re-check that the permit still exists in a state where writing the
    // result is correct. A user could have deleted the permit, or submitted it,
    // while the LLM call was in flight.
    const { data: stillDraft } = await supabase
      .from('permit_applications')
      .select('status')
      .eq('id', permitId)
      .eq('user_id', authCheck.user.id)
      .single();
    if (!stillDraft || (stillDraft.status !== 'draft' && stillDraft.status !== 'revision_requested')) {
      return { success: false, error: 'Permit state changed during analysis — result discarded.' };
    }

    // Store result
    const { error } = await supabase
      .from('permit_applications')
      .update({ compliance_check_result: result })
      .eq('id', permitId)
      .eq('user_id', authCheck.user.id);

    if (error) throw error;

    const metadata = await getRequestMetadata();
    await logAuditEvent({
      userId: authCheck.user.id,
      action: 'permit_compliance_checked',
      metadata: { permitId, overallStatus: result.overallStatus },
      ...metadata,
    });

    return { success: true, data: result };
  } catch (error) {
    console.error('runComplianceCheck error:', error);
    return {
      success: false,
      error: 'Failed to run compliance check',
    };
  }
}

// -----------------------------------------------------------------------------
// Revise Permit (Start editing after rejection/revision request)
// -----------------------------------------------------------------------------

export async function revisePermit(
  permitId: string,
  csrfToken: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const authCheck = await requireAuth();
    if (!authCheck.success || !authCheck.user) {
      return { success: false, error: authCheck.error };
    }

    const csrf = await requireCSRF(csrfToken);
    if (!csrf.valid) return { success: false, error: csrf.error };

    const idValidation = uuidSchema.safeParse(permitId);
    if (!idValidation.success) {
      return { success: false, error: 'Invalid permit ID' };
    }

    const isOwner = await verifyPermitOwnership(permitId, authCheck.user.id);
    if (!isOwner) {
      return { success: false, error: 'Access denied' };
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

    if (permit.status !== 'revision_requested') {
      return { success: false, error: 'Can only revise permits with revision requested' };
    }

    const { error } = await supabase
      .from('permit_applications')
      .update({
        status: 'draft',
        compliance_check_result: null,
      })
      .eq('id', permitId)
      .eq('user_id', authCheck.user.id);

    if (error) throw error;

    await supabase.from('permit_status_history').insert({
      permit_id: permitId,
      from_status: permit.status,
      to_status: 'draft',
      changed_by: authCheck.user.id,
      comment: 'Started revision',
    });

    const metadata = await getRequestMetadata();
    await logAuditEvent({
      userId: authCheck.user.id,
      action: 'permit_revised',
      metadata: { permitId, previousStatus: permit.status },
      ...metadata,
    });

    return { success: true };
  } catch (error) {
    console.error('revisePermit error:', error);
    return {
      success: false,
      error: 'Failed to start revision',
    };
  }
}
