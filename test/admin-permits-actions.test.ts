// ============================================================================
// Admin Permits Server Actions Tests
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock security
const mockRequireAdmin = vi.fn();
const mockRequireCSRF = vi.fn();
vi.mock('@/lib/security', () => ({
  requireAuth: vi.fn(),
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
  requireCSRF: (...args: unknown[]) => mockRequireCSRF(...args),
  requireActionRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
}));

// Mock auth
const mockLogAuditEvent = vi.fn().mockResolvedValue(undefined);
const mockGetRequestMetadata = vi.fn().mockResolvedValue({ ip: '127.0.0.1', userAgent: 'test' });
vi.mock('@/lib/auth', () => ({
  logAuditEvent: (...args: unknown[]) => mockLogAuditEvent(...args),
  getRequestMetadata: (...args: unknown[]) => mockGetRequestMetadata(...args),
  // v1.8.0 Part B: delegate logAuditWithMeta to the existing mocks so the
  // existing shape assertions (mockLogAuditEvent.toHaveBeenCalledWith({...}))
  // still fire after callers swap to the convenience wrapper.
  logAuditWithMeta: async (
    userId: string,
    action: string,
    extras?: { targetUserId?: string; metadata?: Record<string, unknown> },
  ) => {
    const meta = await mockGetRequestMetadata();
    return mockLogAuditEvent({
      userId,
      action,
      targetUserId: extras?.targetUserId,
      metadata: extras?.metadata,
      ...meta,
    });
  },
}));

// Mock supabase with chainable query builder
const mockSingle = vi.fn();
const mockEq = vi.fn();
const mockIn = vi.fn();
const mockSelect = vi.fn();
const mockInsert = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockOrder = vi.fn();
const mockRange = vi.fn();
const mockFrom = vi.fn();
const mockRpc = vi.fn();

function resetChainMocks() {
  mockSingle.mockResolvedValue({ data: null, error: null });
  mockRange.mockReturnValue({ data: [], error: null });
  mockOrder.mockReturnValue({ range: mockRange, data: [], error: null });
  mockIn.mockReturnValue({ select: mockSelect, single: mockSingle, data: [], error: null });
  mockEq.mockReturnValue({
    eq: mockEq,
    in: mockIn,
    single: mockSingle,
    select: mockSelect,
    order: mockOrder,
    delete: mockDelete,
    range: mockRange,
  });
  mockDelete.mockReturnValue({ eq: mockEq, single: mockSingle, error: null });
  mockUpdate.mockReturnValue({ eq: mockEq, in: mockIn, single: mockSingle, select: mockSelect, error: null });
  mockSelect.mockReturnValue({
    eq: mockEq,
    single: mockSingle,
    order: mockOrder,
    range: mockRange,
    in: mockIn,
  });
  mockInsert.mockReturnValue({ select: mockSelect, single: mockSingle, error: null });
  mockFrom.mockReturnValue({
    select: mockSelect,
    insert: mockInsert,
    update: mockUpdate,
    delete: mockDelete,
    eq: mockEq,
    single: mockSingle,
    order: mockOrder,
    range: mockRange,
  });
  mockRpc.mockResolvedValue({ data: [], error: null });
}

vi.mock('@/lib/supabase-server', () => ({
  createServerClient: vi.fn(() => ({
    from: (...args: unknown[]) => mockFrom(...args),
    rpc: (...args: unknown[]) => mockRpc(...args),
  })),
  createAdminClient: vi.fn(() => ({
    from: (...args: unknown[]) => mockFrom(...args),
    rpc: (...args: unknown[]) => mockRpc(...args),
  })),
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
}));

// Mock notifications
const mockCreateNotification = vi.fn().mockResolvedValue(undefined);
const mockGetNotificationContent = vi.fn().mockReturnValue({ title: 'Test', body: 'Test notification' });
vi.mock('@/lib/notifications', () => ({
  createNotification: (...args: unknown[]) => mockCreateNotification(...args),
  getNotificationContent: (...args: unknown[]) => mockGetNotificationContent(...args),
}));

