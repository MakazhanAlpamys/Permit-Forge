// ============================================================================
// E1 / Phase2 T1 — middleware coverage
// ============================================================================
// Covers the slices that the existing middleware-csp.test.ts skipped:
//   - JWT verify (valid / invalid / expired)
//   - block-status cache TTL + DB hop short-circuit
//   - role-based redirects (admin ↔ user)
//   - x-middleware-subrequest CVE-2025-29927 defense
//   - x-user-id / x-user-role response headers on authenticated requests
//   - C14H token_version invalidation
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SignJWT } from 'jose';
import { SESSION_COOKIE_NAME, getJWTSecret, SESSION_MAX_AGE } from '@/lib/constants';
import { blockStatusCache } from '@/lib/block-status-cache';

// Don't use the project-wide @/lib/supabase-server mock here; middleware
// talks to Supabase via raw fetch, so we mock global.fetch directly.
vi.unmock('@/lib/supabase-server');

import { NextRequest } from 'next/server';
import { middleware } from '@/middleware';

const USER_ID = '550e8400-e29b-41d4-a716-446655440000';
const ADMIN_ID = '660e8400-e29b-41d4-a716-446655440111';

async function makeToken(opts: {
  sub: string;
  role: 'admin' | 'user';
  tv?: number;
  expSeconds?: number;
}): Promise<string> {
  const secret = getJWTSecret();
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    sub: opts.sub,
    username: 'tester',
    role: opts.role,
    tv: opts.tv ?? 0,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(opts.expSeconds ?? now + SESSION_MAX_AGE)
    .sign(secret);
}

function makeRequest(
  url: string,
  init?: { cookies?: Record<string, string>; headers?: Record<string, string> },
): NextRequest {
  const headers: Record<string, string> = { ...(init?.headers || {}) };
  if (init?.cookies) {
    headers['cookie'] = Object.entries(init.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }
  return new NextRequest(url, { headers });
}

function mockFetchBlockedRow(row: {
  blocked: boolean;
  blocked_reason?: string | null;
  token_version?: number;
}) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => [row],
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function mockFetchEmptyRow() {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => [],
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function mockFetchHttpError(status = 500) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: async () => ({ error: 'oops' }),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  blockStatusCache.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  blockStatusCache.clear();
});

describe('middleware — CVE-2025-29927 defense', () => {
  it('rejects requests carrying x-middleware-subrequest with 403', async () => {
    const req = makeRequest('http://localhost:3000/', {
      headers: { 'x-middleware-subrequest': 'middleware:middleware' },
    });
    const res = (await middleware(req)) as unknown as Response;
    expect(res.status).toBe(403);
  });
});

describe('middleware — no session', () => {
  it('redirects to /login for protected paths', async () => {
    const req = makeRequest('http://localhost:3000/permits');
    const res = (await middleware(req)) as unknown as Response;
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
  });

  it('lets public paths through without auth', async () => {
    const req = makeRequest('http://localhost:3000/login');
    const res = (await middleware(req)) as unknown as Response;
    // Public path with no token = NextResponse.next() (no redirect)
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Security-Policy')).toContain("script-src");
  });

  it('applies security headers to anonymous responses', async () => {
    const req = makeRequest('http://localhost:3000/login');
    const res = (await middleware(req)) as unknown as Response;
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('Permissions-Policy')).toContain('camera=()');
  });
});

