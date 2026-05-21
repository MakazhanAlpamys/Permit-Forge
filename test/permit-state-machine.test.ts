// ============================================================================
// X16 — lib/permit-state-machine.ts coverage
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  canPerformOperation,
  isOperationAllowed,
  type PermitStatus,
} from '@/lib/permit-state-machine';

describe('canPerformOperation', () => {
  const allStatuses: PermitStatus[] = [
    'draft',
    'submitted',
    'under_review',
    'approved',
    'rejected',
    'revision_requested',
  ];

  describe('edit / upload_attachment / delete_attachment / delete', () => {
    it.each(['edit', 'upload_attachment', 'delete_attachment', 'delete'] as const)(
      '%s is allowed only from draft',
      (op) => {
        for (const s of allStatuses) {
          const expected = s === 'draft';
          expect(canPerformOperation(s, op).allowed).toBe(expected);
        }
      },
    );
  });

  describe('run_compliance / submit', () => {
    it.each(['run_compliance', 'submit'] as const)(
      '%s is allowed from draft and revision_requested',
      (op) => {
        for (const s of allStatuses) {
          const expected = s === 'draft' || s === 'revision_requested';
          expect(canPerformOperation(s, op).allowed).toBe(expected);
        }
      },
    );
  });

  it('revise is allowed only from rejected or revision_requested', () => {
    for (const s of allStatuses) {
      const expected = s === 'rejected' || s === 'revision_requested';
      expect(canPerformOperation(s, 'revise').allowed).toBe(expected);
    }
  });

  it('start_review is allowed only from submitted', () => {
    for (const s of allStatuses) {
      const expected = s === 'submitted';
      expect(canPerformOperation(s, 'start_review').allowed).toBe(expected);
    }
  });

  it('review accepts submitted and under_review', () => {
    for (const s of allStatuses) {
      const expected = s === 'submitted' || s === 'under_review';
      expect(canPerformOperation(s, 'review').allowed).toBe(expected);
    }
  });

  it('download_cert is allowed only from approved', () => {
    for (const s of allStatuses) {
      const expected = s === 'approved';
      expect(canPerformOperation(s, 'download_cert').allowed).toBe(expected);
    }
  });

  it('disallowed operations come with a reason string', () => {
    const result = canPerformOperation('approved', 'edit');
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/draft/i);
  });
});

describe('isOperationAllowed', () => {
  it('returns the same boolean as canPerformOperation.allowed', () => {
    expect(isOperationAllowed('draft', 'edit')).toBe(true);
    expect(isOperationAllowed('approved', 'edit')).toBe(false);
    expect(isOperationAllowed('approved', 'download_cert')).toBe(true);
    expect(isOperationAllowed('draft', 'download_cert')).toBe(false);
  });
});
