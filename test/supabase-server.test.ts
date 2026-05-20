// ============================================================================
// E9a — lib/supabase-server.ts coverage
// ============================================================================
// Tests the env-var validation, admin singleton behavior, and the
// createUserContextClient fallback when SUPABASE_JWT_SECRET is missing.
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @supabase/supabase-js so we don't try to open real network connections.
const mockCreateClient = vi.fn();
vi.mock('@supabase/supabase-js', () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

// We need to bypass the test/setup.ts mock of @/lib/supabase-server itself.
vi.unmock('@/lib/supabase-server');

async function freshModule() {
  vi.resetModules();
  mockCreateClient.mockReset();
  // Each fresh import gets a unique sentinel client back.
  let counter = 0;
  mockCreateClient.mockImplementation(() => ({ __id: ++counter }));
  return await import('@/lib/supabase-server');
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ----------------------------------------------------------------------------
// createAdminClient
// ----------------------------------------------------------------------------

describe('createAdminClient', () => {
  it('returns the same singleton on repeated calls', async () => {
    const mod = await freshModule();
    const a = mod.createAdminClient();
    const b = mod.createAdminClient();
    expect(a).toBe(b);
    expect(mockCreateClient).toHaveBeenCalledTimes(1);
  });

  it('passes auth flags so the client never refreshes/persists tokens', async () => {
    const mod = await freshModule();
    mod.createAdminClient();
    const [, , opts] = mockCreateClient.mock.calls[0];
    expect(opts.auth.autoRefreshToken).toBe(false);
    expect(opts.auth.persistSession).toBe(false);
  });

  it('throws when NEXT_PUBLIC_SUPABASE_URL is missing', async () => {
    const original = process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    try {
      const mod = await freshModule();
      expect(() => mod.createAdminClient()).toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
    } finally {
      process.env.NEXT_PUBLIC_SUPABASE_URL = original;
    }
  });

  it('throws when SUPABASE_SERVICE_ROLE_KEY is missing', async () => {
    const original = process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    try {
      const mod = await freshModule();
      expect(() => mod.createAdminClient()).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
    } finally {
      process.env.SUPABASE_SERVICE_ROLE_KEY = original;
    }
  });
});

// ----------------------------------------------------------------------------
// createServerClient (anon)
// ----------------------------------------------------------------------------

describe('createServerClient', () => {
  it('builds a fresh client each call (not a singleton)', async () => {
    const mod = await freshModule();
    mod.createServerClient();
    mod.createServerClient();
    expect(mockCreateClient).toHaveBeenCalledTimes(2);
  });

  it('throws when SUPABASE_ANON_KEY is missing', async () => {
    const original = process.env.SUPABASE_ANON_KEY;
    delete process.env.SUPABASE_ANON_KEY;
    try {
      const mod = await freshModule();
      expect(() => mod.createServerClient()).toThrow(/SUPABASE_ANON_KEY/);
    } finally {
      process.env.SUPABASE_ANON_KEY = original;
    }
  });
});

// ----------------------------------------------------------------------------
// createUserContextClient
// ----------------------------------------------------------------------------

describe('createUserContextClient', () => {
  it('falls back to the admin singleton when SUPABASE_JWT_SECRET is unset', async () => {
    const original = process.env.SUPABASE_JWT_SECRET;
    delete process.env.SUPABASE_JWT_SECRET;
    try {
      const mod = await freshModule();
      const admin = mod.createAdminClient();
      const ctx = await mod.createUserContextClient(
        '550e8400-e29b-41d4-a716-446655440000',
      );
      expect(ctx).toBe(admin); // Same singleton.
    } finally {
      process.env.SUPABASE_JWT_SECRET = original;
    }
  });

  it('mints a Supabase JWT and uses Authorization header when SUPABASE_JWT_SECRET is set', async () => {
    process.env.SUPABASE_JWT_SECRET =
      'unit-test-supabase-jwt-secret-must-be-long-enough-for-hs256';
    try {
      const mod = await freshModule();
      await mod.createUserContextClient('550e8400-e29b-41d4-a716-446655440000');

      // First call: admin singleton wasn't built yet in this fresh module, so
      // the very first call should be the context client itself.
      const [, , opts] = mockCreateClient.mock.calls.at(-1) as unknown as [
        unknown,
        unknown,
        { global: { headers: Record<string, string> } },
      ];
      expect(opts.global.headers.Authorization).toMatch(/^Bearer /);
      // JWT has 3 dot-separated parts.
      expect(opts.global.headers.Authorization.split(' ')[1].split('.')).toHaveLength(3);
    } finally {
      delete process.env.SUPABASE_JWT_SECRET;
    }
  });
});

// ----------------------------------------------------------------------------
// checkRateLimit
// ----------------------------------------------------------------------------

describe('checkRateLimit', () => {
  it('returns allowed=true on RPC success', async () => {
    const mod = await freshModule();
    const rpc = vi
      .fn()
      .mockResolvedValue({
        data: [{ allowed: true, retry_after_ms: null, current_count: 1 }],
        error: null,
      });
    mockCreateClient.mockReturnValueOnce({ rpc });
    // The admin singleton was already built by an earlier test; rebuild a fresh
    // module to ensure mockCreateClient is the next createClient call.
    // (freshModule above already did that.)

    const result = await mod.checkRateLimit('user-1', { endpoint: 'chat' });
    expect(result.allowed).toBe(true);
    expect(result.currentCount).toBe(1);
  });

  it('fails closed (allowed=false) on RPC error', async () => {
    const mod = await freshModule();
    const rpc = vi
      .fn()
      .mockResolvedValue({ data: null, error: { message: 'boom' } });
    // Replace the cached admin client so the rate limit call uses our rpc.
    mockCreateClient.mockReturnValueOnce({ rpc });
    const result = await mod.checkRateLimit('user-1');
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('fails closed when the call throws', async () => {
    const mod = await freshModule();
    mockCreateClient.mockReturnValueOnce({
      rpc: () => {
        throw new Error('connection refused');
      },
    });
    const result = await mod.checkRateLimit('user-1');
    expect(result.allowed).toBe(false);
  });

  it('fails closed when RPC returns an empty array', async () => {
    const mod = await freshModule();
    mockCreateClient.mockReturnValueOnce({
      rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
    });
    const result = await mod.checkRateLimit('user-1');
    expect(result.allowed).toBe(false);
  });
});
