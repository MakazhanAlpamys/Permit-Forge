'use server';

// ============================================================================
// Permit Application Server Actions (User-Facing)
// ============================================================================

import { createServerClient, createAdminClient } from '@/lib/supabase-server';
import { getQuickSession, logAuditEvent, getRequestMetadata } from '@/lib/auth';
import { requireAuth } from '@/lib/security';
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

// Re-export input types for components
export type { CreatePermitInput, UpdateBuildingDetailsInput, UpdateComplianceRequirementsInput };

// -----------------------------------------------------------------------------
// Helper: Verify Permit Ownership
// -----------------------------------------------------------------------------

async function verifyPermitOwnership(permitId: string, userId: string): Promise<boolean> {
  const validation = uuidSchema.safeParse(permitId);
  if (!validation.success) return false;

  const supabase = createServerClient();
  const { data, error } = await supabase
    .from('permit_applications')
    .select('user_id')
    .eq('id', permitId)
    .single();

  if (error || !data) return false;
  return data.user_id === userId;
}

// -----------------------------------------------------------------------------
// Helper: Transform DB row to PermitApplication
// -----------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function transformPermit(row: any): PermitApplication {
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
    revisionCount: row.revision_count || 0,
    revisionNotes: row.revision_notes || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// -----------------------------------------------------------------------------
// Create Permit Application (Draft)
// -----------------------------------------------------------------------------

export async function createPermit(
  data: CreatePermitInput
): Promise<{ success: boolean; permitId?: string; error?: string }> {
  try {
    const authCheck = await requireAuth();
    if (!authCheck.success || !authCheck.user) {
      return { success: false, error: authCheck.error };
    }

    const validation = createPermitSchema.safeParse(data);
    if (!validation.success) {
      return { success: false, error: validation.error.issues[0].message };
    }

    const supabase = createServerClient();
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
      error: error instanceof Error ? error.message : 'Failed to create permit',
    };
  }
}

// -----------------------------------------------------------------------------
// Update Building Details (Step 2)
// -----------------------------------------------------------------------------

export async function updatePermitBuildingDetails(
  data: UpdateBuildingDetailsInput
): Promise<{ success: boolean; error?: string }> {
  try {
    const authCheck = await requireAuth();
    if (!authCheck.success || !authCheck.user) {
      return { success: false, error: authCheck.error };
    }

    const validation = updateBuildingDetailsSchema.safeParse(data);
    if (!validation.success) {
      return { success: false, error: validation.error.issues[0].message };
    }

    const isOwner = await verifyPermitOwnership(validation.data.permitId, authCheck.user.id);
    if (!isOwner) {
      return { success: false, error: 'Access denied' };
    }

    // Verify status is draft
    const supabase = createServerClient();
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
      error: error instanceof Error ? error.message : 'Failed to update building details',
    };
  }
}

// -----------------------------------------------------------------------------
// Update Compliance Requirements (Step 3)
// -----------------------------------------------------------------------------

export async function updatePermitComplianceRequirements(
  data: UpdateComplianceRequirementsInput
): Promise<{ success: boolean; error?: string }> {
  try {
    const authCheck = await requireAuth();
    if (!authCheck.success || !authCheck.user) {
      return { success: false, error: authCheck.error };
    }

    const validation = updateComplianceRequirementsSchema.safeParse(data);
    if (!validation.success) {
      return { success: false, error: validation.error.issues[0].message };
    }

    const isOwner = await verifyPermitOwnership(validation.data.permitId, authCheck.user.id);
    if (!isOwner) {
      return { success: false, error: 'Access denied' };
    }

    const supabase = createServerClient();
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
      error: error instanceof Error ? error.message : 'Failed to update compliance requirements',
    };
  }
}

// -----------------------------------------------------------------------------
// Submit Permit Application
// -----------------------------------------------------------------------------

export async function submitPermit(
  permitId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const authCheck = await requireAuth();
    if (!authCheck.success || !authCheck.user) {
      return { success: false, error: authCheck.error };
    }

    const idValidation = uuidSchema.safeParse(permitId);
    if (!idValidation.success) {
      return { success: false, error: 'Invalid permit ID' };
    }

    const isOwner = await verifyPermitOwnership(permitId, authCheck.user.id);
    if (!isOwner) {
      return { success: false, error: 'Access denied' };
    }

    const supabase = createServerClient();
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
      error: error instanceof Error ? error.message : 'Failed to submit permit',
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

    const supabase = createServerClient();
    const { data, error } = await supabase
      .from('permit_applications')
      .select('*')
      .eq('user_id', user.id)
      .order('updated_at', { ascending: false });

    if (error) throw error;

    return { data: (data || []).map(transformPermit) };
  } catch (error) {
    console.error('getMyPermits error:', error);
    return {
      data: [],
      error: error instanceof Error ? error.message : 'Failed to fetch permits',
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

    // Admin can view any permit, users can only view their own
    const supabase = user.role === 'admin' ? createAdminClient() : createServerClient();

    let query = supabase
      .from('permit_applications')
      .select('*')
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
      error: error instanceof Error ? error.message : 'Failed to fetch permit',
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

    const supabase = createServerClient();
    const { data, error } = await supabase
      .from('permit_status_history')
      .select('*')
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
      error: error instanceof Error ? error.message : 'Failed to fetch history',
    };
  }
}

