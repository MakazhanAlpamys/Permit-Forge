// ============================================================================
// createUserContextClient (A2/C4)
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Setup.ts globally mocks @/lib/supabase-server. Unmock it here so we exercise
// the real module under test.
vi.unmock('@/lib/supabase-server');

const mockCreateClient = vi.fn();

vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>(
    '@supabase/supabase-js',
  );
  return {
    ...actual,
    createClient: (...args: unknown[]) => mockCreateClient(...args),
  };
});

// Fresh imports per test so the singleton _adminClient + the one-time warn
// flag don't leak state between cases.
async function freshModule() {
  vi.resetModules();
  return await vi.importActual<typeof import('@/lib/supabase-server')>('@/lib/supabase-server');
}

describe('createUserContextClient (A2)', () => {
  const originalSupabaseJwtSecret = process.env.SUPABASE_JWT_SECRET;
  const originalEnableFlag = process.env.ENABLE_USER_CONTEXT_RLS;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateClient.mockReturnValue({ tag: 'mock-client' });
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // A2 is opt-in via ENABLE_USER_CONTEXT_RLS=1. All assertions about the
    // JWT minting / warn path assume the flag is on; the off-by-default
    // behavior is exercised in its own case below.
    process.env.ENABLE_USER_CONTEXT_RLS = '1';
  });

  afterEach(() => {
    warnSpy.mockRestore();
    if (originalSupabaseJwtSecret === undefined) {
      delete process.env.SUPABASE_JWT_SECRET;
    } else {
      process.env.SUPABASE_JWT_SECRET = originalSupabaseJwtSecret;
    }
    if (originalEnableFlag === undefined) {
      delete process.env.ENABLE_USER_CONTEXT_RLS;
    } else {
      process.env.ENABLE_USER_CONTEXT_RLS = originalEnableFlag;
    }
  });

  it('mints a JWT and sets Authorization header when SUPABASE_JWT_SECRET is configured', async () => {
    process.env.SUPABASE_JWT_SECRET = 'test-supabase-jwt-secret-at-least-32-chars-long-ok';
    const { createUserContextClient } = await freshModule();

    await createUserContextClient('user-abc-123');

    // The second call to createClient (anon key + auth header). The first call
    // may have been for the admin singleton.
    const userContextCall = mockCreateClient.mock.calls.find((args) => {
      const opts = args[2] as { global?: { headers?: Record<string, string> } } | undefined;
      return !!opts?.global?.headers?.Authorization;
    });
    expect(userContextCall, 'no createClient call carried an Authorization header').toBeDefined();
    const opts = userContextCall![2] as { global: { headers: { Authorization: string } } };
    expect(opts.global.headers.Authorization).toMatch(/^Bearer eyJ/);
  });

  it('falls back to admin client and warns once when SUPABASE_JWT_SECRET is missing', async () => {
    delete process.env.SUPABASE_JWT_SECRET;
    const { createUserContextClient } = await freshModule();

    const c1 = await createUserContextClient('user-1');
    const c2 = await createUserContextClient('user-2');

    // Same admin-client singleton returned both times.
    expect(c1).toBe(c2);
    // Warn fires exactly once.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('SUPABASE_JWT_SECRET');
  });

  it('returns admin client (silently) when ENABLE_USER_CONTEXT_RLS is not set', async () => {
    // Same secret config as the happy-path test, but with the opt-in flag off.
    process.env.SUPABASE_JWT_SECRET = 'test-supabase-jwt-secret-at-least-32-chars-long-ok';
    delete process.env.ENABLE_USER_CONTEXT_RLS;
    const { createUserContextClient } = await freshModule();

    await createUserContextClient('user-abc-123');

    const userContextCall = mockCreateClient.mock.calls.find((args) => {
      const opts = args[2] as { global?: { headers?: Record<string, string> } } | undefined;
      return !!opts?.global?.headers?.Authorization;
    });
    expect(userContextCall, 'no Authorization header should be set with the flag off').toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
