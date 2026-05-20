// ============================================================================
// Notification Server Actions Tests
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock auth
const mockRequireAuth = vi.fn();
const mockRequireCSRF = vi.fn();
vi.mock('@/lib/security', () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
  requireCSRF: (...args: unknown[]) => mockRequireCSRF(...args),
}));

const mockGetQuickSession = vi.fn();
vi.mock('@/lib/auth', () => ({
  getQuickSession: (...args: unknown[]) => mockGetQuickSession(...args),
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

function resetChainMocks() {
  mockSingle.mockResolvedValue({ data: null, error: null });
  mockLimit.mockReturnValue({ data: [], error: null });
  mockOrder.mockReturnValue({ data: [], error: null, limit: mockLimit });
  mockEq.mockReturnValue({ eq: mockEq, single: mockSingle, select: mockSelect, order: mockOrder, delete: mockDelete, limit: mockLimit, count: 0 });
  mockDelete.mockReturnValue({ eq: mockEq, single: mockSingle, error: null });
  mockUpdate.mockReturnValue({ eq: mockEq, single: mockSingle, error: null });
  mockSelect.mockReturnValue({ eq: mockEq, single: mockSingle, order: mockOrder, limit: mockLimit });
  mockInsert.mockReturnValue({ select: mockSelect, single: mockSingle, error: null });
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
  })),
  createAdminClient: vi.fn(() => ({
    from: (...args: unknown[]) => mockFrom(...args),
  })),
  // A2: user-context client backed by the same chainable mock.
  createUserContextClient: vi.fn(async () => ({
    from: (...args: unknown[]) => mockFrom(...args),
  })),
}));

import {
  getNotifications,
  markNotificationRead,
  markAllNotificationsRead,
} from '@/actions/notifications';

const testUser = { id: 'user-123', email: 'test@test.com', role: 'user' };
const validUUID = '550e8400-e29b-41d4-a716-446655440000';

describe('Notification Server Actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChainMocks();
    mockRequireAuth.mockResolvedValue({ success: true, user: testUser });
    mockRequireCSRF.mockResolvedValue({ valid: true });
    mockGetQuickSession.mockResolvedValue(testUser);
  });

  // ---------------------------------------------------------------------------
  // getNotifications
  // ---------------------------------------------------------------------------

  describe('getNotifications', () => {
    it('should return notifications for authenticated user', async () => {
      // Mock notifications query
      mockLimit.mockReturnValueOnce({
        data: [
          {
            id: validUUID,
            user_id: testUser.id,
            type: 'permit_submitted',
            title: 'Permit Submitted',
            body: 'Your permit has been submitted',
            data: { permitId: 'p-1' },
            read: false,
            created_at: '2024-01-01',
          },
        ],
        error: null,
      });
      // Mock unread count query (select -> eq -> eq returns count)
      mockEq.mockReturnValue({ eq: mockEq, single: mockSingle, select: mockSelect, order: mockOrder, delete: mockDelete, limit: mockLimit, count: 3 });

      const result = await getNotifications();

      expect(result.data).toHaveLength(1);
      expect(result.data[0].title).toBe('Permit Submitted');
      expect(result.data[0].read).toBe(false);
    });

    it('should return error when not authenticated', async () => {
      mockGetQuickSession.mockResolvedValue(null);

      const result = await getNotifications();

      expect(result.data).toEqual([]);
      expect(result.unreadCount).toBe(0);
      expect(result.error).toBe('Not authenticated');
    });

    it('should handle empty notifications', async () => {
      mockLimit.mockReturnValueOnce({ data: [], error: null });

      const result = await getNotifications();

      expect(result.data).toEqual([]);
    });

    it('should accept custom limit', async () => {
      mockLimit.mockReturnValueOnce({ data: [], error: null });

      const result = await getNotifications(5);

      expect(result.error).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // markNotificationRead
  // ---------------------------------------------------------------------------

  describe('markNotificationRead', () => {
    it('should mark notification as read', async () => {
      const result = await markNotificationRead(validUUID, 'csrf-token');

      expect(result.success).toBe(true);
      expect(mockFrom).toHaveBeenCalledWith('notifications');
    });

    it('should return error when unauthenticated', async () => {
      mockRequireAuth.mockResolvedValue({ success: false, error: 'Not authenticated' });

      const result = await markNotificationRead(validUUID, 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Not authenticated');
    });

    it('should reject invalid CSRF token', async () => {
      mockRequireCSRF.mockResolvedValue({ valid: false, error: 'CSRF token invalid' });

      const result = await markNotificationRead(validUUID, 'bad-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('CSRF token invalid');
    });

    it('should reject invalid notification ID', async () => {
      const result = await markNotificationRead('not-a-uuid', 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid notification ID');
    });

    it('should handle DB error', async () => {
      mockUpdate.mockReturnValueOnce({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({ error: { message: 'DB error' } }),
        }),
      });

      // The function catches errors, so it should still return success: false
      const result = await markNotificationRead(validUUID, 'csrf-token');

      expect(result.success).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // markAllNotificationsRead
  // ---------------------------------------------------------------------------

  describe('markAllNotificationsRead', () => {
    it('should mark all notifications as read', async () => {
      const result = await markAllNotificationsRead('csrf-token');

      expect(result.success).toBe(true);
      expect(mockFrom).toHaveBeenCalledWith('notifications');
    });

    it('should return error when unauthenticated', async () => {
      mockRequireAuth.mockResolvedValue({ success: false, error: 'Not authenticated' });

      const result = await markAllNotificationsRead('csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Not authenticated');
    });

    it('should reject invalid CSRF token', async () => {
      mockRequireCSRF.mockResolvedValue({ valid: false, error: 'CSRF token invalid' });

      const result = await markAllNotificationsRead('bad-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('CSRF token invalid');
    });

    it('should handle DB error', async () => {
      mockUpdate.mockReturnValueOnce({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({ error: { message: 'DB error' } }),
        }),
      });

      const result = await markAllNotificationsRead('csrf-token');

      expect(result.success).toBe(false);
    });
  });
});
