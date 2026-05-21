// ============================================================================
// Permit State Machine (X16 / P2-A2)
// ============================================================================
// Single source of truth for which permit-status transitions and operations
// are legal. Previously the same status checks were inlined ~7 times across
// `actions/permits.ts`, `actions/admin-permits.ts`, `actions/permit-attachments.ts`,
// and the permit pages. The DB-level guard (review_permit_atomic /
// submit_permit_atomic / revise_permit_atomic RPCs) remains authoritative —
// this module just provides a typed pre-check so server actions can return a
// friendly error before the round-trip and so client UI can hide buttons.
// ============================================================================

import type { PermitApplication } from '@/types';

export type PermitStatus = PermitApplication['status'];

/**
 * Logical operations a user (or admin) can attempt against a permit. Each one
 * has a fixed set of statuses it can run from.
 */
export type PermitOperation =
  | 'edit'              // change project/building/compliance fields
  | 'upload_attachment' // attach a file to the permit
  | 'delete_attachment' // remove an attachment
  | 'run_compliance'    // AI compliance check
  | 'submit'            // user → submitted
  | 'delete'            // hard delete (only for drafts)
  | 'revise'            // re-open after revision_requested
  | 'review'            // admin: approve / reject / request_revision
  | 'start_review'      // admin: submitted → under_review
  | 'download_cert';    // owner: download approved certificate

/** Statuses an operation is allowed to start from. */
const ALLOWED_FROM: Record<PermitOperation, readonly PermitStatus[]> = {
  edit: ['draft'],
  upload_attachment: ['draft'],
  delete_attachment: ['draft'],
  run_compliance: ['draft', 'revision_requested'],
  submit: ['draft', 'revision_requested'],
  delete: ['draft'],
  revise: ['rejected', 'revision_requested'],
  review: ['submitted', 'under_review'],
  start_review: ['submitted'],
  download_cert: ['approved'],
};

/** Result of attempting an operation pre-check. */
export interface PermitOperationCheck {
  allowed: boolean;
  /** When `allowed: false`, a user-facing message explaining why. */
  reason?: string;
}

/**
 * Check whether `op` is allowed when the permit is currently in `status`.
 * Returns `{ allowed: true }` on success or a structured `{ allowed: false,
 * reason }` so callers can pass the message straight back to the client.
 */
export function canPerformOperation(
  status: PermitStatus,
  op: PermitOperation,
): PermitOperationCheck {
  const allowed = ALLOWED_FROM[op];
  if (allowed.includes(status)) {
    return { allowed: true };
  }
  return { allowed: false, reason: describeBlocked(op, status) };
}

/** Boolean shortcut for places that only care about the yes/no. */
export function isOperationAllowed(status: PermitStatus, op: PermitOperation): boolean {
  return ALLOWED_FROM[op].includes(status);
}

function describeBlocked(op: PermitOperation, status: PermitStatus): string {
  switch (op) {
    case 'edit':
      return 'Can only edit draft permits';
    case 'upload_attachment':
    case 'delete_attachment':
      return 'Can only modify attachments on draft permits';
    case 'run_compliance':
      return 'Can only run compliance check on draft or revision-requested permits';
    case 'submit':
      return 'Can only submit draft or revision-requested permits';
    case 'delete':
      return 'Can only delete draft permits';
    case 'revise':
      return 'Can only revise rejected or revision-requested permits';
    case 'review':
    case 'start_review':
      return `Cannot review a permit in status ${status}`;
    case 'download_cert':
      return 'Certificate only available for approved permits';
  }
}
