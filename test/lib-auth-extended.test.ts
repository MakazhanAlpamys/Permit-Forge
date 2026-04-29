// ============================================================================
// Coverage backfill for lib/auth.ts session + audit + IP helpers (P2-T2)
// ============================================================================
// Existing auth.test.ts covers JWT + CSRF basics. This file fills in:
//   - createSession / destroySession (cookie attrs)
//   - getSessionFromToken (no-cookie / invalid-token paths)
//   - getQuickSession
//   - logAuditEvent (success + DB error swallowing)
//   - getClientIp + TRUSTED_PROXY_HOPS
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Hoisted mocks (vi.mock is hoisted, so factory must be too) ---
const mocks = vi.hoisted(() => {
  const cookieStore = new Map<string, { value: string; opts?: Record<string, unknown> }>();
  const mockSet = vi.fn((name: string, value: string, opts?: Record<string, unknown>) => {
    cookieStore.set(name, { value, opts });
  });
  const mockGet = vi.fn((name: string) => {
    const entry = cookieStore.get(name);
    return entry ? { name, value: entry.value } : undefined;
  });
  const mockDelete = vi.fn((name: string) => cookieStore.delete(name));
  const mockHeadersGet = vi.fn(() => null);
  const mockInsert = vi.fn().mockResolvedValue({ error: null });

  return {
    cookieStore,
    mockSet,
    mockGet,
    mockDelete,
    mockHeadersGet,
    mockInsert,
    resetCookies: () => cookieStore.clear(),
  };
});

vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: mocks.mockGet,
      set: mocks.mockSet,
      delete: mocks.mockDelete,
    }),
  headers: () => Promise.resolve({ get: mocks.mockHeadersGet }),
}));

vi.mock('@/lib/supabase-server', () => ({
  createAdminClient: () => ({
    from: vi.fn(() => ({
      insert: mocks.mockInsert,
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: null, error: null }),
    })),
  }),
}));

import {
  createSession,
  destroySession,
  getSessionFromToken,
  getQuickSession,
  logAuditEvent,
  getClientIp,
  createJWTToken,
} from '@/lib/auth';
import { SESSION_COOKIE_NAME, CSRF_COOKIE_NAME } from '@/lib/constants';

// JWT payload schema requires UUID for sub.
const sampleUser = { id: '550e8400-e29b-41d4-a716-446655440000', username: 'alice', role: 'user' as const };

describe('lib/auth > createSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resetCookies();
  });

  it('sets SESSION_COOKIE_NAME with httpOnly + sameSite=lax', async () => {
    await createSession(sampleUser);
    expect(mocks.mockSet).toHaveBeenCalled();
    const call = mocks.mockSet.mock.calls.find(c => c[0] === SESSION_COOKIE_NAME);
    expect(call).toBeDefined();
    const opts = call?.[2] as Record<string, unknown>;
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe('lax');
    expect(opts.path).toBe('/');
    expect(typeof opts.maxAge).toBe('number');
  });

  it('writes a JWT (3-segment) value to the session cookie', async () => {
    await createSession(sampleUser);
    const stored = mocks.cookieStore.get(SESSION_COOKIE_NAME);
    expect(stored).toBeDefined();
    expect(stored!.value.split('.')).toHaveLength(3);
  });
});

describe('lib/auth > destroySession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resetCookies();
  });

  it('deletes both session and CSRF cookies', async () => {
    await destroySession();
    expect(mocks.mockDelete).toHaveBeenCalledWith(SESSION_COOKIE_NAME);
    expect(mocks.mockDelete).toHaveBeenCalledWith(CSRF_COOKIE_NAME);
  });
});

describe('lib/auth > getSessionFromToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resetCookies();
  });

  it('returns null when no session cookie exists', async () => {
    const result = await getSessionFromToken();
    expect(result).toBeNull();
  });

  it('returns null when the cookie value is not a valid JWT', async () => {
    mocks.cookieStore.set(SESSION_COOKIE_NAME, { value: 'not-a-jwt' });
    const result = await getSessionFromToken();
    expect(result).toBeNull();
  });

  it('returns the decoded payload when the cookie has a valid JWT', async () => {
    const token = await createJWTToken(sampleUser);
    mocks.cookieStore.set(SESSION_COOKIE_NAME, { value: token });
    const result = await getSessionFromToken();
    expect(result).not.toBeNull();
    expect(result!.sub).toBe(sampleUser.id);
    expect(result!.role).toBe(sampleUser.role);
  });
});

describe('lib/auth > getQuickSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resetCookies();
  });

  it('returns null when no session cookie present', async () => {
    expect(await getQuickSession()).toBeNull();
  });

  it('returns {id, username, role} when a valid JWT cookie is present', async () => {
    const token = await createJWTToken(sampleUser);
    mocks.cookieStore.set(SESSION_COOKIE_NAME, { value: token });
    const result = await getQuickSession();
    expect(result).toEqual({ id: sampleUser.id, username: 'alice', role: 'user' });
  });
});

describe('lib/auth > logAuditEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockInsert.mockResolvedValue({ error: null });
  });

  it('inserts the audit row with the expected columns', async () => {
    await logAuditEvent({
      userId: sampleUser.id,
      action: 'login_success',
      ipAddress: '1.2.3.4',
      userAgent: 'test-ua',
    });
    expect(mocks.mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: sampleUser.id,
        action: 'login_success',
        ip_address: '1.2.3.4',
        user_agent: 'test-ua',
      })
    );
  });

  it('does not throw when DB returns an error (failures are non-fatal)', async () => {
    mocks.mockInsert.mockResolvedValueOnce({ error: { message: 'db down' } });
    await expect(
      logAuditEvent({ userId: 'user-1', action: 'login_failed' })
    ).resolves.toBeUndefined();
  });

  it('does not throw when insert itself rejects', async () => {
    mocks.mockInsert.mockRejectedValueOnce(new Error('boom'));
    await expect(
      logAuditEvent({ userId: 'user-1', action: 'login_failed' })
    ).resolves.toBeUndefined();
  });

  it('defaults metadata to {} when not provided', async () => {
    await logAuditEvent({ userId: 'user-1', action: 'logout' });
    expect(mocks.mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: {} })
    );
  });
});

describe('lib/auth > getClientIp', () => {
  function makeHeaders(map: Record<string, string>) {
    return { get: (name: string) => map[name.toLowerCase()] ?? null };
  }

  it('prefers x-vercel-forwarded-for when present and valid', () => {
    expect(
      getClientIp(makeHeaders({ 'x-vercel-forwarded-for': '5.6.7.8' }))
    ).toBe('5.6.7.8');
  });

  it('falls back to x-real-ip when vercel header missing', () => {
    expect(getClientIp(makeHeaders({ 'x-real-ip': '9.10.11.12' }))).toBe('9.10.11.12');
  });

  it('returns "unknown" when no trusted header is present and TRUSTED_PROXY_HOPS unset', () => {
    expect(
      getClientIp(makeHeaders({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }))
    ).toBe('unknown');
  });

  it('rejects non-IP shaped values from x-real-ip', () => {
    expect(getClientIp(makeHeaders({ 'x-real-ip': 'not-an-ip<script>' }))).toBe('unknown');
  });

  it('accepts IPv6 addresses', () => {
    expect(getClientIp(makeHeaders({ 'x-real-ip': '2001:db8::1' }))).toBe('2001:db8::1');
  });
});
