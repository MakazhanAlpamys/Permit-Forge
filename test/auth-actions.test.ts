// ============================================================================
// Auth Server Actions Tests
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock auth
const mockVerifyPassword = vi.fn();
const mockHashPassword = vi.fn();
const mockCreateSession = vi.fn();
const mockDestroySession = vi.fn();
const mockGenerateCSRFToken = vi.fn();
const mockLogAuditEvent = vi.fn().mockResolvedValue(undefined);
const mockGetRequestMetadata = vi.fn().mockResolvedValue({ ipAddress: '127.0.0.1', userAgent: 'test' });
const mockGetQuickSession = vi.fn();
const mockGetCSRFToken = vi.fn();
vi.mock('@/lib/auth', () => ({
  verifyPassword: (...args: unknown[]) => mockVerifyPassword(...args),
  hashPassword: (...args: unknown[]) => mockHashPassword(...args),
  createSession: (...args: unknown[]) => mockCreateSession(...args),
  destroySession: (...args: unknown[]) => mockDestroySession(...args),
  generateCSRFToken: (...args: unknown[]) => mockGenerateCSRFToken(...args),
  logAuditEvent: (...args: unknown[]) => mockLogAuditEvent(...args),
  getRequestMetadata: (...args: unknown[]) => mockGetRequestMetadata(...args),
  getQuickSession: (...args: unknown[]) => mockGetQuickSession(...args),
  getCSRFToken: (...args: unknown[]) => mockGetCSRFToken(...args),
}));

// Mock email
const mockGenerateSixDigitCode = vi.fn();
const mockSendVerificationEmail = vi.fn();
const mockSendPasswordResetEmail = vi.fn();
vi.mock('@/lib/email', () => ({
  generateSixDigitCode: (...args: unknown[]) => mockGenerateSixDigitCode(...args),
  sendVerificationEmail: (...args: unknown[]) => mockSendVerificationEmail(...args),
  sendPasswordResetEmail: (...args: unknown[]) => mockSendPasswordResetEmail(...args),
}));