describe('middleware — invalid / expired tokens', () => {
  it('redirects to /login when JWT signature is invalid', async () => {
    const req = makeRequest('http://localhost:3000/', {
      cookies: { [SESSION_COOKIE_NAME]: 'a.b.c' },
    });
    const res = (await middleware(req)) as unknown as Response;
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
  });

  it('clears session cookie on bad token', async () => {
    const req = makeRequest('http://localhost:3000/', {
      cookies: { [SESSION_COOKIE_NAME]: 'totally-broken' },
    });
    const res = (await middleware(req)) as unknown as Response;
    // Set-Cookie deletes both ef_token and ef_csrf
    const setCookies = res.headers.getSetCookie?.() ?? [];
    const joined = setCookies.join(';');
    expect(joined).toMatch(/ef_token=/);
  });

  it('rejects expired JWTs', async () => {
    // exp 60s in the past
    const expiredToken = await makeToken({
      sub: USER_ID,
      role: 'user',
      expSeconds: Math.floor(Date.now() / 1000) - 60,
    });
    const req = makeRequest('http://localhost:3000/', {
      cookies: { [SESSION_COOKIE_NAME]: expiredToken },
    });
    const res = (await middleware(req)) as unknown as Response;
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
  });

  it('rejects JWTs signed with a different secret', async () => {
    const secret = new TextEncoder().encode(
      'a-completely-different-secret-with-enough-length-to-pass-the-32-char-check',
    );
    const wrongToken = await new SignJWT({
      sub: USER_ID,
      username: 'tester',
      role: 'user',
      tv: 0,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(secret);
    const req = makeRequest('http://localhost:3000/', {
      cookies: { [SESSION_COOKIE_NAME]: wrongToken },
    });
    const res = (await middleware(req)) as unknown as Response;
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
  });
});

describe('middleware — block-status cache TTL', () => {
  it('hits the DB on a cache miss', async () => {
    const fetchMock = mockFetchBlockedRow({ blocked: false, token_version: 0 });
    const token = await makeToken({ sub: USER_ID, role: 'user', tv: 0 });
    const req = makeRequest('http://localhost:3000/permits', {
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    await middleware(req);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCallUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(firstCallUrl).toContain(`id=eq.${USER_ID}`);
  });

  it('skips the DB on a fresh cache hit', async () => {
    blockStatusCache.set(USER_ID, {
      blocked: false,
      tokenVersion: 0,
      checkedAt: Date.now(),
    });
    const fetchMock = mockFetchBlockedRow({ blocked: false, token_version: 0 });
    const token = await makeToken({ sub: USER_ID, role: 'user', tv: 0 });
    const req = makeRequest('http://localhost:3000/permits', {
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    await middleware(req);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('re-fetches when the cache entry is older than TTL', async () => {
    const stale = Date.now() - 6 * 60 * 1000; // 6 minutes — beyond 5min TTL
    blockStatusCache.set(USER_ID, {
      blocked: false,
      tokenVersion: 0,
      checkedAt: stale,
    });
    const fetchMock = mockFetchBlockedRow({ blocked: false, token_version: 0 });
    const token = await makeToken({ sub: USER_ID, role: 'user', tv: 0 });
    const req = makeRequest('http://localhost:3000/permits', {
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    await middleware(req);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('clears session and redirects when DB reports user blocked', async () => {
    mockFetchBlockedRow({
      blocked: true,
      blocked_reason: 'Spam',
      token_version: 0,
    });
    const token = await makeToken({ sub: USER_ID, role: 'user', tv: 0 });
    const req = makeRequest('http://localhost:3000/permits', {
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    const res = (await middleware(req)) as unknown as Response;
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
    const setCookies = res.headers.getSetCookie?.() ?? [];
    expect(setCookies.join(';')).toMatch(/ef_blocked_reason=Spam/);
  });

  it('treats a missing DB row as deleted (blocked)', async () => {
    mockFetchEmptyRow();
    const token = await makeToken({ sub: USER_ID, role: 'user', tv: 0 });
    const req = makeRequest('http://localhost:3000/permits', {
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    const res = (await middleware(req)) as unknown as Response;
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
  });

  it('fails open (does NOT block) on DB error', async () => {
    mockFetchHttpError(500);
    const token = await makeToken({ sub: USER_ID, role: 'user', tv: 0 });
    const req = makeRequest('http://localhost:3000/', {
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    const res = (await middleware(req)) as unknown as Response;
    // Not redirected to /login because of the block check; the request proceeds.
    expect(res.status).toBe(200);
  });
});

describe('middleware — token_version (C14H/M3)', () => {
  it('invalidates session when JWT.tv is behind DB token_version', async () => {
    mockFetchBlockedRow({ blocked: false, token_version: 5 });
    const token = await makeToken({ sub: USER_ID, role: 'user', tv: 1 });
    const req = makeRequest('http://localhost:3000/', {
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    const res = (await middleware(req)) as unknown as Response;
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
  });

  it('accepts session when JWT.tv matches DB', async () => {
    mockFetchBlockedRow({ blocked: false, token_version: 3 });
    const token = await makeToken({ sub: USER_ID, role: 'user', tv: 3 });
    const req = makeRequest('http://localhost:3000/', {
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    const res = (await middleware(req)) as unknown as Response;
    expect(res.status).toBe(200);
  });

  it('accepts session when JWT.tv is ahead of DB (never happens in practice)', async () => {
    mockFetchBlockedRow({ blocked: false, token_version: 0 });
    const token = await makeToken({ sub: USER_ID, role: 'user', tv: 7 });
    const req = makeRequest('http://localhost:3000/', {
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    const res = (await middleware(req)) as unknown as Response;
    expect(res.status).toBe(200);
  });
});

describe('middleware — role-based routing', () => {
  it('redirects admin off / to /admin', async () => {
    mockFetchBlockedRow({ blocked: false, token_version: 0 });
    const token = await makeToken({ sub: ADMIN_ID, role: 'admin' });
    const req = makeRequest('http://localhost:3000/', {
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    const res = (await middleware(req)) as unknown as Response;
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/admin');
  });

  it('redirects admin off /permits to /admin', async () => {
    mockFetchBlockedRow({ blocked: false, token_version: 0 });
    const token = await makeToken({ sub: ADMIN_ID, role: 'admin' });
    const req = makeRequest('http://localhost:3000/permits', {
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    const res = (await middleware(req)) as unknown as Response;
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/admin');
  });

  it('redirects non-admin off /admin to /', async () => {
    mockFetchBlockedRow({ blocked: false, token_version: 0 });
    const token = await makeToken({ sub: USER_ID, role: 'user' });
    const req = makeRequest('http://localhost:3000/admin', {
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    const res = (await middleware(req)) as unknown as Response;
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toMatch(/\/$/);
  });

  it('redirects authenticated users off /login to their dashboard', async () => {
    mockFetchBlockedRow({ blocked: false, token_version: 0 });
    const token = await makeToken({ sub: USER_ID, role: 'user' });
    const req = makeRequest('http://localhost:3000/login', {
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    const res = (await middleware(req)) as unknown as Response;
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toMatch(/\/$/);
  });

  it('lets a user access /permits when role matches', async () => {
    mockFetchBlockedRow({ blocked: false, token_version: 0 });
    const token = await makeToken({ sub: USER_ID, role: 'user' });
    const req = makeRequest('http://localhost:3000/permits', {
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    const res = (await middleware(req)) as unknown as Response;
    expect(res.status).toBe(200);
    expect(res.headers.get('x-user-id')).toBe(USER_ID);
    expect(res.headers.get('x-user-role')).toBe('user');
  });

  it('lets an admin access /admin and stamps x-user-* headers', async () => {
    mockFetchBlockedRow({ blocked: false, token_version: 0 });
    const token = await makeToken({ sub: ADMIN_ID, role: 'admin' });
    const req = makeRequest('http://localhost:3000/admin', {
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    const res = (await middleware(req)) as unknown as Response;
    expect(res.status).toBe(200);
    expect(res.headers.get('x-user-id')).toBe(ADMIN_ID);
    expect(res.headers.get('x-user-role')).toBe('admin');
  });
});

describe('middleware — HSTS gating', () => {
  it('emits Strict-Transport-Security in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const req = makeRequest('http://localhost:3000/login');
    const res = (await middleware(req)) as unknown as Response;
    expect(res.headers.get('Strict-Transport-Security')).toContain('max-age=63072000');
  });

  it('does not emit Strict-Transport-Security in dev', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const req = makeRequest('http://localhost:3000/login');
    const res = (await middleware(req)) as unknown as Response;
    expect(res.headers.get('Strict-Transport-Security')).toBeNull();
  });
});
