// ============================================================================
// F1 — withMutation helper coverage
// ============================================================================
// Sanity-check the auth + CSRF + schema + rate-limit gates and the catch-all
// error path. Each individual server-action's wiring is already covered by
// its own test file; this file pins the wrapper's contract.
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

// ----------------------------------------------------------------------------
// Mock the security helpers' collaborators so the wrapper is unit-tested
// in isolation (no real cookies / DB).
// ----------------------------------------------------------------------------

const mockGetQuickSession = vi.fn();
const mockValidateCSRF = vi.fn();
const mockLogAuditEvent = vi.fn();
const mockGetRequestMetadata = vi.fn().mockResolvedValue({ ipAddress: '127.0.0.1', userAgent: 't' });

vi.mock('@/lib/auth', () => ({
  getQuickSession: () => mockGetQuickSession(),
  validateCSRFToken: (t: string) => mockValidateCSRF(t),
  logAuditEvent: (...args: unknown[]) => mockLogAuditEvent(...args),
  getRequestMetadata: () => mockGetRequestMetadata(),
}));

const mockCheckRateLimit = vi.fn();
const mockUserBlockedQuery = vi.fn();

vi.mock('@/lib/supabase-server', () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          single: () => mockUserBlockedQuery(),
        }),
      }),
    }),
    rpc: vi.fn(),
  }),
  checkRateLimit: (userId: string, opts: { endpoint: string }) => mockCheckRateLimit(userId, opts),
}));

import { withMutation } from '@/lib/security';

const USER = { id: 'user-1', username: 'alice', role: 'user' as const };
const ADMIN = { id: 'admin-1', username: 'admin', role: 'admin' as const };

beforeEach(() => {
  vi.clearAllMocks();
  // Default happy-path defaults: authed, CSRF valid, not blocked, rate limit ok.
  mockGetQuickSession.mockResolvedValue(USER);
  mockUserBlockedQuery.mockResolvedValue({ data: { blocked: false }, error: null });
  mockValidateCSRF.mockResolvedValue(true);
  mockCheckRateLimit.mockResolvedValue({ allowed: true });
});

// ----------------------------------------------------------------------------
// Auth gate
// ----------------------------------------------------------------------------

describe('withMutation — auth gate', () => {
  it('rejects when getQuickSession returns null', async () => {
    mockGetQuickSession.mockResolvedValueOnce(null);
    const result = await withMutation(
      { csrfToken: 'csrf' },
      async () => ({ ok: true }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Authentication required/);
  });

  it('rejects when admin=true and user has role=user', async () => {
    const result = await withMutation(
      { admin: true, csrfToken: 'csrf' },
      async () => ({ ok: true }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Admin access required/);
  });

  it('passes when admin=true and user has role=admin', async () => {
    mockGetQuickSession.mockResolvedValueOnce(ADMIN);
    const result = await withMutation<unknown, { ok: true }>(
      { admin: true, csrfToken: 'csrf' },
      async () => ({ ok: true }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects when DB reports the user as blocked', async () => {
    mockUserBlockedQuery.mockResolvedValueOnce({ data: { blocked: true }, error: null });
    const result = await withMutation(
      { csrfToken: 'csrf' },
      async () => ({ ok: true }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/blocked/);
  });
});

// ----------------------------------------------------------------------------
// CSRF gate
// ----------------------------------------------------------------------------

describe('withMutation — CSRF gate', () => {
  it('rejects when csrfToken is missing', async () => {
    const result = await withMutation(
      { csrfToken: '' },
      async () => ({ ok: true }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/CSRF token/);
  });

  it('rejects when validateCSRFToken returns false', async () => {
    mockValidateCSRF.mockResolvedValueOnce(false);
    const result = await withMutation(
      { csrfToken: 'bad-token' },
      async () => ({ ok: true }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/CSRF token invalid/);
  });
});

// ----------------------------------------------------------------------------
// Schema validation
// ----------------------------------------------------------------------------

describe('withMutation — schema validation', () => {
  const schema = z.object({ name: z.string().min(3) });

  it('rejects when input fails validation', async () => {
    const result = await withMutation(
      { csrfToken: 'csrf', schema, input: { name: 'a' } },
      async () => ({ ok: true }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('passes parsed input to handler when validation succeeds', async () => {
    const handler = vi.fn(async ({ parsed }: { parsed: { name: string } }) => ({
      received: parsed.name,
    }));
    const result = await withMutation(
      { csrfToken: 'csrf', schema, input: { name: 'alice' } },
      handler,
    );
    expect(result.success).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.data).toEqual({ received: 'alice' });
  });
});

// ----------------------------------------------------------------------------
// Rate limit
// ----------------------------------------------------------------------------

describe('withMutation — rate limit', () => {
  it('rejects when the per-action rate limit denies the request', async () => {
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: false });
    const result = await withMutation(
      { csrfToken: 'csrf', rateLimitAction: 'updateThing' },
      async () => ({ ok: true }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Too many requests/);
  });

  it('passes when the rate-limit bucket allows the call', async () => {
    const result = await withMutation<unknown, { ok: true }>(
      { csrfToken: 'csrf', rateLimitAction: 'updateThing' },
      async () => ({ ok: true }),
    );
    expect(result.success).toBe(true);
  });
});

// ----------------------------------------------------------------------------
// Catch-all error path
// ----------------------------------------------------------------------------

describe('withMutation — catch-all error', () => {
  it('returns the fallback error when the handler throws', async () => {
    const result = await withMutation(
      { csrfToken: 'csrf', fallbackErrorMessage: 'boom' },
      async () => {
        throw new Error('handler exploded');
      },
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('boom');
  });

  it('returns a generic message when no fallbackErrorMessage is set', async () => {
    const result = await withMutation(
      { csrfToken: 'csrf' },
      async () => {
        throw new Error('handler exploded');
      },
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('Operation failed');
  });

  it('honors handler short-circuits returning { success: false, error }', async () => {
    const result = await withMutation(
      { csrfToken: 'csrf' },
      async () => ({ success: false, error: 'business rule failed' }) as const,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('business rule failed');
  });
});
