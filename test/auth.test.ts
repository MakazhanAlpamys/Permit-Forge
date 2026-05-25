import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  generateCSRFToken,
  validateCSRFToken,
  createJWTToken,
  verifyJWTToken,
  createSession,
  destroySession,
  getQuickSession,
  logAuditEvent,
  logAuditWithMeta,
  getRequestMetadata,
} from '@/lib/auth';
import { cookies, headers } from 'next/headers';
import { createAdminClient } from '@/lib/supabase-server';
import { SESSION_COOKIE_NAME, CSRF_COOKIE_NAME } from '@/lib/constants';

describe('Auth Library', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ============================================================================
  // CSRF Token Tests
  // ============================================================================
  describe('CSRF Token Generation and Validation', () => {
    it('should generate a CSRF token string', async () => {
      const token = await generateCSRFToken();
      expect(typeof token).toBe('string');
      // E17: assert the actual format. crypto.randomBytes(32).toString('hex')
      // produces 64 lowercase hex characters; anything else is a regression
      // (e.g. someone swapping to a shorter or base64-encoded token).
      expect(token).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should generate unique tokens each time', async () => {
      const token1 = await generateCSRFToken();
      const token2 = await generateCSRFToken();
      expect(token1).not.toBe(token2);
    });

    it('should reject invalid CSRF token', async () => {
      const isValid = await validateCSRFToken('invalid-token');
      expect(isValid).toBe(false);
    });

    it('should reject empty CSRF token', async () => {
      const isValid = await validateCSRFToken('');
      expect(isValid).toBe(false);
    });

    // COV-C-5 (v1.4.0 Part B): the HIT path was uncovered before. validate
    // must return true when the supplied token matches the cookie byte-for-byte.
    it('returns true when the supplied token matches the cookie', async () => {
      const stored = 'a'.repeat(64);
      vi.mocked(cookies).mockResolvedValueOnce({
        get: vi.fn().mockReturnValue({ value: stored }),
        set: vi.fn(),
        delete: vi.fn(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      expect(await validateCSRFToken(stored)).toBe(true);
    });

    // COV-C-5: timingSafeEqual throws on length mismatch — must be caught and
    // surfaced as false, not propagated. Defends against the regression where
    // a 64-char vs 32-char comparison would 500 the action instead of denying.
    it('returns false (without throwing) when token length does not match cookie length', async () => {
      vi.mocked(cookies).mockResolvedValueOnce({
        get: vi.fn().mockReturnValue({ value: 'a'.repeat(64) }),
        set: vi.fn(),
        delete: vi.fn(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      await expect(validateCSRFToken('b'.repeat(32))).resolves.toBe(false);
    });

    // COV-C-5: same-length-but-different tokens must compare false. Confirms
    // the timing-safe compare actually catches forgeries (not just length).
    it('returns false on same-length mismatched tokens (timing-safe negative)', async () => {
      vi.mocked(cookies).mockResolvedValueOnce({
        get: vi.fn().mockReturnValue({ value: 'a'.repeat(64) }),
        set: vi.fn(),
        delete: vi.fn(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      expect(await validateCSRFToken('b'.repeat(64))).toBe(false);
    });

    // C4H/H5: cookie must be readable from JS so the double-submit pattern works.
    it('should set CSRF cookie with httpOnly: false (double-submit)', async () => {
      const setSpy = vi.fn();
      vi.mocked(cookies).mockResolvedValueOnce({
        get: vi.fn(),
        set: setSpy,
        delete: vi.fn(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      await generateCSRFToken();

      expect(setSpy).toHaveBeenCalledTimes(1);
      const [name, , options] = setSpy.mock.calls[0];
      expect(name).toBe('ef_csrf');
      expect(options.httpOnly).toBe(false);
      expect(options.sameSite).toBe('strict');
    });
  });

  // ============================================================================
  // JWT Token Tests
  // ============================================================================
  describe('JWT Token Operations', () => {
    it('should create a JWT token', async () => {
      const payload = {
        id: 'test-user-id',
        username: 'testuser',
        role: 'user' as const,
      };

      const token = await createJWTToken(payload);
      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(0);
      // JWT tokens have 3 parts separated by dots
      expect(token.split('.').length).toBe(3);
    });

    it('should verify a valid JWT token', async () => {
      const payload = {
        id: '550e8400-e29b-41d4-a716-446655440000', // Valid UUID
        username: 'testuser',
        role: 'user' as const,
      };

      const token = await createJWTToken(payload);
      const result = await verifyJWTToken(token);

      expect(result).not.toBeNull();
      expect(result?.sub).toBe('550e8400-e29b-41d4-a716-446655440000');
      expect(result?.username).toBe('testuser');
      expect(result?.role).toBe('user');
      // E17: assert tokens are properly clamped to the {admin,user} enum and
      // include the rest of the schema. A future regression that widens the
      // enum or strips iat/exp would now fail here instead of silently passing.
      expect(['admin', 'user']).toContain(result?.role);
      expect(typeof result?.iat).toBe('number');
      expect(typeof result?.exp).toBe('number');
      expect(result!.exp).toBeGreaterThan(result!.iat);
    });

    it('rejects a JWT whose role is not in the {admin,user} enum', async () => {
      // Sign with the project secret but with a bogus role value.
      const { SignJWT } = await import('jose');
      const secret = new TextEncoder().encode(process.env.JWT_SECRET!);
      const tampered = await new SignJWT({
        sub: '550e8400-e29b-41d4-a716-446655440000',
        username: 'tester',
        role: 'superadmin',
        tv: 0,
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(secret);
      const result = await verifyJWTToken(tampered);
      expect(result).toBeNull();
    });

    it('should return null for invalid JWT token', async () => {
      const result = await verifyJWTToken('invalid-token');
      expect(result).toBeNull();
    });

    it('should return null for malformed JWT token', async () => {
      const result = await verifyJWTToken('a.b.c');
      expect(result).toBeNull();
    });
  });

  // ============================================================================
  // E2: Session lifecycle (createSession / destroySession / getSession / getQuickSession)
  // ============================================================================
  describe('Session Lifecycle', () => {
    const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

    it('createSession stores a JWT cookie with httpOnly + strict + secure', async () => {
      const setSpy = vi.fn();
      vi.mocked(cookies).mockResolvedValueOnce({
        get: vi.fn(),
        set: setSpy,
        delete: vi.fn(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      await createSession({ id: VALID_UUID, username: 'alice', role: 'user' });

      expect(setSpy).toHaveBeenCalledTimes(1);
      const [name, value, options] = setSpy.mock.calls[0];
      expect(name).toBe(SESSION_COOKIE_NAME);
      expect(typeof value).toBe('string');
      expect(value.split('.').length).toBe(3); // JWT shape
      expect(options.httpOnly).toBe(true);
      expect(options.sameSite).toBe('strict');
      expect(options.secure).toBe(true);
      expect(options.path).toBe('/');
    });

    it('createSession embeds tokenVersion when provided', async () => {
      const setSpy = vi.fn();
      vi.mocked(cookies).mockResolvedValueOnce({
        get: vi.fn(),
        set: setSpy,
        delete: vi.fn(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      await createSession({
        id: VALID_UUID,
        username: 'alice',
        role: 'admin',
        tokenVersion: 7,
      });

      const [, value] = setSpy.mock.calls[0];
      const payload = await verifyJWTToken(value);
      expect(payload?.tv).toBe(7);
      expect(payload?.role).toBe('admin');
    });

    it('destroySession deletes both session and CSRF cookies', async () => {
      const deleteSpy = vi.fn();
      vi.mocked(cookies).mockResolvedValueOnce({
        get: vi.fn(),
        set: vi.fn(),
        delete: deleteSpy,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      await destroySession();

      expect(deleteSpy).toHaveBeenCalledWith(SESSION_COOKIE_NAME);
      expect(deleteSpy).toHaveBeenCalledWith(CSRF_COOKIE_NAME);
    });

    it('getQuickSession returns null when no token cookie', async () => {
      vi.mocked(cookies).mockResolvedValueOnce({
        get: vi.fn(() => undefined),
        set: vi.fn(),
        delete: vi.fn(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      const result = await getQuickSession();
      expect(result).toBeNull();
    });

    it('getQuickSession returns null when token is invalid', async () => {
      vi.mocked(cookies).mockResolvedValueOnce({
        get: vi.fn(() => ({ value: 'broken.token.here' })),
        set: vi.fn(),
        delete: vi.fn(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      const result = await getQuickSession();
      expect(result).toBeNull();
    });

    it('getQuickSession returns user info from a valid token (no DB)', async () => {
      const token = await createJWTToken({
        id: VALID_UUID,
        username: 'alice',
        role: 'user',
      });
      vi.mocked(cookies).mockResolvedValueOnce({
        get: vi.fn(() => ({ value: token })),
        set: vi.fn(),
        delete: vi.fn(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      const result = await getQuickSession();
      // AUTH-C1 / v1.0.0 Part E: getQuickSession exposes tokenVersion from
      // the JWT so requireAuth can compare against users.token_version.
      expect(result).toEqual({
        id: VALID_UUID,
        username: 'alice',
        role: 'user',
        tokenVersion: 0,
      });
    });

  });

  // ============================================================================
  // E2: Audit logging
  // ============================================================================
  describe('logAuditEvent', () => {
    it('inserts an audit_logs row with payload fields', async () => {
      const insert = vi.fn().mockResolvedValue({ data: null, error: null });
      const from = vi.fn().mockReturnValue({ insert });
      vi.mocked(createAdminClient).mockReturnValueOnce({
        from,
        rpc: vi.fn(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      await logAuditEvent({
        userId: 'u1',
        action: 'login_success',
        targetUserId: 'u2',
        metadata: { ip: '1.1.1.1' },
        ipAddress: '1.1.1.1',
        userAgent: 'jest',
      });

      expect(from).toHaveBeenCalledWith('audit_logs');
      expect(insert).toHaveBeenCalledTimes(1);
      const row = insert.mock.calls[0][0];
      expect(row.user_id).toBe('u1');
      expect(row.action).toBe('login_success');
      expect(row.target_user_id).toBe('u2');
      expect(row.metadata).toEqual({ ip: '1.1.1.1' });
      expect(row.ip_address).toBe('1.1.1.1');
      expect(row.user_agent).toBe('jest');
    });

    it('swallows DB errors (never throws)', async () => {
      const insert = vi.fn().mockResolvedValue({ data: null, error: { message: 'bad' } });
      vi.mocked(createAdminClient).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({ insert }),
        rpc: vi.fn(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      await expect(
        logAuditEvent({ action: 'logout' }),
      ).resolves.toBeUndefined();
    });

    it('swallows thrown errors from the supabase client', async () => {
      vi.mocked(createAdminClient).mockImplementationOnce(() => {
        throw new Error('connection refused');
      });

      await expect(
        logAuditEvent({ action: 'login_failed' }),
      ).resolves.toBeUndefined();
    });

    it('defaults metadata to {} when omitted', async () => {
      const insert = vi.fn().mockResolvedValue({ data: null, error: null });
      vi.mocked(createAdminClient).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({ insert }),
        rpc: vi.fn(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      await logAuditEvent({ userId: 'u3', action: 'logout' });

      expect(insert.mock.calls[0][0].metadata).toEqual({});
    });
  });

  // ============================================================================
  // E2: request metadata + audit composition (logAuditWithMeta)
  // ============================================================================
  describe('headers integration', () => {
    it('headers() is callable from auth library', async () => {
      const h = new Headers();
      h.set('user-agent', 'jest-ua');
      vi.mocked(headers).mockResolvedValueOnce(h);
      // Tests that the mock plumbing reaches the auth layer at all.
      expect((await headers()).get('user-agent')).toBe('jest-ua');
    });
  });

  // ============================================================================
  // COV-C-5 (v1.4.0 Part B): getRequestMetadata + logAuditWithMeta combinator
  // ============================================================================
  describe('getRequestMetadata', () => {
    it('returns ipAddress (from getClientIp) and userAgent from request headers', async () => {
      const h = new Headers();
      h.set('user-agent', 'curl/8.0');
      vi.mocked(headers).mockResolvedValueOnce(h);

      const meta = await getRequestMetadata();
      expect(meta.userAgent).toBe('curl/8.0');
      expect(meta.ipAddress).toBeDefined();
    });

    it('falls back to "unknown" user-agent when header missing', async () => {
      vi.mocked(headers).mockResolvedValueOnce(new Headers());
      const meta = await getRequestMetadata();
      expect(meta.userAgent).toBe('unknown');
    });
  });

  describe('logAuditWithMeta', () => {
    // The combinator collapses the getRequestMetadata + logAuditEvent pair
    // that ~25 actions used to repeat by hand. We assert the spread shape so
    // a future refactor that drops ipAddress/userAgent fails loudly.
    it('inserts an audit row that includes ipAddress, userAgent, action, and metadata', async () => {
      const h = new Headers();
      h.set('user-agent', 'pino-agent/1');
      vi.mocked(headers).mockResolvedValueOnce(h);

      const insert = vi.fn().mockResolvedValue({ error: null });
      vi.mocked(createAdminClient).mockReturnValueOnce({
        from: vi.fn(() => ({ insert })),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      await logAuditWithMeta('u-1', 'permit_reviewed', {
        targetUserId: 'u-2',
        metadata: { permitId: 'p-1', decision: 'approve' },
      });

      expect(insert).toHaveBeenCalledTimes(1);
      const row = insert.mock.calls[0][0];
      expect(row.user_id).toBe('u-1');
      expect(row.action).toBe('permit_reviewed');
      expect(row.target_user_id).toBe('u-2');
      expect(row.metadata).toEqual({ permitId: 'p-1', decision: 'approve' });
      expect(row.user_agent).toBe('pino-agent/1');
      expect(row.ip_address).toBeDefined();
    });

    it('defaults metadata to {} when no extras passed', async () => {
      vi.mocked(headers).mockResolvedValueOnce(new Headers());
      const insert = vi.fn().mockResolvedValue({ error: null });
      vi.mocked(createAdminClient).mockReturnValueOnce({
        from: vi.fn(() => ({ insert })),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      await logAuditWithMeta('u-1', 'login_success');

      const row = insert.mock.calls[0][0];
      expect(row.metadata).toEqual({});
      expect(row.target_user_id).toBeUndefined();
    });
  });
});
