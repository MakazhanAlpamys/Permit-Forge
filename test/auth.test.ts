import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateCSRFToken, validateCSRFToken, createJWTToken, verifyJWTToken } from '@/lib/auth';
import { cookies } from 'next/headers';

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
      expect(token.length).toBeGreaterThan(0);
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
});
