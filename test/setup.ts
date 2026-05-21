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

// Mock Next.js cache invalidators — these require a request scope at runtime
// and throw "static generation store missing" when invoked from a unit test.
// X15 added `revalidatePath` calls to admin-permit actions; this keeps every
// action test inert against those calls.
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: <T>(fn: T) => fn,
}));

// Mock Supabase server client - MUST mock @/lib/supabase-server (the actual import path used in code)
vi.mock('@/lib/supabase-server', () => {
  const mockRpc = vi.fn().mockResolvedValue({ data: [], error: null });
  const mockFrom = vi.fn(() => ({
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: null, error: null }),
  }));
  
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
