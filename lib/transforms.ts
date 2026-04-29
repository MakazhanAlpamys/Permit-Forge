// ============================================================================
// Shared Data Transforms
// ============================================================================

import type { PermitApplication, BuildingDetails, ComplianceRequirements, ComplianceCheckResult, PermitStatus, ProjectType } from '@/types';

// H22: typed DB row instead of `any`. Optional fields mirror DB nullability.
export interface PermitDbRow {
  id: string;
  user_id: string;
  status: PermitStatus;
  project_name: string;
  project_type: ProjectType;
  project_address: string;
  plot_number?: string | null;
  project_description?: string | null;
  building_details?: BuildingDetails | null;
  compliance_requirements?: ComplianceRequirements | null;
  compliance_check_result?: ComplianceCheckResult | null;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  review_comments?: string | null;
  submitted_at?: string | null;
  revision_count?: number | null;
  revision_notes?: string | null;
  created_at: string;
  updated_at: string;
  users?: { username?: string | null } | null;
}

export function transformPermit(row: PermitDbRow): PermitApplication & { username?: string } {
  return {
    id: row.id,
    userId: row.user_id,
    status: row.status,
    projectName: row.project_name,
    projectType: row.project_type,
    projectAddress: row.project_address,
    plotNumber: row.plot_number || undefined,
    projectDescription: row.project_description || undefined,
    buildingDetails: (row.building_details || {}) as BuildingDetails,
    complianceRequirements: (row.compliance_requirements || {}) as ComplianceRequirements,
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