// Mock transforms
vi.mock('@/lib/transforms', () => {
  const transformPermit = vi.fn((row: Record<string, unknown>) => ({
    id: row.id,
    userId: row.user_id,
    status: row.status,
    projectName: row.project_name,
    projectType: row.project_type,
    projectAddress: row.project_address,
    buildingDetails: row.building_details || {},
    complianceRequirements: row.compliance_requirements || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    username: (row.users as Record<string, string>)?.username || undefined,
  }));
  return {
    transformPermit,
    // TS-H-1 / v1.6.0 Part A: action layer now goes through these helpers.
    rowToPermit: (row: Record<string, unknown>) => transformPermit(row),
    rowsToPermits: (rows: Record<string, unknown>[] | null | undefined) =>
      (rows ?? []).map(transformPermit),
    firstRpcRow: <T,>(data: T | T[] | null | undefined): T | null => {
      if (data == null) return null;
      if (Array.isArray(data)) return (data[0] as T | undefined) ?? null;
      return data;
    },
  };
});

import {
  getAdminPermits,
  reviewPermit,
  setPermitUnderReview,
  getPermitStats,
} from '@/actions/admin-permits';

const adminUser = { id: 'admin-123', username: 'admin', role: 'admin' };
const validUUID = '550e8400-e29b-41d4-a716-446655440000';

const mockPermitRow = {
  id: validUUID,
  user_id: 'user-123',
  status: 'submitted',
  project_name: 'Test Building',
  project_type: 'residential',
  project_address: '123 Main St',
  building_details: {},
  compliance_requirements: {},
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  users: { username: 'testuser' },
};

