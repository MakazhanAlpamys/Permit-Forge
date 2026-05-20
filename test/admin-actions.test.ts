// ============================================================================
// Admin Server Actions Tests
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
const mockHashPassword = vi.fn().mockResolvedValue('hashed-password-123');
const mockGetQuickSession = vi.fn();
const mockLogAuditEvent = vi.fn().mockResolvedValue(undefined);
const mockGetRequestMetadata = vi.fn().mockResolvedValue({ ip: '127.0.0.1', userAgent: 'test' });
// logAuditWithMeta is the convenience wrapper (F4); it composes getRequestMetadata
// + logAuditEvent, so adapt the existing audit assertions onto a single mock.
const mockLogAuditWithMeta = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/auth', () => ({
  hashPassword: (...args: unknown[]) => mockHashPassword(...args),
  getQuickSession: (...args: unknown[]) => mockGetQuickSession(...args),
  logAuditEvent: (...args: unknown[]) => mockLogAuditEvent(...args),
  logAuditWithMeta: (...args: unknown[]) => mockLogAuditWithMeta(...args),
  getRequestMetadata: (...args: unknown[]) => mockGetRequestMetadata(...args),
}));

// Mock supabase with chainable query builder
const mockSingle = vi.fn();
const mockEq = vi.fn();
const mockNeq = vi.fn();
const mockSelect = vi.fn();
const mockInsert = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockOrder = vi.fn();
const mockLimit = vi.fn();
const mockIlike = vi.fn();
const mockRange = vi.fn();
const mockOr = vi.fn();
const mockFrom = vi.fn();
const mockRpc = vi.fn();

