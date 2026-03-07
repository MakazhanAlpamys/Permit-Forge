// ============================================================================
// Shared Data Transforms
// ============================================================================

import type { PermitApplication } from '@/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function transformPermit(row: any): PermitApplication & { username?: string } {
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
    username: row.users?.username || undefined,
  };
}
