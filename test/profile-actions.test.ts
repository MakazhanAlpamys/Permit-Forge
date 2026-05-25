// ============================================================================
// Profile Server Actions Tests
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock security
const mockRequireAuth = vi.fn();
const mockRequireAdmin = vi.fn();
const mockRequireCSRF = vi.fn();
vi.mock('@/lib/security', () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
  requireCSRF: (...args: unknown[]) => mockRequireCSRF(...args),
}));

// Mock auth
const mockHashPassword = vi.fn();
const mockVerifyPassword = vi.fn();
const mockLogAuditEvent = vi.fn().mockResolvedValue(undefined);
const mockGetRequestMetadata = vi.fn().mockResolvedValue({ ipAddress: '127.0.0.1', userAgent: 'test' });
const mockCreateSession = vi.fn().mockResolvedValue(undefined);
const mockGetQuickSession = vi.fn();
vi.mock('@/lib/auth', () => ({
  hashPassword: (...args: unknown[]) => mockHashPassword(...args),
  verifyPassword: (...args: unknown[]) => mockVerifyPassword(...args),
  logAuditEvent: (...args: unknown[]) => mockLogAuditEvent(...args),
  getRequestMetadata: (...args: unknown[]) => mockGetRequestMetadata(...args),
  createSession: (...args: unknown[]) => mockCreateSession(...args),
  getQuickSession: (...args: unknown[]) => mockGetQuickSession(...args),
  // v1.8.0 Part B: delegate to existing mocks so audit-event assertions still fire.
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

// Mock email
const mockGenerateSixDigitCode = vi.fn();
const mockSendPasswordChangeCodeEmail = vi.fn();
vi.mock('@/lib/email', () => ({
  generateSixDigitCode: (...args: unknown[]) => mockGenerateSixDigitCode(...args),
  sendPasswordChangeCodeEmail: (...args: unknown[]) => mockSendPasswordChangeCodeEmail(...args),
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
const mockRpc = vi.fn();

function resetChainMocks() {
  mockRpc.mockResolvedValue({ data: [{ allowed: true, retry_after_ms: 0, current_count: 1 }], error: null });
  mockSingle.mockResolvedValue({ data: null, error: null });
  mockOrder.mockReturnValue({ data: [], error: null });
  mockEq.mockReturnValue({ eq: mockEq, single: mockSingle, select: mockSelect, order: mockOrder, delete: mockDelete });
  mockDelete.mockReturnValue({ eq: mockEq, single: mockSingle, error: null });
  mockUpdate.mockReturnValue({ eq: mockEq, single: mockSingle, error: null });
  mockSelect.mockReturnValue({ eq: mockEq, single: mockSingle, order: mockOrder });
  mockInsert.mockReturnValue({ select: mockSelect, single: mockSingle, error: null });
  mockFrom.mockReturnValue({
    select: mockSelect,
    insert: mockInsert,
    update: mockUpdate,
    delete: mockDelete,
    eq: mockEq,
    single: mockSingle,
    order: mockOrder,
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
  getProfileAction,
  updateProfileAction,
  requestPasswordChangeCodeAction,
  confirmPasswordChangeAction,
  adminChangePasswordAction,
} from '@/actions/profile';

const testUser = { id: 'user-123', username: 'testuser', role: 'user' as const, tokenVersion: 7 };
const adminUser = { id: 'admin-123', username: 'adminuser', role: 'admin' as const, tokenVersion: 3 };

describe('Profile Server Actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChainMocks();
    mockRequireAuth.mockResolvedValue({ success: true, user: testUser });
    mockRequireAdmin.mockResolvedValue({ success: true, user: adminUser });
    mockRequireCSRF.mockResolvedValue({ valid: true });
    mockHashPassword.mockResolvedValue('$2b$12$newhashedpassword');
    mockVerifyPassword.mockResolvedValue(true);
    mockGenerateSixDigitCode.mockReturnValue('123456');
    mockSendPasswordChangeCodeEmail.mockResolvedValue(true);
    mockGetQuickSession.mockResolvedValue(testUser);
  });

  // ---------------------------------------------------------------------------
  // getProfileAction
  // ---------------------------------------------------------------------------

  describe('getProfileAction', () => {
    it('should return profile data for authenticated user', async () => {
      const profileData = {
        id: 'user-123',
        username: 'testuser',
        full_name: 'Test User',
        email: 'test@example.com',
        email_verified: true,
      };
      mockSingle.mockResolvedValueOnce({ data: profileData, error: null });

      const result = await getProfileAction();

      expect(result.data).toEqual(profileData);
      expect(result.error).toBeUndefined();
      expect(mockFrom).toHaveBeenCalledWith('users');
    });

    it('should return error when not authenticated', async () => {
      mockRequireAuth.mockResolvedValue({ success: false, error: 'Not authenticated' });

      const result = await getProfileAction();

      expect(result.error).toBe('Not authenticated');
      expect(result.data).toBeUndefined();
    });

    it('should return error when user not found in DB', async () => {
      mockSingle.mockResolvedValueOnce({ data: null, error: { message: 'not found' } });

      const result = await getProfileAction();

      expect(result.error).toBe('Failed to load profile');
    });
  });

  // ---------------------------------------------------------------------------
  // updateProfileAction
  // ---------------------------------------------------------------------------

  describe('updateProfileAction', () => {
    it('should update full_name successfully', async () => {
      const result = await updateProfileAction({ full_name: 'New Name' }, 'csrf-token');

      expect(result.success).toBe(true);
      expect(mockUpdate).toHaveBeenCalledWith({ full_name: 'New Name' });
      expect(mockLogAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({ userId: testUser.id, action: 'user_updated' })
      );
    });

    it('should update username and refresh session with tokenVersion (CP-C-1)', async () => {
      // Username uniqueness check — not found
      mockSingle.mockResolvedValueOnce({ data: null, error: { code: 'PGRST116' } });

      const result = await updateProfileAction({ username: 'newusername' }, 'csrf-token');

      expect(result.success).toBe(true);
      // CP-C-1: tokenVersion MUST be passed through so the new JWT carries the
      // correct `tv` claim. Without it, the next middleware hop sees JWT.tv=0
      // and DB.tv>0, treating the session as revoked and logging the user out.
      expect(mockCreateSession).toHaveBeenCalledWith({
        id: testUser.id,
        username: 'newusername',
        role: testUser.role,
        tokenVersion: testUser.tokenVersion,
      });
    });

    it('should return error for duplicate username', async () => {
      // Username uniqueness check — found existing
      mockSingle.mockResolvedValueOnce({ data: { id: 'other-user' }, error: null });

      const result = await updateProfileAction({ username: 'takenname' }, 'csrf-token');

      expect(result.error).toBe('Username is already taken');
    });

    it('should return error when not authenticated', async () => {
      mockRequireAuth.mockResolvedValue({ success: false, error: 'Not authenticated' });

      const result = await updateProfileAction({ full_name: 'New' }, 'csrf-token');

      expect(result.error).toBe('Not authenticated');
    });

    it('should return error for invalid CSRF token', async () => {
      mockRequireCSRF.mockResolvedValue({ valid: false, error: 'CSRF token invalid' });

      const result = await updateProfileAction({ full_name: 'New' }, 'bad-token');

      expect(result.error).toBe('CSRF token invalid');
    });

    it('should return error when no changes provided', async () => {
      const result = await updateProfileAction({}, 'csrf-token');

      expect(result.error).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // requestPasswordChangeCodeAction
  // ---------------------------------------------------------------------------

  describe('requestPasswordChangeCodeAction', () => {
    it('should send code for user with verified email', async () => {
      mockSingle.mockResolvedValueOnce({
        data: { email: 'test@example.com', email_verified: true },
        error: null,
      });

      const result = await requestPasswordChangeCodeAction('csrf-token');

      expect(result.success).toBe(true);
      expect(mockGenerateSixDigitCode).toHaveBeenCalled();
      expect(mockSendPasswordChangeCodeEmail).toHaveBeenCalledWith('test@example.com', '123456');
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ reset_code: '123456' })
      );
    });

    it('should return error when user has no email', async () => {
      mockSingle.mockResolvedValueOnce({
        data: { email: null, email_verified: false },
        error: null,
      });

      const result = await requestPasswordChangeCodeAction('csrf-token');

      expect(result.error).toBe('No email associated with your account');
      expect(mockSendPasswordChangeCodeEmail).not.toHaveBeenCalled();
    });

    it('should return error when email is not verified', async () => {
      mockSingle.mockResolvedValueOnce({
        data: { email: 'test@example.com', email_verified: false },
        error: null,
      });

      const result = await requestPasswordChangeCodeAction('csrf-token');

      expect(result.error).toBe('Your email is not verified');
    });

    it('should return error when not authenticated', async () => {
      mockRequireAuth.mockResolvedValue({ success: false, error: 'Not authenticated' });

      const result = await requestPasswordChangeCodeAction('csrf-token');

      expect(result.error).toBe('Not authenticated');
    });
  });

  // ---------------------------------------------------------------------------
  // confirmPasswordChangeAction
  // ---------------------------------------------------------------------------

  describe('confirmPasswordChangeAction', () => {
    it('should change password successfully', async () => {
      const futureDate = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      mockSingle.mockResolvedValueOnce({
        data: { reset_code: '123456', reset_code_expires_at: futureDate },
        error: null,
      });

      const result = await confirmPasswordChangeAction('123456', 'NewPassword1!', 'csrf-token');

      expect(result.success).toBe(true);
      expect(mockHashPassword).toHaveBeenCalledWith('NewPassword1!');
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          password_hash: '$2b$12$newhashedpassword',
          reset_code: null,
          reset_code_expires_at: null,
        })
      );
      expect(mockLogAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({ userId: testUser.id, action: 'password_changed' })
      );
    });

    it('should return error for invalid code format', async () => {
      const result = await confirmPasswordChangeAction('abc', 'NewPassword1!', 'csrf-token');

      expect(result.error).toBe('Invalid code format');
    });

    it('should return error for wrong code', async () => {
      const futureDate = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      mockSingle.mockResolvedValueOnce({
        data: { reset_code: '654321', reset_code_expires_at: futureDate },
        error: null,
      });

      const result = await confirmPasswordChangeAction('123456', 'NewPassword1!', 'csrf-token');

      expect(result.error).toBe('Invalid code');
    });

    it('should return error for expired code', async () => {
      const pastDate = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      mockSingle.mockResolvedValueOnce({
        data: { reset_code: '123456', reset_code_expires_at: pastDate },
        error: null,
      });

      const result = await confirmPasswordChangeAction('123456', 'NewPassword1!', 'csrf-token');

      expect(result.error).toBe('Code has expired. Please request a new one.');
    });

    it('should return error for weak password', async () => {
      const result = await confirmPasswordChangeAction('123456', 'weak', 'csrf-token');

      expect(result.error).toBeDefined();
      expect(result.success).toBeUndefined();
    });

    it('should return error when not authenticated', async () => {
      mockRequireAuth.mockResolvedValue({ success: false, error: 'Not authenticated' });

      const result = await confirmPasswordChangeAction('123456', 'NewPassword1!', 'csrf-token');

      expect(result.error).toBe('Not authenticated');
    });
  });

  // ---------------------------------------------------------------------------
  // adminChangePasswordAction
  // ---------------------------------------------------------------------------

  describe('adminChangePasswordAction', () => {
    it('should change admin password successfully', async () => {
      mockSingle.mockResolvedValueOnce({
        data: { password_hash: '$2b$12$oldhash' },
        error: null,
      });

      const result = await adminChangePasswordAction('OldPassword1!', 'NewPassword1!', 'csrf-token');

      expect(result.success).toBe(true);
      expect(mockVerifyPassword).toHaveBeenCalledWith('OldPassword1!', '$2b$12$oldhash');
      expect(mockHashPassword).toHaveBeenCalledWith('NewPassword1!');
      expect(mockLogAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({ userId: adminUser.id, action: 'password_changed', metadata: { method: 'admin_direct' } })
      );
    });

    it('should return error for wrong current password', async () => {
      mockSingle.mockResolvedValueOnce({
        data: { password_hash: '$2b$12$oldhash' },
        error: null,
      });
      mockVerifyPassword.mockResolvedValueOnce(false);

      const result = await adminChangePasswordAction('WrongPassword1!', 'NewPassword1!', 'csrf-token');

      expect(result.error).toBe('Current password is incorrect');
    });

    it('should return error for weak new password', async () => {
      const result = await adminChangePasswordAction('OldPassword1!', 'weak', 'csrf-token');

      expect(result.error).toBeDefined();
      expect(result.success).toBeUndefined();
    });

    it('should return error when not admin', async () => {
      mockRequireAdmin.mockResolvedValue({ success: false, error: 'Admin access required' });

      const result = await adminChangePasswordAction('OldPassword1!', 'NewPassword1!', 'csrf-token');

      expect(result.error).toBe('Admin access required');
    });

    it('should return error for invalid CSRF token', async () => {
      mockRequireCSRF.mockResolvedValue({ valid: false, error: 'CSRF token invalid' });

      const result = await adminChangePasswordAction('OldPassword1!', 'NewPassword1!', 'bad-token');

      expect(result.error).toBe('CSRF token invalid');
    });

    it('should return error when user not found', async () => {
      mockSingle.mockResolvedValueOnce({ data: null, error: null });

      const result = await adminChangePasswordAction('OldPassword1!', 'NewPassword1!', 'csrf-token');

      expect(result.error).toBe('User not found');
    });
  });
});
