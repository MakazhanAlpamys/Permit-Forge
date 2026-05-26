// ============================================================================
// lib/permit-versioning.ts tests (SIM-H-2 / v1.8.0 Part D)
// ============================================================================
// applyOptimisticUpdate centralises the twin X17 optimistic-locking block
// from updatePermitBuildingDetails + updatePermitComplianceRequirements.
// The two callers exercise it via the integration suite; these unit tests
// pin the contract directly so a future refactor of either caller doesn't
// accidentally regress the version-check semantics.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { applyOptimisticUpdate, VERSION_CONFLICT_MESSAGE } from '@/lib/permit-versioning';

// Mock the logger so we can assert the collision event without polluting
// stderr during the test run.
const mockWarn = vi.fn();
vi.mock('@/lib/logger', () => ({
  logger: {
    warn: (...args: unknown[]) => mockWarn(...args),
  },
}));

interface FakeBuilder {
  update: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
}

function makeClient(selectReturn: { data?: unknown[]; error?: unknown }) {
  const builder: FakeBuilder = {
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    select: vi.fn().mockResolvedValue(selectReturn),
  };
  return {
    builder,
    from: vi.fn(() => builder),
  };
}

describe('applyOptimisticUpdate', () => {
  beforeEach(() => {
    mockWarn.mockClear();
  });

  it('bumps version + WHERE-versions on success when expectedVersion supplied', async () => {
    const c = makeClient({ data: [{ id: 'p1' }], error: null });
    const result = await applyOptimisticUpdate({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: { from: c.from } as any,
      permitId: 'p1',
      userId: 'u1',
      expectedVersion: 3,
      op: 'test',
      patch: { foo: 'bar' },
    });

    expect(result).toEqual({ ok: true });
    // The patch includes the bumped version.
    expect(c.builder.update).toHaveBeenCalledWith(
      expect.objectContaining({ foo: 'bar', version: 4 }),
    );
    // eq() ran 3x: id, user_id, AND version.
    expect(c.builder.eq).toHaveBeenCalledWith('id', 'p1');
    expect(c.builder.eq).toHaveBeenCalledWith('user_id', 'u1');
    expect(c.builder.eq).toHaveBeenCalledWith('version', 3);
  });

  it('returns version_conflict + logs the collision when no rows updated', async () => {
    const c = makeClient({ data: [], error: null });
    const result = await applyOptimisticUpdate({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: { from: c.from } as any,
      permitId: 'p1',
      userId: 'u1',
      expectedVersion: 3,
      op: 'updatePermitBuildingDetails',
      patch: { foo: 'bar' },
    });

    expect(result).toEqual({ ok: false, reason: 'version_conflict' });
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'optimistic_lock_collision',
        op: 'updatePermitBuildingDetails',
        permitId: 'p1',
        userId: 'u1',
        expectedVersion: 3,
      }),
      expect.stringContaining('Optimistic lock collision'),
    );
  });

  it('skips the version WHERE + bump when expectedVersion is undefined', async () => {
    const c = makeClient({ data: [], error: null });
    const result = await applyOptimisticUpdate({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: { from: c.from } as any,
      permitId: 'p1',
      userId: 'u1',
      expectedVersion: undefined,
      op: 'test',
      patch: { foo: 'bar' },
    });

    // System-write path: empty rows are NOT treated as a version conflict.
    expect(result).toEqual({ ok: true });
    // No `version` column in the patch.
    expect(c.builder.update).toHaveBeenCalledWith({ foo: 'bar' });
    // eq() ran 2x: id + user_id only (no version filter).
    expect(c.builder.eq).toHaveBeenCalledWith('id', 'p1');
    expect(c.builder.eq).toHaveBeenCalledWith('user_id', 'u1');
    expect(c.builder.eq).not.toHaveBeenCalledWith('version', expect.anything());
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('returns db_error when the underlying update throws', async () => {
    const c = makeClient({ data: undefined, error: new Error('connection lost') });
    const result = await applyOptimisticUpdate({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: { from: c.from } as any,
      permitId: 'p1',
      userId: 'u1',
      expectedVersion: 3,
      op: 'test',
      patch: {},
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === 'db_error') {
      expect((result.error as Error).message).toBe('connection lost');
    } else {
      throw new Error('expected db_error variant');
    }
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('exports the user-facing copy callers re-use for the error path', () => {
    expect(VERSION_CONFLICT_MESSAGE).toMatch(/changed in another tab/);
  });
});