// -----------------------------------------------------------------------------
// Delete Permit (Draft Only)
// -----------------------------------------------------------------------------

export async function deletePermit(
  permitId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const authCheck = await requireAuth();
    if (!authCheck.success || !authCheck.user) {
      return { success: false, error: authCheck.error };
    }

    const idValidation = uuidSchema.safeParse(permitId);
    if (!idValidation.success) {
      return { success: false, error: 'Invalid permit ID' };
    }

    const isOwner = await verifyPermitOwnership(permitId, authCheck.user.id);
    if (!isOwner) {
      return { success: false, error: 'Access denied' };
    }

    const supabase = createServerClient();
    const { data: permit } = await supabase
      .from('permit_applications')
      .select('status')
      .eq('id', permitId)
      .single();

    if (permit?.status !== 'draft') {
      return { success: false, error: 'Can only delete draft permits' };
    }

    // Delete attachments from storage first
    const adminClient = createAdminClient();
    const { data: attachments } = await supabase
      .from('permit_attachments')
      .select('storage_path')
      .eq('permit_id', permitId);

    if (attachments && attachments.length > 0) {
      const paths = attachments.map((a: { storage_path: string }) => a.storage_path);
      await adminClient.storage
        .from('permit-attachments')
        .remove(paths);
    }

    const { error } = await supabase
      .from('permit_applications')
      .delete()
      .eq('id', permitId)
      .eq('user_id', authCheck.user.id);

    if (error) throw error;

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
      error: error instanceof Error ? error.message : 'Failed to delete permit',
    };
  }
}

// -----------------------------------------------------------------------------
// Run AI Compliance Check
// -----------------------------------------------------------------------------

export async function runComplianceCheck(
  permitId: string
): Promise<{ success: boolean; data?: import('@/types').ComplianceCheckResult; error?: string }> {
  try {
    const authCheck = await requireAuth();
    if (!authCheck.success || !authCheck.user) {
      return { success: false, error: authCheck.error };
    }

    const idValidation = uuidSchema.safeParse(permitId);
    if (!idValidation.success) {
      return { success: false, error: 'Invalid permit ID' };
    }

    const isOwner = await verifyPermitOwnership(permitId, authCheck.user.id);
    if (!isOwner) {
      return { success: false, error: 'Access denied' };
    }

    const supabase = createServerClient();
    const { data: permit } = await supabase
      .from('permit_applications')
      .select('status, building_details, compliance_requirements, project_type')
      .eq('id', permitId)
      .single();

    if (!permit) {
      return { success: false, error: 'Permit not found' };
    }

    if (permit.status !== 'draft') {
      return { success: false, error: 'Can only run compliance check on draft permits' };
    }

    const bd = permit.building_details;
    if (!bd || !bd.numberOfFloors || !bd.totalBuiltUpArea) {
      return { success: false, error: 'Please complete building details before running compliance check' };
    }

    // Run the AI compliance check
    const { checkPermitCompliance } = await import('@/lib/permit-compliance');
    const result = await checkPermitCompliance(
      permit.building_details,
      permit.compliance_requirements || {},
      permit.project_type
    );

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
      error: error instanceof Error ? error.message : 'Failed to run compliance check',
    };
  }
}

// -----------------------------------------------------------------------------
// Revise Permit (Start editing after rejection/revision request)
// -----------------------------------------------------------------------------

export async function revisePermit(
  permitId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const authCheck = await requireAuth();
    if (!authCheck.success || !authCheck.user) {
      return { success: false, error: authCheck.error };
    }

    const idValidation = uuidSchema.safeParse(permitId);
    if (!idValidation.success) {
      return { success: false, error: 'Invalid permit ID' };
    }

    const isOwner = await verifyPermitOwnership(permitId, authCheck.user.id);
    if (!isOwner) {
      return { success: false, error: 'Access denied' };
    }

    const supabase = createServerClient();
    const { data: permit } = await supabase
      .from('permit_applications')
      .select('status')
      .eq('id', permitId)
      .single();

    if (!permit) {
      return { success: false, error: 'Permit not found' };
    }

    if (permit.status !== 'rejected' && permit.status !== 'revision_requested') {
      return { success: false, error: 'Can only revise rejected or revision-requested permits' };
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
      error: error instanceof Error ? error.message : 'Failed to start revision',
    };
  }
}
