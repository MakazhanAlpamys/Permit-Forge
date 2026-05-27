// ============================================================================
// Shared Data Transforms
// ============================================================================

import type {
  PermitApplication,
  BuildingDetails,
  ComplianceRequirements,
  ComplianceCheckResult,
} from '@/types';
// BuildingDetails / ComplianceRequirements re-export — consumers that imported
// them through `lib/transforms` keep working without an explicit `@/types` swap.
export type { BuildingDetails, ComplianceRequirements } from '@/types';

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
 * SIM-H-3 / v1.8.0 Part D — collapse the "RPC row → first element" shim.
 *
 * Postgres SECURITY DEFINER functions return either RETURNS TABLE (array of
 * rows) or RETURNS RECORD (scalar). The supabase-js client normalises both
 * to the `data` field but the runtime shape differs. Six call sites were
 * repeating `Array.isArray(rows) ? rows[0] : (rows as ... | null)` with
 * subtly different type casts. This helper centralises the pick + cast.
 *
 * `T extends object` is required per the v1.8.0 typescript-reviewer
 * re-audit (Medium-1): without the constraint, omitting the explicit type
 * argument lets `T` collapse to `unknown`, widening every property access
 * on the result. RPC return shapes are always object rows in this codebase
 * so the constraint costs nothing.
 */
export function firstRpcRow<T extends object>(
  data: T | T[] | null | undefined,
): T | null {
  if (data == null) return null;
  if (Array.isArray(data)) return (data[0] as T | undefined) ?? null;
  return data;
}

// R-M-4 / v1.9.0 Part C: removed `snakeToCamel<T>` — the "80% case" generic
// mapper never got a real caller. Hand-written mappers (`rowToPermit`,
// audit/analytics adapters) handle their own shape coercion because they need
// per-field defaults (numOrZero, JSONB → object, etc.) that a blind key
// rename wouldn't provide. Tests for it were removed at the same time.

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
  permit_type?: string | null;
  expires_at?: string | null;
  owner_name?: string | null;
  owner_phone?: string | null;
  owner_emirates_id?: string | null;
  users?: { username?: string | null } | null;
}

/**
 * TS-H-1 / v1.6.0 Part A — single boundary cast for Supabase select rows.
 *
 * Supabase's PostgrestClient cannot infer the row shape from a select-string,
 * so call sites previously did `data as unknown as PermitRow[]` inline. That
 * scatter is bug-bait: a column rename in the select() string silently passes
 * the type checker. Centralise the cast in this helper + add a defensive
 * shape check in dev so a malformed row at least logs a warning.
 *
 * Helper does NOT validate every field — that would add per-row Zod cost on
 * `getMyPermits` (up to 50 rows). It validates the minimal "this looks like a
 * permit row" invariant (`id` + `user_id` strings), then forwards to
 * `transformPermit` which itself defaults missing fields gracefully.
 */
export function rowToPermit(row: unknown): PermitApplication & { username?: string } {
  assertPermitRowShape(row);
  return transformPermit(row);
}

export function rowsToPermits(
  rows: unknown[] | null | undefined,
): (PermitApplication & { username?: string })[] {
  return (rows ?? []).map(rowToPermit);
}

function assertPermitRowShape(row: unknown): asserts row is PermitRow {
  if (!row || typeof row !== 'object') {
    throw new Error('rowToPermit: expected an object row, got ' + typeof row);
  }
  const r = row as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.user_id !== 'string') {
    // TR1 (v1.6.0 re-audit): surface the mismatch loudly in dev so a renamed
    // column doesn't slip by, but DON'T leak the row's keys to production
    // Lambda logs (schema info → log aggregation pipelines). The throw
    // below is the always-on signal callers actually rely on.
    if (process.env.NODE_ENV !== 'production') {
      console.warn(
        '[transforms] rowToPermit: row missing required string id/user_id — ' +
          'likely a stale select() column list. Row keys:',
        Object.keys(r),
      );
    }
    throw new Error('rowToPermit: row is not a permit-applications row');
  }
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
    // TS-H-6 / v1.6.0 Part C: surface `undefined` for absent JSONB columns
    // instead of casting `{}` to the concrete type. The empty-object cast
    // was passing `if (!bd || !bd.numberOfFloors)` checks (empty obj is
    // truthy) and let undefined fields flow into the compliance LLM prompt.
    buildingDetails: row.building_details ?? undefined,
    complianceRequirements: row.compliance_requirements ?? undefined,
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
    permitType: (row.permit_type as PermitApplication['permitType']) || undefined,
    expiresAt: row.expires_at || null,
    ownerName: row.owner_name || undefined,
    ownerPhone: row.owner_phone || undefined,
    ownerEmiratesId: row.owner_emirates_id || undefined,
    username: row.users?.username || undefined,
  };
}
