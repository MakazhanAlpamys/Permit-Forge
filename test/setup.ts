import '@testing-library/jest-dom';
import { vi } from 'vitest';

// Mock environment variables for testing
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';
process.env.JWT_SECRET = 'test-jwt-secret-key-for-testing-purposes-only-32chars';
process.env.GEMINI_API_KEY = 'test-gemini-api-key';

// Mock Next.js cookies
vi.mock('next/headers', () => ({
  cookies: vi.fn(() => ({
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
  })),
  headers: vi.fn(() => new Headers()),
}));

// Mock Supabase server client - MUST mock @/lib/supabase-server (the actual import path used in code)
vi.mock('@/lib/supabase-server', () => {
  const mockRpc = vi.fn().mockResolvedValue({ data: [], error: null });
  const mockFrom = vi.fn(() => {
    // Make the chain object thenable so `await supabase.from(...).update(...).eq(...).select(...)`
    // resolves to `{ data: [{id}], error: null }` by default. Tests that need a specific result
    // override `single`/`then` per-call.
    const chain: Record<string, unknown> = {
      select: vi.fn().mockReturnThis(),
      insert: vi.fn().mockReturnThis(),
      update: vi.fn().mockReturnThis(),
      delete: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      neq: vi.fn().mockReturnThis(),
      gt: vi.fn().mockReturnThis(),
      lt: vi.fn().mockReturnThis(),
      gte: vi.fn().mockReturnThis(),
      lte: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      range: vi.fn().mockReturnThis(),
      not: vi.fn().mockReturnThis(),
      ilike: vi.fn().mockReturnThis(),
      like: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: null, error: null }),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      // Thenable: terminal awaits resolve to a default success row.
      then: (resolve: (v: { data: unknown; error: unknown }) => unknown) =>
        resolve({ data: [{ id: 'test-id' }], error: null }),
    };
    return chain;
  });
  
  return {
    createServerClient: vi.fn(() => ({
      from: mockFrom,
      rpc: mockRpc,
    })),
    createAdminClient: vi.fn(() => ({
      from: mockFrom,
      rpc: mockRpc,
    })),
    checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
    assertServerSide: vi.fn(),
  };
});
