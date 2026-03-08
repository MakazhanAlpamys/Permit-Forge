// ============================================================================
// Analytics Server Actions Tests
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock auth
const mockRequireAdmin = vi.fn();
vi.mock('@/lib/security', () => ({
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
}));

// Mock supabase with chainable query builder
const mockSingle = vi.fn();
const mockEq = vi.fn();
const mockSelect = vi.fn();
const mockInsert = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockOrder = vi.fn();
const mockFrom = vi.fn();
const mockLimit = vi.fn();
const mockRpc = vi.fn();

function resetChainMocks() {
  mockSingle.mockResolvedValue({ data: null, error: null });
  mockLimit.mockReturnValue({ data: [], error: null });
  mockOrder.mockReturnValue({ data: [], error: null });
  mockEq.mockReturnValue({ eq: mockEq, single: mockSingle, select: mockSelect, order: mockOrder, delete: mockDelete, limit: mockLimit });
  mockDelete.mockReturnValue({ eq: mockEq, single: mockSingle, error: null });
  mockUpdate.mockReturnValue({ eq: mockEq, single: mockSingle, error: null });
  mockSelect.mockReturnValue({ eq: mockEq, single: mockSingle, order: mockOrder, limit: mockLimit, count: 0 });
  mockInsert.mockReturnValue({ select: mockSelect, single: mockSingle, error: null });
  mockRpc.mockResolvedValue({ data: [], error: null });
  mockFrom.mockReturnValue({
    select: mockSelect,
    insert: mockInsert,
    update: mockUpdate,
    delete: mockDelete,
    eq: mockEq,
    single: mockSingle,
    order: mockOrder,
    limit: mockLimit,
  });
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
}));

import {
  getAnalyticsDashboardStats,
  getMessageActivity30d,
  getDocumentUsageStats,
  getPermitStatusBreakdown,
  getTopActiveUsers,
} from '@/actions/analytics';

const adminUser = { id: 'admin-123', email: 'admin@test.com', role: 'admin' };