// Mock next/navigation — redirect throws to halt execution (like real Next.js)
class RedirectError extends Error {
  url: string;
  constructor(url: string) {
    super(`NEXT_REDIRECT:${url}`);
    this.url = url;
  }
}
const mockRedirect = vi.fn().mockImplementation((url: string) => {
  throw new RedirectError(url);
});
vi.mock('next/navigation', () => ({
  redirect: (...args: unknown[]) => mockRedirect(...args),
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

function resetChainMocks() {
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

// Mock supabase RPC at module scope so we can assert on bump_user_token_version
const mockServerRpc = vi.fn().mockResolvedValue({ data: [{ allowed: true }], error: null });
const mockAdminRpc = vi.fn().mockResolvedValue({ data: [{ allowed: true }], error: null });

vi.mock('@/lib/supabase-server', () => ({
  createServerClient: vi.fn(() => ({
    from: (...args: unknown[]) => mockFrom(...args),
    rpc: (...args: unknown[]) => mockServerRpc(...args),
  })),
  createAdminClient: vi.fn(() => ({
    from: (...args: unknown[]) => mockFrom(...args),
    rpc: (...args: unknown[]) => mockAdminRpc(...args),
  })),
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
}));

// Mock security (logoutAction uses requireCSRF)
const mockRequireCSRF = vi.fn().mockResolvedValue({ valid: true });
vi.mock('@/lib/security', () => ({
  requireCSRF: (...args: unknown[]) => mockRequireCSRF(...args),
}));

import {
  loginAction,
  logoutAction,
  registerAction,
  verifyEmailAction,
  forgotPasswordAction,
  resetPasswordAction,
} from '@/actions/auth';

// Helper to create FormData
function makeFormData(data: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(data)) {
    fd.set(key, value);
  }
  return fd;
}

const validUser = {
  id: 'user-123',
  username: 'testuser',
  password_hash: '$2b$12$hashedpassword',
  role: 'user',
  blocked: false,
  email: 'test@example.com',
  email_verified: true,
};

describe('Auth Server Actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChainMocks();
    mockVerifyPassword.mockResolvedValue(true);
    mockHashPassword.mockResolvedValue('$2b$12$newhashedpassword');
    mockCreateSession.mockResolvedValue(undefined);
    mockDestroySession.mockResolvedValue(undefined);
    mockGenerateCSRFToken.mockResolvedValue('csrf-token-123');
    mockGenerateSixDigitCode.mockReturnValue('123456');
    mockSendVerificationEmail.mockResolvedValue(true);
    mockSendPasswordResetEmail.mockResolvedValue(true);
    mockGetQuickSession.mockResolvedValue({ id: 'user-123', username: 'testuser', role: 'user' });
    mockGetCSRFToken.mockResolvedValue('csrf-token-123');
    mockServerRpc.mockResolvedValue({ data: [{ allowed: true }], error: null });
    mockAdminRpc.mockResolvedValue({ data: [{ allowed: true }], error: null });
    mockRequireCSRF.mockResolvedValue({ valid: true });
  });

  // ---------------------------------------------------------------------------
  // loginAction
  // ---------------------------------------------------------------------------

  describe('loginAction', () => {
    beforeEach(() => {
      // Use unique IP per test group to avoid cross-test rate limiting
      mockGetRequestMetadata.mockResolvedValue({ ipAddress: '10.0.0.1', userAgent: 'test' });
    });

    it('should redirect on successful login', async () => {
      mockSingle.mockResolvedValueOnce({ data: validUser, error: null });

      const formData = makeFormData({ username: 'testuser', password: 'Password1!' });

      await expect(loginAction(formData)).rejects.toThrow('NEXT_REDIRECT:/');

      expect(mockVerifyPassword).toHaveBeenCalledWith('Password1!', validUser.password_hash);
      expect(mockCreateSession).toHaveBeenCalledWith({
        id: validUser.id,
        username: validUser.username,
        role: 'user',
        tokenVersion: 0,
      });
      expect(mockGenerateCSRFToken).toHaveBeenCalled();
      expect(mockLogAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({ userId: validUser.id, action: 'login_success' })
      );
    });

    it('should return error for wrong password', async () => {
      mockSingle.mockResolvedValueOnce({ data: validUser, error: null });
      mockVerifyPassword.mockResolvedValueOnce(false);

      const formData = makeFormData({ username: 'testuser', password: 'WrongPass1!' });
      const result = await loginAction(formData);

      expect(result.error).toBe('Invalid username or password');
      expect(mockCreateSession).not.toHaveBeenCalled();
    });

    it('should return error when user not found', async () => {
      mockSingle.mockResolvedValueOnce({ data: null, error: { message: 'not found' } });

      const formData = makeFormData({ username: 'nonexistent', password: 'Password1!' });
      const result = await loginAction(formData);

      expect(result.error).toBe('Invalid username or password');
    });

    it('should return error for blocked user', async () => {
      mockSingle.mockResolvedValueOnce({
        data: { ...validUser, blocked: true },
        error: null,
      });

      const formData = makeFormData({ username: 'testuser', password: 'Password1!' });
      const result = await loginAction(formData);

      expect(result.error).toBe('Your account has been blocked. Please contact an administrator.');
      expect(mockVerifyPassword).not.toHaveBeenCalled();
    });

    it('should return error for unverified email', async () => {
      mockSingle.mockResolvedValueOnce({
        data: { ...validUser, email_verified: false },
        error: null,
      });

      const formData = makeFormData({ username: 'testuser', password: 'Password1!' });
      const result = await loginAction(formData);

      expect(result.error).toBe('Please verify your email before signing in.');
    });

    it('should allow admin-created user without email to log in', async () => {
      mockSingle.mockResolvedValueOnce({
        data: { ...validUser, email: null, email_verified: false },
        error: null,
      });

      const formData = makeFormData({ username: 'testuser', password: 'Password1!' });

      await expect(loginAction(formData)).rejects.toThrow('NEXT_REDIRECT:/');

      expect(mockCreateSession).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // logoutAction
  // ---------------------------------------------------------------------------

  describe('logoutAction', () => {
    function csrfFormData(token?: string | null): FormData {
      const fd = new FormData();
      if (token !== null && token !== undefined) fd.set('csrfToken', token);
      return fd;
    }

    it('bumps token_version before destroying session (v1.1 Part B / S-M)', async () => {
      // CSRF passes, valid session
      const fd = csrfFormData('csrf-token-123');

      await expect(logoutAction(fd)).rejects.toThrow('NEXT_REDIRECT:/login');

      // bump_user_token_version called with the current user id
      expect(mockAdminRpc).toHaveBeenCalledWith('bump_user_token_version', {
        p_user_id: 'user-123',
      });
      // And session was destroyed
      expect(mockDestroySession).toHaveBeenCalled();
      // Audit logged
      expect(mockLogAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-123', action: 'logout' })
      );
    });

    it('still destroys session and redirects if token_version bump fails', async () => {
      // Simulate RPC failure
      mockAdminRpc.mockResolvedValueOnce({ data: null, error: { message: 'rpc down' } });
      const fd = csrfFormData('csrf-token-123');

      await expect(logoutAction(fd)).rejects.toThrow('NEXT_REDIRECT:/login');

      // Session destroyed even though RPC failed
      expect(mockDestroySession).toHaveBeenCalled();
    });

    it('skips RPC bump when there is no session', async () => {
      mockGetQuickSession.mockResolvedValueOnce(null);
      const fd = csrfFormData('csrf-token-123');

      await expect(logoutAction(fd)).rejects.toThrow('NEXT_REDIRECT:/login');

      // No bump for anonymous logout
      expect(mockAdminRpc).not.toHaveBeenCalledWith(
        'bump_user_token_version',
        expect.anything(),
      );
      expect(mockDestroySession).toHaveBeenCalled();
    });

    it('still proceeds with logout when CSRF is missing/invalid', async () => {
      // C20H: a CSRF failure should not block destroying the session
      mockRequireCSRF.mockResolvedValueOnce({ valid: false, error: 'CSRF token missing' });
      const fd = csrfFormData(null);

      await expect(logoutAction(fd)).rejects.toThrow('NEXT_REDIRECT:/login');

      expect(mockDestroySession).toHaveBeenCalled();
      // But on a CSRF-invalid logout we still bump tv so a CSRF-bypass-induced
      // logout still invalidates other sessions on principle.
      expect(mockAdminRpc).toHaveBeenCalledWith('bump_user_token_version', {
        p_user_id: 'user-123',
      });
    });
  });

  // ---------------------------------------------------------------------------
  // registerAction
  // ---------------------------------------------------------------------------

  describe('registerAction', () => {
    beforeEach(() => {
      mockGetRequestMetadata.mockResolvedValue({ ipAddress: '10.0.0.2', userAgent: 'test' });
    });

    it('should register successfully with valid data', async () => {
      // First .single() for username check — not found
      mockSingle
        .mockResolvedValueOnce({ data: null, error: { code: 'PGRST116' } })
        // Second .single() for email check — not found
        .mockResolvedValueOnce({ data: null, error: { code: 'PGRST116' } });
      // Insert returns no error
      mockInsert.mockReturnValueOnce({ error: null });

      const formData = makeFormData({
        username: 'newuser',
        email: 'new@example.com',
        password: 'StrongPass1!',
      });

      const result = await registerAction(formData);

      expect(result.success).toBe(true);
      expect(mockHashPassword).toHaveBeenCalledWith('StrongPass1!');
      expect(mockGenerateSixDigitCode).toHaveBeenCalled();
      expect(mockSendVerificationEmail).toHaveBeenCalledWith('new@example.com', '123456');
      // E17: the DB insert payload must mark the user as unverified and
      // record the generated 6-digit code. A regression that defaulted
      // email_verified=true would skip the verification step entirely.
      expect(mockInsert).toHaveBeenCalledTimes(1);
      const insertedRow = mockInsert.mock.calls[0][0];
      expect(insertedRow.email_verified).toBe(false);
      expect(insertedRow.verification_code).toBe('123456');
      expect(insertedRow.email).toBe('new@example.com');
      expect(insertedRow.username).toBe('newuser');
    });

    it('should return error for duplicate username', async () => {
      mockSingle.mockResolvedValueOnce({ data: { id: 'existing-id' }, error: null });

      const formData = makeFormData({
        username: 'testuser',
        email: 'new@example.com',
        password: 'StrongPass1!',
      });

      const result = await registerAction(formData);

      expect(result.error).toBe('Username is already taken');
    });

    it('should return error for duplicate email', async () => {
      // Username check — not found
      mockSingle
        .mockResolvedValueOnce({ data: null, error: { code: 'PGRST116' } })
        // Email check — found
        .mockResolvedValueOnce({ data: { id: 'existing-id' }, error: null });

      const formData = makeFormData({
        username: 'newuser',
        email: 'existing@example.com',
        password: 'StrongPass1!',
      });

      const result = await registerAction(formData);

      expect(result.error).toBe('Email is already registered');
    });

    it('should return error for weak password', async () => {
      const formData = makeFormData({
        username: 'newuser',
        email: 'new@example.com',
        password: 'weak',
      });

      const result = await registerAction(formData);

      expect(result.error).toBeDefined();
      expect(result.success).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // verifyEmailAction
  // ---------------------------------------------------------------------------

  describe('verifyEmailAction', () => {
    it('should verify email successfully', async () => {
      const futureDate = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      mockSingle.mockResolvedValueOnce({
        data: {
          id: 'user-123',
          verification_code: '123456',
          code_expires_at: futureDate,
          email_verified: false,
        },
        error: null,
      });

      const result = await verifyEmailAction('test@example.com', '123456');

      expect(result.success).toBe(true);
      expect(mockFrom).toHaveBeenCalledWith('users');
      expect(mockUpdate).toHaveBeenCalledWith({
        email_verified: true,
        verification_code: null,
        code_expires_at: null,
      });
    });

    it('should return error for wrong code', async () => {
      const futureDate = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      mockSingle.mockResolvedValueOnce({
        data: {
          id: 'user-123',
          verification_code: '654321',
          code_expires_at: futureDate,
          email_verified: false,
        },
        error: null,
      });

      const result = await verifyEmailAction('test@example.com', '123456');

      expect(result.error).toBe('Invalid verification code');
    });

    it('should return error for expired code', async () => {
      const pastDate = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      mockSingle.mockResolvedValueOnce({
        data: {
          id: 'user-123',
          verification_code: '123456',
          code_expires_at: pastDate,
          email_verified: false,
        },
        error: null,
      });

      const result = await verifyEmailAction('test@example.com', '123456');

      expect(result.error).toBe('Verification code has expired. Please register again.');
    });

    it('should return error for already verified email', async () => {
      mockSingle.mockResolvedValueOnce({
        data: {
          id: 'user-123',
          verification_code: '123456',
          code_expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
          email_verified: true,
        },
        error: null,
      });

      const result = await verifyEmailAction('test@example.com', '123456');

      expect(result.error).toBe('Email is already verified');
    });
  });

  // ---------------------------------------------------------------------------
  // forgotPasswordAction
  // ---------------------------------------------------------------------------

  describe('forgotPasswordAction', () => {
    beforeEach(() => {
      mockGetRequestMetadata.mockResolvedValue({ ipAddress: '10.0.0.3', userAgent: 'test' });
    });

    it('should send reset code for valid user', async () => {
      mockSingle.mockResolvedValueOnce({
        data: {
          id: 'user-123',
          email: 'test@example.com',
          blocked: false,
          email_verified: true,
        },
        error: null,
      });

      const result = await forgotPasswordAction('test@example.com');

      expect(result.success).toBe(true);
      expect(mockSendPasswordResetEmail).toHaveBeenCalledWith('test@example.com', '123456');
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ reset_code: '123456' })
      );
    });

    it('should return success for nonexistent email (anti-enumeration)', async () => {
      mockSingle.mockResolvedValueOnce({ data: null, error: { code: 'PGRST116' } });

      const result = await forgotPasswordAction('nonexistent@example.com');

      expect(result.success).toBe(true);
      expect(mockSendPasswordResetEmail).not.toHaveBeenCalled();
    });

    it('should not send email to blocked user', async () => {
      mockSingle.mockResolvedValueOnce({
        data: {
          id: 'user-123',
          email: 'test@example.com',
          blocked: true,
          email_verified: true,
        },
        error: null,
      });

      const result = await forgotPasswordAction('test@example.com');

      expect(result.success).toBe(true);
      expect(mockSendPasswordResetEmail).not.toHaveBeenCalled();
    });

    it('should not send email to unverified user', async () => {
      mockSingle.mockResolvedValueOnce({
        data: {
          id: 'user-123',
          email: 'test@example.com',
          blocked: false,
          email_verified: false,
        },
        error: null,
      });

      const result = await forgotPasswordAction('test@example.com');

      expect(result.success).toBe(true);
      expect(mockSendPasswordResetEmail).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // resetPasswordAction
  // ---------------------------------------------------------------------------

  describe('resetPasswordAction', () => {
    it('should reset password successfully', async () => {
      const futureDate = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      mockSingle.mockResolvedValueOnce({
        data: {
          id: 'user-123',
          reset_code: '123456',
          reset_code_expires_at: futureDate,
        },
        error: null,
      });

      const result = await resetPasswordAction('test@example.com', '123456', 'NewPassword1!');

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
        expect.objectContaining({ userId: 'user-123', action: 'password_reset' })
      );
    });

    it('should return error for wrong reset code', async () => {
      const futureDate = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      mockSingle.mockResolvedValueOnce({
        data: {
          id: 'user-123',
          reset_code: '654321',
          reset_code_expires_at: futureDate,
        },
        error: null,
      });

      const result = await resetPasswordAction('test@example.com', '123456', 'NewPassword1!');

      expect(result.error).toBe('Invalid reset code');
    });

    it('should return error for expired reset code', async () => {
      const pastDate = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      mockSingle.mockResolvedValueOnce({
        data: {
          id: 'user-123',
          reset_code: '123456',
          reset_code_expires_at: pastDate,
        },
        error: null,
      });

      const result = await resetPasswordAction('test@example.com', '123456', 'NewPassword1!');

      expect(result.error).toBe('Reset code has expired. Please request a new one.');
    });
  });
});
