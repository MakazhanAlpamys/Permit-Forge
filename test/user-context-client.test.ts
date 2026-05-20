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
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateClient.mockReturnValue({ tag: 'mock-client' });
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    if (originalSupabaseJwtSecret === undefined) {
      delete process.env.SUPABASE_JWT_SECRET;
    } else {
      process.env.SUPABASE_JWT_SECRET = originalSupabaseJwtSecret;
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
});