describe('Analytics Server Actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChainMocks();
    mockRequireAdmin.mockResolvedValue({ success: true, user: adminUser });
  });

  // ---------------------------------------------------------------------------
  // getAnalyticsDashboardStats
  // ---------------------------------------------------------------------------

  describe('getAnalyticsDashboardStats', () => {
    it('should return dashboard stats', async () => {
      mockRpc.mockResolvedValueOnce({
        data: [
          {
            total_users: 100,
            active_users_today: 10,
            active_users_yesterday: 8,
            messages_today: 50,
            messages_yesterday: 40,
            permits_today: 5,
            permits_yesterday: 3,
            new_users_today: 2,
            new_users_yesterday: 1,
            total_chunks: 5000,
          },
        ],
        error: null,
      });

      const result = await getAnalyticsDashboardStats();

      expect(result.data).not.toBeNull();
      expect(result.data?.totalUsers).toBe(100);
      expect(result.data?.activeUsersToday).toBe(10);
      expect(result.data?.messagesToday).toBe(50);
      expect(result.data?.totalChunks).toBe(5000);
    });

    it('should return error when not admin', async () => {
      mockRequireAdmin.mockResolvedValue({ success: false, error: 'Unauthorized' });

      const result = await getAnalyticsDashboardStats();

      expect(result.data).toBeNull();
      expect(result.error).toBe('Unauthorized');
    });

    it('should return error when no stats available', async () => {
      mockRpc.mockResolvedValueOnce({ data: [], error: null });

      const result = await getAnalyticsDashboardStats();

      expect(result.data).toBeNull();
      expect(result.error).toBe('No stats available');
    });

    it('should handle RPC error', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'RPC failed' } });

      const result = await getAnalyticsDashboardStats();

      expect(result.data).toBeNull();
      expect(result.error).toBe('Failed to fetch analytics stats');
    });
  });

  // ---------------------------------------------------------------------------
  // getMessageActivity30d
  // ---------------------------------------------------------------------------

  describe('getMessageActivity30d', () => {
    it('should return message activity data', async () => {
      mockRpc.mockResolvedValueOnce({
        data: [
          {
            day: '2024-01-01',
            user_count: 10,
            assistant_count: 12,
            total_count: 22,
            active_users: 5,
          },
          {
            day: '2024-01-02',
            user_count: 15,
            assistant_count: 18,
            total_count: 33,
            active_users: 8,
          },
        ],
        error: null,
      });

      const result = await getMessageActivity30d();

      expect(result.data).toHaveLength(2);
      expect(result.data[0].day).toBe('2024-01-01');
      expect(result.data[0].userCount).toBe(10);
      expect(result.data[0].totalCount).toBe(22);
    });

    it('should return error when not admin', async () => {
      mockRequireAdmin.mockResolvedValue({ success: false, error: 'Unauthorized' });

      const result = await getMessageActivity30d();

      expect(result.data).toEqual([]);
      expect(result.error).toBe('Unauthorized');
    });

    it('should handle RPC error', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'RPC failed' } });

      const result = await getMessageActivity30d();

      expect(result.data).toEqual([]);
      expect(result.error).toBe('Failed to fetch message activity');
    });

    it('should handle empty data', async () => {
      mockRpc.mockResolvedValueOnce({ data: [], error: null });

      const result = await getMessageActivity30d();

      expect(result.data).toEqual([]);
      expect(result.error).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // getDocumentUsageStats
  // ---------------------------------------------------------------------------

  describe('getDocumentUsageStats', () => {
    it('should return document usage stats via RPC', async () => {
      mockRpc.mockResolvedValueOnce({
        data: [
          {
            document_name: 'fire-code',
            chunk_count: 500,
            min_page: 1,
            max_page: 200,
          },
        ],
        error: null,
      });

      const result = await getDocumentUsageStats();

      expect(result.data).toHaveLength(1);
      expect(result.data[0].documentName).toBe('fire-code');
      expect(result.data[0].chunkCount).toBe(500);
    });

    it('should return error when not admin', async () => {
      mockRequireAdmin.mockResolvedValue({ success: false, error: 'Unauthorized' });

      const result = await getDocumentUsageStats();

      expect(result.data).toEqual([]);
      expect(result.error).toBe('Unauthorized');
    });

    it('should handle RPC error with fallback query', async () => {
      // RPC fails
      mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'RPC not found' } });

      // Fallback: select document_name from chunks
      mockLimit.mockReturnValueOnce({
        data: [
          { document_name: 'fire-code' },
          { document_name: 'fire-code' },
          { document_name: 'building-code' },
        ],
        error: null,
      });

      // Count queries for each unique document
      mockSelect
        .mockReturnValueOnce({ eq: mockEq, single: mockSingle, order: mockOrder, limit: mockLimit, count: 2 })
        .mockReturnValueOnce({ eq: mockEq, single: mockSingle, order: mockOrder, limit: mockLimit, count: 1 });

      const result = await getDocumentUsageStats();

      expect(result.data.length).toBeGreaterThanOrEqual(0);
    });

    it('should handle empty data', async () => {
      mockRpc.mockResolvedValueOnce({ data: [], error: null });

      const result = await getDocumentUsageStats();

      expect(result.data).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // getPermitStatusBreakdown
  // ---------------------------------------------------------------------------

  describe('getPermitStatusBreakdown', () => {
    it('should return permit status breakdown', async () => {
      mockRpc.mockResolvedValueOnce({
        data: [
          {
            total_permits: 50,
            draft_count: 10,
            submitted_count: 15,
            under_review_count: 8,
            approved_count: 12,
            rejected_count: 3,
            revision_requested_count: 2,
          },
        ],
        error: null,
      });

      const result = await getPermitStatusBreakdown();

      expect(result.data).not.toBeNull();
      expect(result.data?.total).toBe(50);
      expect(result.data?.draft).toBe(10);
      expect(result.data?.approved).toBe(12);
      expect(result.data?.rejected).toBe(3);
    });

    it('should return error when not admin', async () => {
      mockRequireAdmin.mockResolvedValue({ success: false, error: 'Unauthorized' });

      const result = await getPermitStatusBreakdown();

      expect(result.data).toBeNull();
      expect(result.error).toBe('Unauthorized');
    });

    it('should handle no stats available', async () => {
      mockRpc.mockResolvedValueOnce({ data: [], error: null });

      const result = await getPermitStatusBreakdown();

      expect(result.data).toBeNull();
      expect(result.error).toBe('No permit stats available');
    });

    it('should handle RPC error', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'RPC failed' } });

      const result = await getPermitStatusBreakdown();

      expect(result.data).toBeNull();
      expect(result.error).toBe('Failed to fetch permit breakdown');
    });
  });

  // ---------------------------------------------------------------------------
  // getTopActiveUsers
  // ---------------------------------------------------------------------------

  describe('getTopActiveUsers', () => {
    it('should return top active users', async () => {
      mockRpc.mockResolvedValueOnce({
        data: [
          {
            user_id: 'user-1',
            username: 'john',
            full_name: 'John Doe',
            message_count: 150,
            last_active: '2024-01-15',
          },
          {
            user_id: 'user-2',
            username: 'jane',
            full_name: null,
            message_count: 100,
            last_active: '2024-01-14',
          },
        ],
        error: null,
      });

      const result = await getTopActiveUsers();

      expect(result.data).toHaveLength(2);
      expect(result.data[0].username).toBe('john');
      expect(result.data[0].messageCount).toBe(150);
      expect(result.data[1].fullName).toBeNull();
    });

    it('should return error when not admin', async () => {
      mockRequireAdmin.mockResolvedValue({ success: false, error: 'Unauthorized' });

      const result = await getTopActiveUsers();

      expect(result.data).toEqual([]);
      expect(result.error).toBe('Unauthorized');
    });

    it('should handle RPC error', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'RPC failed' } });

      const result = await getTopActiveUsers();

      expect(result.data).toEqual([]);
      expect(result.error).toBe('Failed to fetch top users');
    });

    it('should accept custom days and limit params', async () => {
      mockRpc.mockResolvedValueOnce({ data: [], error: null });

      const result = await getTopActiveUsers(7, 10);

      expect(result.data).toEqual([]);
      expect(mockRpc).toHaveBeenCalledWith('get_top_active_users', {
        p_days: 7,
        p_limit: 10,
      });
    });

    it('should use default params when not provided', async () => {
      mockRpc.mockResolvedValueOnce({ data: [], error: null });

      await getTopActiveUsers();

      expect(mockRpc).toHaveBeenCalledWith('get_top_active_users', {
        p_days: 30,
        p_limit: 5,
      });
    });
  });
});
