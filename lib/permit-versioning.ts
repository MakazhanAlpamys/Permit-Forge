// ============================================================================
// SIM-H-2 / v1.8.0 Part D — shared optimistic-locking helper for permits
// ============================================================================
// updatePermitBuildingDetails and updatePermitComplianceRequirements both
// repeated the same ~30-line "build update with optional version bump +
// .eq('version', expectedVersion) + post-hoc empty-rows check + collision
// logger + 'changed in another tab' error" block. Only the JSONB column name
// differed. This helper centralises the X17 contract.
//
// The version write semantics:
//   - When `expectedVersion` is a number, we WHERE on it AND bump the row's
//     `version` to `expectedVersion + 1`. Zero rows affected → the row was
//     updated in another tab between the user reading it and submitting.
//   - When `expectedVersion` is undefined, we skip the version-related WHERE
//     and don't bump the version. Used for system writes (compliance check
//     result clobber) that are conceptually idempotent.
// ============================================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';

export interface ApplyOptimisticUpdateInput {
  client: SupabaseClient;
  permitId: string;
  userId: string;
  expectedVersion: number | undefined;
  /** Operation label for the optimistic-lock-collision logger event. */
  op: string;
  /**
   * Columns to write. The `version` column is added automatically when an
   * expectedVersion is supplied — callers must NOT include it here.
   */
  patch: Record<string, unknown>;
}

export type ApplyOptimisticUpdateResult =
  | { ok: true }
  | { ok: false; reason: 'version_conflict' }
  | { ok: false; reason: 'db_error'; error: unknown };

export async function applyOptimisticUpdate(
  input: ApplyOptimisticUpdateInput,
): Promise<ApplyOptimisticUpdateResult> {
  const { client, permitId, userId, expectedVersion, op, patch } = input;

  const updates: Record<string, unknown> = { ...patch };
  if (typeof expectedVersion === 'number') {
    updates.version = expectedVersion + 1;
  }

  let updateBuilder = client
    .from('permit_applications')
    .update(updates)
    .eq('id', permitId)
    .eq('user_id', userId);
  if (typeof expectedVersion === 'number') {
    updateBuilder = updateBuilder.eq('version', expectedVersion);
  }
  const { data: updated, error } = await updateBuilder.select('id');

  if (error) {
    return { ok: false, reason: 'db_error', error };
  }

  if (typeof expectedVersion === 'number' && (!updated || updated.length === 0)) {
    // A-M-1 / v1.7.0 Part G: surface every collision as a structured event
    // so we can track how often users get bounced from auto-save races.
    logger.warn(
      {
        event: 'optimistic_lock_collision',
        op,
        permitId,
        userId,
        expectedVersion,
      },
      'Optimistic lock collision — user edited in another tab',
    );
    return { ok: false, reason: 'version_conflict' };
  }

  return { ok: true };
}

export const VERSION_CONFLICT_MESSAGE =
  'This permit was changed in another tab. Reload the page to see the latest version.';
