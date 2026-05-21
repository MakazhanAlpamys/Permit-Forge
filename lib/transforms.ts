// ============================================================================
// Shared Data Transforms
// ============================================================================

import type {
  PermitApplication,
  BuildingDetails,
  ComplianceRequirements,
  ComplianceCheckResult,
} from '@/types';

/**
 * Coerce a Postgres-numeric / nullable count to a finite number (or 0).
 * RPCs return `total_users` etc. as numeric strings or null; chart code only
 * ever wants a number. Replaces the `Number(x) || 0` ritual scattered across
 * the analytics actions.
 */
export function numOrZero(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Shallow snake_case → camelCase mapper for flat DB rows. Intended for the
 * 80% case (audit log, analytics rows, document registry). Deeply nested or
 * computed-field shapes (permits) should keep their hand-written mapper.
 *
 * `T` is the camelCase output shape — the caller asserts the row's keys
 * line up with `T`'s keys via the generic. Values are passed through as-is
 * with no coercion; combine with `numOrZero` for count fields.
 */
export function snakeToCamel<T extends Record<string, unknown>>(
  row: Record<string, unknown>,
): T {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(row)) {
    const camel = key.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
    out[camel] = row[key];
  }
  return out as T;
}

/**
 * Shape of a permit_applications row as returned by Supabase. Snake_case to
 * mirror the DB column names. Optional join `users` carries the username when
 * the query includes the FK relation (admin permit list).
 */
export interface PermitRow {
  id: string;
  user_id: string;
  status: string;
  project_name: string;
  project_type: string;
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
  version?: number | null;
  users?: { username?: string | null } | null;
}

export function transformPermit(row: PermitRow): PermitApplication & { username?: string } {
  return {
    id: row.id,
    userId: row.user_id,
    status: row.status as PermitApplication['status'],
    projectName: row.project_name,
    projectType: row.project_type as PermitApplication['projectType'],
    projectAddress: row.project_address,
    plotNumber: row.plot_number || undefined,
    projectDescription: row.project_description || undefined,
    buildingDetails: row.building_details || ({} as BuildingDetails),
    complianceRequirements: row.compliance_requirements || ({} as ComplianceRequirements),
    complianceCheckResult: row.compliance_check_result || null,
    reviewedBy: row.reviewed_by || null,
    reviewedAt: row.reviewed_at || null,
    reviewComments: row.review_comments || null,
    submittedAt: row.submitted_at || null,
    revisionCount: row.revision_count || 0,
    revisionNotes: row.revision_notes || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version ?? 0,
    username: row.users?.username || undefined,
  };
}