describe('Admin Permits Server Actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChainMocks();
    mockRequireAdmin.mockResolvedValue({ success: true, user: adminUser });
    mockRequireCSRF.mockResolvedValue({ valid: true });
  });

  // ---------------------------------------------------------------------------
  // getAdminPermits
  // ---------------------------------------------------------------------------

  describe('getAdminPermits', () => {
    it('should return permits for admin', async () => {
      // Chain: from -> select -> order -> range
      mockRange.mockReturnValueOnce({ data: [mockPermitRow], error: null });

      const result = await getAdminPermits();

      expect(result.data).toHaveLength(1);
      expect(result.data[0].projectName).toBe('Test Building');
      expect(result.error).toBeUndefined();
    });

    it('should reject non-admin users', async () => {
      mockRequireAdmin.mockResolvedValue({ success: false, error: 'Admin access required' });

      const result = await getAdminPermits();

      expect(result.data).toEqual([]);
      expect(result.error).toBe('Admin access required');
    });

    it('should filter by status when provided', async () => {
      mockRange.mockReturnValueOnce({ data: [], error: null });

      await getAdminPermits('submitted');

      // The query chains: select -> order -> range, with eq called for status filter
      expect(mockFrom).toHaveBeenCalledWith('permit_applications');
    });

    it('should not filter when status is "all"', async () => {
      mockRange.mockReturnValueOnce({ data: [], error: null });

      const result = await getAdminPermits('all');

      expect(result.data).toEqual([]);
    });

    it('should handle DB error gracefully', async () => {
      mockRange.mockReturnValueOnce({ data: null, error: { message: 'DB error' } });

      const result = await getAdminPermits();

      expect(result.data).toEqual([]);
      expect(result.error).toBe('Failed to fetch permits');
    });

    it('should return empty array on null data', async () => {
      mockRange.mockReturnValueOnce({ data: null, error: null });

      const result = await getAdminPermits();

      expect(result.data).toEqual([]);
    });

    // S-M-6 / v1.9.0 Part A: caller-supplied `limit` is capped server-side so a
    // misbehaving admin client can't request 10k rows and exhaust memory.
    it('caps the limit parameter at 100 server-side (S-M-6)', async () => {
      mockRange.mockReturnValueOnce({ data: [], error: null });

      await getAdminPermits(undefined, 10_000, 0);

      // offset=0, capped limit=100 → range(0, 99)
      expect(mockRange).toHaveBeenCalledWith(0, 99);
    });

    it('clamps a negative limit up to 1', async () => {
      mockRange.mockReturnValueOnce({ data: [], error: null });

      await getAdminPermits(undefined, -5, 0);

      // negative limit → 1; range(0, 0)
      expect(mockRange).toHaveBeenCalledWith(0, 0);
    });

    it('clamps a negative offset to 0', async () => {
      mockRange.mockReturnValueOnce({ data: [], error: null });

      await getAdminPermits(undefined, 20, -10);

      expect(mockRange).toHaveBeenCalledWith(0, 19);
    });

    // v1.9.0 Part A re-audit (NEW-1, Medium): NaN propagated through the old
    // Math.floor/Math.max/Math.min chain and made it to .range(NaN, NaN). The
    // guard `Number.isFinite()` rebases to the default 50 / 0 instead.
    it('handles NaN limit by falling back to the default (50) — re-audit NEW-1', async () => {
      mockRange.mockReturnValueOnce({ data: [], error: null });

      await getAdminPermits(undefined, Number.NaN, 0);

      expect(mockRange).toHaveBeenCalledWith(0, 49);
    });

    it('handles NaN offset by falling back to 0 — re-audit NEW-1', async () => {
      mockRange.mockReturnValueOnce({ data: [], error: null });

      await getAdminPermits(undefined, 25, Number.NaN);

      expect(mockRange).toHaveBeenCalledWith(0, 24);
    });

    // Per the re-audit fix: Number.isFinite(Infinity) === false → fallback to
    // the default 50. (Infinity is never a legitimate UI input; the fallback
    // is strictly safer than capping at 100.)
    it('handles Infinity limit by falling back to the default (50)', async () => {
      mockRange.mockReturnValueOnce({ data: [], error: null });

      await getAdminPermits(undefined, Number.POSITIVE_INFINITY, 0);

      expect(mockRange).toHaveBeenCalledWith(0, 49);
    });
  });

  // ---------------------------------------------------------------------------
  // reviewPermit
  // ---------------------------------------------------------------------------

  describe('reviewPermit', () => {
    const approveData = {
      permitId: validUUID,
      action: 'approve' as const,
      comments: 'Looks good, approved.',
    };

    const rejectData = {
      permitId: validUUID,
      action: 'reject' as const,
      comments: 'Does not meet requirements.',
    };

    const revisionData = {
      permitId: validUUID,
      action: 'request_revision' as const,
      comments: 'Please update floor plans.',
    };

    function setupReviewPermitMocks(_permitStatus: string) {
      // C17H: reviewPermit now calls review_permit_atomic RPC.
      mockRpc.mockResolvedValueOnce({
        data: [{
          status_changed: true,
          prev_status: _permitStatus,
          project_name: 'Test Building',
          permit_user_id: 'user-123',
        }],
        error: null,
      });
    }

    it('should approve a permit successfully', async () => {
      setupReviewPermitMocks('under_review');

      const result = await reviewPermit(approveData, 'csrf-token');

      expect(result.success).toBe(true);
    });

    it('should reject a permit successfully', async () => {
      setupReviewPermitMocks('submitted');

      const result = await reviewPermit(rejectData, 'csrf-token');

      expect(result.success).toBe(true);
    });

    it('should request revision successfully', async () => {
      setupReviewPermitMocks('under_review');

      const result = await reviewPermit(revisionData, 'csrf-token');

      expect(result.success).toBe(true);
    });

    it('should reject non-admin users', async () => {
      mockRequireAdmin.mockResolvedValue({ success: false, error: 'Admin access required' });

      const result = await reviewPermit(approveData, 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Admin access required');
    });

    it('should reject invalid CSRF token', async () => {
      mockRequireCSRF.mockResolvedValue({ valid: false, error: 'CSRF token invalid' });

      const result = await reviewPermit(approveData, 'bad-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('CSRF token invalid');
    });

    it('should reject invalid permit ID', async () => {
      const result = await reviewPermit(
        { permitId: 'not-a-uuid', action: 'approve', comments: 'OK' },
        'csrf-token',
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should return error when permit not found', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'PERMIT_NOT_FOUND' } });

      const result = await reviewPermit(approveData, 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Permit not found');
    });

    it('should reject permit not in reviewable state', async () => {
      // RPC reports status_changed=false when status is outside ('submitted','under_review').
      mockRpc.mockResolvedValueOnce({
        data: [{ status_changed: false, prev_status: 'draft', project_name: 'Test', permit_user_id: 'user-123' }],
        error: null,
      });

      const result = await reviewPermit(approveData, 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toContain('status has changed');
    });

    it('should log audit event on approval', async () => {
      setupReviewPermitMocks('under_review');

      await reviewPermit(approveData, 'csrf-token');

      expect(mockLogAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        userId: adminUser.id,
        action: 'permit_reviewed',
        metadata: expect.objectContaining({ decision: 'approve' }),
      }));
    });

    it('should log permit_revision_requested for revision action', async () => {
      setupReviewPermitMocks('under_review');

      await reviewPermit(revisionData, 'csrf-token');

      expect(mockLogAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        action: 'permit_revision_requested',
      }));
    });

    it('should reject empty comments', async () => {
      const result = await reviewPermit(
        { permitId: validUUID, action: 'approve', comments: '' },
        'csrf-token',
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    // B8: notification dispatch failure should surface as a warning, not break
    // the review (which has already committed to the DB).
    it('should still succeed but surface a warning when notification dispatch fails', async () => {
      setupReviewPermitMocks('submitted');
      mockCreateNotification.mockRejectedValueOnce(new Error('SMTP outage'));

      const result = await reviewPermit(approveData, 'csrf-token');

      expect(result.success).toBe(true);
      expect(result.warning).toBeDefined();
      expect(result.warning).toMatch(/notification/i);
    });
  });

  // ---------------------------------------------------------------------------
  // setPermitUnderReview
  // ---------------------------------------------------------------------------

  describe('setPermitUnderReview', () => {
    // A-C-5 / v1.3.0 Part D: setPermitUnderReview now calls
    // start_review_permit_atomic — single RPC, no SELECT/UPDATE/INSERT split.
    function setupUnderReviewMocks() {
      mockRpc.mockResolvedValueOnce({
        data: [{
          status_changed: true,
          project_name: 'Test Building',
          permit_user_id: 'user-123',
          prev_status: 'submitted',
        }],
        error: null,
      });
    }

    it('should transition submitted permit to under_review', async () => {
      setupUnderReviewMocks();

      const result = await setPermitUnderReview(validUUID, 'csrf-token');

      expect(result.success).toBe(true);
      expect(mockRpc).toHaveBeenCalledWith('start_review_permit_atomic', expect.objectContaining({
        p_permit_id: validUUID,
        p_admin_id: adminUser.id,
      }));
    });

    it('should reject non-admin users', async () => {
      mockRequireAdmin.mockResolvedValue({ success: false, error: 'Admin access required' });

      const result = await setPermitUnderReview(validUUID, 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Admin access required');
    });

    it('should reject invalid CSRF token', async () => {
      mockRequireCSRF.mockResolvedValue({ valid: false, error: 'CSRF token invalid' });

      const result = await setPermitUnderReview(validUUID, 'bad-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('CSRF token invalid');
    });

    it('should reject invalid permit ID', async () => {
      const result = await setPermitUnderReview('not-a-uuid', 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid permit ID');
    });

    it('should return error when permit not found', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'PERMIT_NOT_FOUND' } });

      const result = await setPermitUnderReview(validUUID, 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Permit not found');
    });

    it('should reject permit not in submitted state', async () => {
      // RPC reports status_changed=false when status is outside ('submitted').
      mockRpc.mockResolvedValueOnce({
        data: [{ status_changed: false, prev_status: 'approved', project_name: 'Test', permit_user_id: 'user-123' }],
        error: null,
      });

      const result = await setPermitUnderReview(validUUID, 'csrf-token');

      expect(result.success).toBe(false);
      // RPC returns status_changed=false; action surfaces the optimistic-lock copy.
      expect(result.error).toContain('status has changed');
    });

    it('should handle race condition (status changed)', async () => {
      mockRpc.mockResolvedValueOnce({
        data: [{ status_changed: false, prev_status: 'under_review', project_name: 'Test', permit_user_id: 'user-123' }],
        error: null,
      });

      const result = await setPermitUnderReview(validUUID, 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Permit status has changed. Please refresh and try again.');
    });

    // B8: status change committed; notification failure must only warn.
    it('should still succeed but surface a warning when notification dispatch fails', async () => {
      setupUnderReviewMocks();
      mockCreateNotification.mockRejectedValueOnce(new Error('SMTP outage'));

      const result = await setPermitUnderReview(validUUID, 'csrf-token');

      expect(result.success).toBe(true);
      expect(result.warning).toBeDefined();
      expect(result.warning).toMatch(/notification/i);
    });

    // PR1 (v1.3.0 re-audit): every successful under_review transition must
    // write an audit_logs row. Previously the action only wrote to
    // permit_status_history, leaving the audit pane blind to who started a review.
    it('should log permit_review_started on successful transition', async () => {
      setupUnderReviewMocks();

      await setPermitUnderReview(validUUID, 'csrf-token');

      expect(mockLogAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        userId: adminUser.id,
        action: 'permit_review_started',
        metadata: expect.objectContaining({ permitId: validUUID, prevStatus: 'submitted' }),
      }));
    });
  });

  // ---------------------------------------------------------------------------
  // getPermitStats
  // ---------------------------------------------------------------------------

  describe('getPermitStats', () => {
    it('should return permit statistics for admin', async () => {
      const mockStats = [{
        total_permits: 100,
        draft_count: 20,
        submitted_count: 30,
        under_review_count: 10,
        approved_count: 25,
        rejected_count: 5,
        revision_requested_count: 8,
        permits_today: 3,
      }];
      mockRpc.mockResolvedValueOnce({ data: mockStats, error: null });

      const result = await getPermitStats();

      expect(result.data).not.toBeNull();
      expect(result.data!.totalPermits).toBe(100);
      expect(result.data!.draftCount).toBe(20);
      expect(result.data!.submittedCount).toBe(30);
      expect(result.data!.underReviewCount).toBe(10);
      expect(result.data!.approvedCount).toBe(25);
      expect(result.data!.rejectedCount).toBe(5);
      expect(result.data!.revisionRequestedCount).toBe(8);
      expect(result.data!.permitsToday).toBe(3);
    });

    it('should reject non-admin users', async () => {
      mockRequireAdmin.mockResolvedValue({ success: false, error: 'Admin access required' });

      const result = await getPermitStats();

      expect(result.data).toBeNull();
      expect(result.error).toBe('Admin access required');
    });

    it('should handle RPC error gracefully', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'DB error' } });

      const result = await getPermitStats();

      expect(result.data).toBeNull();
      expect(result.error).toBe('Failed to fetch permit stats');
    });

    it('should return error when no stats available', async () => {
      mockRpc.mockResolvedValueOnce({ data: [], error: null });

      const result = await getPermitStats();

      expect(result.data).toBeNull();
      expect(result.error).toBe('No stats available');
    });

    it('should call get_permit_stats RPC', async () => {
      mockRpc.mockResolvedValueOnce({ data: [{ total_permits: 0, draft_count: 0, submitted_count: 0, under_review_count: 0, approved_count: 0, rejected_count: 0, revision_requested_count: 0, permits_today: 0 }], error: null });

      await getPermitStats();

      expect(mockRpc).toHaveBeenCalledWith('get_permit_stats');
    });

    it('should handle non-numeric values gracefully', async () => {
      mockRpc.mockResolvedValueOnce({
        data: [{
          total_permits: null,
          draft_count: undefined,
          submitted_count: 'not-a-number',
          under_review_count: 0,
          approved_count: 0,
          rejected_count: 0,
          revision_requested_count: 0,
          permits_today: 0,
        }],
        error: null,
      });

      const result = await getPermitStats();

      expect(result.data).not.toBeNull();
      expect(result.data!.totalPermits).toBe(0);
      expect(result.data!.draftCount).toBe(0);
      expect(result.data!.submittedCount).toBe(0);
    });
  });
});