function resetChainMocks() {
  mockSingle.mockResolvedValue({ data: null, error: null });
  mockOrder.mockReturnValue({ data: [], error: null });
  mockLimit.mockReturnValue({ data: [], error: null });
  mockRange.mockReturnValue({ data: [], error: null });
  mockIlike.mockReturnValue({ eq: mockEq, single: mockSingle, order: mockOrder, limit: mockLimit, range: mockRange });
  mockOr.mockReturnValue({ eq: mockEq, single: mockSingle, order: mockOrder, limit: mockLimit, range: mockRange });
  mockNeq.mockReturnValue({ eq: mockEq, single: mockSingle, select: mockSelect, order: mockOrder, limit: mockLimit });
  mockEq.mockReturnValue({ eq: mockEq, neq: mockNeq, single: mockSingle, select: mockSelect, order: mockOrder, delete: mockDelete, limit: mockLimit, range: mockRange });
  mockDelete.mockReturnValue({ eq: mockEq, single: mockSingle, error: null });
  mockUpdate.mockReturnValue({ eq: mockEq, single: mockSingle, error: null });
  mockSelect.mockReturnValue({ eq: mockEq, single: mockSingle, order: mockOrder, limit: mockLimit, range: mockRange, ilike: mockIlike, or: mockOr, neq: mockNeq });
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
vi.mock('@/lib/notifications', () => ({
  createNotification: vi.fn().mockResolvedValue(undefined),
  getNotificationContent: vi.fn().mockReturnValue({ title: 'Test', body: 'Test notification' }),
}));

import {
  getAuditLogs,
  getAllUsers,
  blockUser,
  updateUserRole,
  adminCreateUser,
  adminDeleteUser,
  adminResetPassword,
} from '@/actions/admin';

const adminUser = { id: 'admin-123', username: 'admin', role: 'admin' };
const validUUID = '550e8400-e29b-41d4-a716-446655440000';
const targetUUID = '660e8400-e29b-41d4-a716-446655440001';

describe('Admin Server Actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChainMocks();
    mockRequireAdmin.mockResolvedValue({ success: true, user: adminUser });
    mockRequireCSRF.mockResolvedValue({ valid: true });
  });

  // ---------------------------------------------------------------------------
  // getAuditLogs
  // ---------------------------------------------------------------------------

  describe('getAuditLogs', () => {
    it('should return audit logs for admin', async () => {
      const mockLogs = [
        {
          id: 1,
          user_id: 'admin-123',
          username: 'admin',
          action: 'login',
          target_user_id: null,
          target_username: null,
          metadata: {},
          ip_address: '127.0.0.1',
          created_at: '2024-01-01T00:00:00Z',
        },
      ];
      mockRpc.mockResolvedValueOnce({ data: mockLogs, error: null });

      const result = await getAuditLogs(50);

      expect(result.data).toHaveLength(1);
      expect(result.data[0].action).toBe('login');
      expect(result.data[0].userId).toBe('admin-123');
      expect(result.error).toBeUndefined();
    });

    it('should reject non-admin users', async () => {
      mockRequireAdmin.mockResolvedValue({ success: false, error: 'Admin access required' });

      const result = await getAuditLogs();

      expect(result.data).toEqual([]);
      expect(result.error).toBe('Admin access required');
    });

    it('should handle RPC error gracefully', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'DB error' } });

      const result = await getAuditLogs();

      expect(result.data).toEqual([]);
      expect(result.error).toBe('Failed to fetch logs');
    });

    it('should pass action filter to RPC', async () => {
      mockRpc.mockResolvedValueOnce({ data: [], error: null });

      await getAuditLogs(50, 'login');

      expect(mockRpc).toHaveBeenCalledWith('get_recent_audit_logs', {
        p_limit: 50,
        p_action_filter: 'login',
      });
    });

    it('should clamp limit to valid range', async () => {
      mockRpc.mockResolvedValueOnce({ data: [], error: null });

      await getAuditLogs(9999);

      expect(mockRpc).toHaveBeenCalledWith('get_recent_audit_logs', {
        p_limit: 500,
        p_action_filter: null,
      });
    });

    it('should return empty data on null response', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: null });

      const result = await getAuditLogs();

      expect(result.data).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // getAllUsers
  // ---------------------------------------------------------------------------

  describe('getAllUsers', () => {
    it('should return users for admin', async () => {
      const mockUsers = [
        {
          id: 'user-1',
          username: 'testuser',
          full_name: 'Test User',
          role: 'user',
          blocked: false,
          blocked_reason: null,
          created_at: '2024-01-01T00:00:00Z',
          last_login: null,
          session_count: 5,
          message_count: 10,
        },
      ];
      mockRpc.mockResolvedValueOnce({ data: mockUsers, error: null });

      const result = await getAllUsers();

      expect(result.data).toHaveLength(1);
      expect(result.data[0].username).toBe('testuser');
      expect(result.data[0].fullName).toBe('Test User');
      expect(result.data[0].sessionCount).toBe(5);
    });

    it('should reject non-admin users', async () => {
      mockRequireAdmin.mockResolvedValue({ success: false, error: 'Admin access required' });

      const result = await getAllUsers();

      expect(result.data).toEqual([]);
      expect(result.error).toBe('Admin access required');
    });

    it('should pass search and pagination params', async () => {
      mockRpc.mockResolvedValueOnce({ data: [], error: null });

      await getAllUsers(25, 10, 'john');

      expect(mockRpc).toHaveBeenCalledWith('get_all_users_admin', {
        p_admin_id: adminUser.id,
        p_limit: 25,
        p_offset: 10,
        p_search: 'john',
      });
    });

    it('should clamp limit to valid range', async () => {
      mockRpc.mockResolvedValueOnce({ data: [], error: null });

      await getAllUsers(200, 0);

      expect(mockRpc).toHaveBeenCalledWith('get_all_users_admin', expect.objectContaining({
        p_limit: 100,
      }));
    });

    it('should handle RPC error gracefully', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'DB error' } });

      const result = await getAllUsers();

      expect(result.data).toEqual([]);
      expect(result.error).toBe('Failed to fetch users');
    });
  });

  // ---------------------------------------------------------------------------
  // blockUser
  // ---------------------------------------------------------------------------

  describe('blockUser', () => {
    it('should block a user successfully', async () => {
      mockRpc.mockResolvedValueOnce({ error: null });

      const result = await blockUser(validUUID, true, 'Spam account', 'csrf-token');

      expect(result.success).toBe(true);
      expect(mockRpc).toHaveBeenCalledWith('admin_block_user', {
        p_admin_id: adminUser.id,
        p_target_user_id: validUUID,
        p_blocked: true,
        p_reason: 'Spam account',
      });
    });

    it('should unblock a user successfully', async () => {
      mockRpc.mockResolvedValueOnce({ error: null });

      const result = await blockUser(validUUID, false, undefined, 'csrf-token');

      expect(result.success).toBe(true);
      expect(mockLogAuditWithMeta).toHaveBeenCalledWith(
        adminUser.id,
        'user_unblocked',
        expect.objectContaining({ targetUserId: validUUID }),
      );
    });

    it('should reject non-admin users', async () => {
      mockRequireAdmin.mockResolvedValue({ success: false, error: 'Admin access required' });

      const result = await blockUser(validUUID, true, 'reason', 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Admin access required');
    });

    it('should reject invalid CSRF token', async () => {
      mockRequireCSRF.mockResolvedValue({ valid: false, error: 'CSRF token invalid' });

      const result = await blockUser(validUUID, true, 'reason', 'bad-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('CSRF token invalid');
    });

    it('should reject invalid user ID', async () => {
      const result = await blockUser('not-a-uuid', true, 'reason', 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid user ID');
    });

    it('should handle RPC error gracefully', async () => {
      mockRpc.mockResolvedValueOnce({ error: { message: 'DB error' } });

      const result = await blockUser(validUUID, true, 'reason', 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to update user');
    });

    it('should log audit event on success', async () => {
      mockRpc.mockResolvedValueOnce({ error: null });

      await blockUser(validUUID, true, 'Spam', 'csrf-token');

      expect(mockLogAuditWithMeta).toHaveBeenCalledWith(
        adminUser.id,
        'user_blocked',
        expect.objectContaining({
          targetUserId: validUUID,
          metadata: { reason: 'Spam' },
        }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // updateUserRole
  // ---------------------------------------------------------------------------

  describe('updateUserRole', () => {
    it('should update role successfully', async () => {
      mockRpc.mockResolvedValueOnce({ error: null });

      const result = await updateUserRole(validUUID, 'admin', 'csrf-token');

      expect(result.success).toBe(true);
      expect(mockRpc).toHaveBeenCalledWith('admin_update_user_role', {
        p_admin_id: adminUser.id,
        p_target_user_id: validUUID,
        p_new_role: 'admin',
      });
    });

    it('should reject non-admin users', async () => {
      mockRequireAdmin.mockResolvedValue({ success: false, error: 'Admin access required' });

      const result = await updateUserRole(validUUID, 'admin', 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Admin access required');
    });

    it('should reject invalid CSRF token', async () => {
      mockRequireCSRF.mockResolvedValue({ valid: false, error: 'CSRF token invalid' });

      const result = await updateUserRole(validUUID, 'admin', 'bad-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('CSRF token invalid');
    });

    it('should reject invalid user ID', async () => {
      const result = await updateUserRole('not-a-uuid', 'admin', 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid user ID');
    });

    it('should log audit event with new role', async () => {
      mockRpc.mockResolvedValueOnce({ error: null });

      await updateUserRole(validUUID, 'user', 'csrf-token');

      expect(mockLogAuditWithMeta).toHaveBeenCalledWith(
        adminUser.id,
        'role_changed',
        expect.objectContaining({
          targetUserId: validUUID,
          metadata: { newRole: 'user' },
        }),
      );
    });

    it('should handle RPC error gracefully', async () => {
      mockRpc.mockResolvedValueOnce({ error: { message: 'DB error' } });

      const result = await updateUserRole(validUUID, 'admin', 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to update role');
    });
  });

  // ---------------------------------------------------------------------------
  // adminCreateUser
  // ---------------------------------------------------------------------------

  describe('adminCreateUser', () => {
    const validUserData = {
      username: 'newuser',
      password: 'StrongPass123!',
      full_name: 'New User',
      role: 'user' as const,
    };

    it('should create a user successfully', async () => {
      // First call: check existing user (not found)
      mockSingle.mockResolvedValueOnce({ data: null, error: null });
      // Second call: insert new user
      mockSingle.mockResolvedValueOnce({ data: { id: validUUID }, error: null });

      const result = await adminCreateUser(validUserData, 'csrf-token');

      expect(result.success).toBe(true);
      expect(result.userId).toBe(validUUID);
      expect(mockHashPassword).toHaveBeenCalledWith('StrongPass123!');
    });

    it('should reject non-admin users', async () => {
      mockRequireAdmin.mockResolvedValue({ success: false, error: 'Admin access required' });

      const result = await adminCreateUser(validUserData, 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Admin access required');
    });

    it('should reject invalid CSRF token', async () => {
      mockRequireCSRF.mockResolvedValue({ valid: false, error: 'CSRF token invalid' });

      const result = await adminCreateUser(validUserData, 'bad-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('CSRF token invalid');
    });

    it('should reject invalid username (too short)', async () => {
      const result = await adminCreateUser(
        { ...validUserData, username: 'ab' },
        'csrf-token',
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should reject if username already exists', async () => {
      mockSingle.mockResolvedValueOnce({ data: { id: 'existing-id' }, error: null });

      const result = await adminCreateUser(validUserData, 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Username already exists');
    });

    it('should handle duplicate key constraint error', async () => {
      mockSingle.mockResolvedValueOnce({ data: null, error: null });
      mockSingle.mockResolvedValueOnce({ data: null, error: { code: '23505', message: 'duplicate key' } });

      const result = await adminCreateUser(validUserData, 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Username already exists');
    });

    it('should log audit event on success', async () => {
      mockSingle.mockResolvedValueOnce({ data: null, error: null });
      mockSingle.mockResolvedValueOnce({ data: { id: validUUID }, error: null });

      await adminCreateUser(validUserData, 'csrf-token');

      expect(mockLogAuditWithMeta).toHaveBeenCalledWith(
        adminUser.id,
        'user_created',
        expect.objectContaining({ targetUserId: validUUID }),
      );
    });

    it('should not fail if audit log throws', async () => {
      mockSingle.mockResolvedValueOnce({ data: null, error: null });
      mockSingle.mockResolvedValueOnce({ data: { id: validUUID }, error: null });
      mockLogAuditWithMeta.mockRejectedValueOnce(new Error('audit failure'));

      const result = await adminCreateUser(validUserData, 'csrf-token');

      expect(result.success).toBe(true);
      expect(result.userId).toBe(validUUID);
    });
  });

  // ---------------------------------------------------------------------------
  // adminDeleteUser
  // ---------------------------------------------------------------------------

  describe('adminDeleteUser', () => {
    it('should delete a user successfully', async () => {
      // First: get username for logging
      mockSingle.mockResolvedValueOnce({ data: { username: 'deleteduser' }, error: null });
      // Second: delete returns via chain (mockDelete -> eq -> no error)
      mockDelete.mockReturnValueOnce({ eq: mockEq, error: null });

      const result = await adminDeleteUser(targetUUID, 'csrf-token');

      expect(result.success).toBe(true);
      expect(mockFrom).toHaveBeenCalledWith('users');
    });

    it('should reject non-admin users', async () => {
      mockRequireAdmin.mockResolvedValue({ success: false, error: 'Admin access required' });

      const result = await adminDeleteUser(targetUUID, 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Admin access required');
    });

    it('should reject invalid CSRF token', async () => {
      mockRequireCSRF.mockResolvedValue({ valid: false, error: 'CSRF token invalid' });

      const result = await adminDeleteUser(targetUUID, 'bad-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('CSRF token invalid');
    });

    it('should reject invalid user ID', async () => {
      const result = await adminDeleteUser('not-a-uuid', 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid user ID');
    });

    it('should prevent self-deletion', async () => {
      // Use a valid UUID for admin so it passes UUID validation
      const adminUUID = '770e8400-e29b-41d4-a716-446655440002';
      mockRequireAdmin.mockResolvedValue({ success: true, user: { ...adminUser, id: adminUUID } });

      const result = await adminDeleteUser(adminUUID, 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Cannot delete yourself');
    });

    it('should log audit event with username', async () => {
      mockSingle.mockResolvedValueOnce({ data: { username: 'deleteduser' }, error: null });
      mockDelete.mockReturnValueOnce({ eq: mockEq, error: null });

      await adminDeleteUser(targetUUID, 'csrf-token');

      expect(mockLogAuditWithMeta).toHaveBeenCalledWith(
        adminUser.id,
        'user_deleted',
        expect.objectContaining({
          targetUserId: targetUUID,
          metadata: { action: 'deleted', username: 'deleteduser' },
        }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // adminResetPassword
  // ---------------------------------------------------------------------------

  describe('adminResetPassword', () => {
    it('should reset password successfully', async () => {
      mockUpdate.mockReturnValueOnce({ eq: mockEq, error: null });

      const result = await adminResetPassword(validUUID, 'NewStrong123!', 'csrf-token');

      expect(result.success).toBe(true);
      expect(mockHashPassword).toHaveBeenCalledWith('NewStrong123!');
    });

    it('should reject non-admin users', async () => {
      mockRequireAdmin.mockResolvedValue({ success: false, error: 'Admin access required' });

      const result = await adminResetPassword(validUUID, 'NewStrong123!', 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Admin access required');
    });

    it('should reject invalid CSRF token', async () => {
      mockRequireCSRF.mockResolvedValue({ valid: false, error: 'CSRF token invalid' });

      const result = await adminResetPassword(validUUID, 'NewStrong123!', 'bad-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('CSRF token invalid');
    });

    it('should reject invalid user ID', async () => {
      const result = await adminResetPassword('not-a-uuid', 'NewStrong123!', 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid user ID');
    });

    it('should reject weak password', async () => {
      const result = await adminResetPassword(validUUID, 'weak', 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should log audit event on success', async () => {
      mockUpdate.mockReturnValueOnce({ eq: mockEq, error: null });

      await adminResetPassword(validUUID, 'NewStrong123!', 'csrf-token');

      expect(mockLogAuditWithMeta).toHaveBeenCalledWith(
        adminUser.id,
        'password_reset',
        expect.objectContaining({ targetUserId: validUUID }),
      );
    });

    it('should handle DB error gracefully', async () => {
      mockUpdate.mockReturnValueOnce({
        eq: vi.fn().mockReturnValue({ error: { message: 'DB error' } }),
      });

      const result = await adminResetPassword(validUUID, 'NewStrong123!', 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to reset password');
    });
  });
});
