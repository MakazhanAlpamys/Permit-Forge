import '@testing-library/jest-dom';
import { vi } from 'vitest';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import enTranslations from '../lib/i18n/locales/en.json';

// Initialize i18next synchronously for tests with the EN bundle so component
// tests that assert on English UI text (e.g. "Today", "Sources", "Approve")
// see translated strings instead of raw i18n keys. No language detector — we
// pin to 'en' since every existing component test expects English copy.
if (!i18n.isInitialized) {
  i18n
    .use(initReactI18next)
    .init({
      resources: { en: { translation: enTranslations } },
      lng: 'en',
      fallbackLng: 'en',
      interpolation: { escapeValue: false },
      react: { useSuspense: false },
    });
}

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
// v1.4.0 Part E: extended the chainable mock with order/limit/range/in/upsert/storage so
// tests that exercise those chain methods don't silently no-op. Tests that
// previously skipped failures because the method was undefined will now fail
// loudly — the right outcome.
vi.mock('@/lib/supabase-server', () => {
  const mockRpc = vi.fn().mockResolvedValue({ data: [], error: null });
  const mockFrom = vi.fn(() => ({
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    upsert: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({ data: [], error: null }),
    range: vi.fn().mockResolvedValue({ data: [], error: null }),
    single: vi.fn().mockResolvedValue({ data: null, error: null }),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
  }));

  const mockStorage = {
    from: vi.fn(() => ({
      upload: vi.fn().mockResolvedValue({ data: null, error: null }),
      download: vi.fn().mockResolvedValue({ data: null, error: null }),
      remove: vi.fn().mockResolvedValue({ data: null, error: null }),
      createSignedUrl: vi.fn().mockResolvedValue({ data: { signedUrl: '' }, error: null }),
    })),
  };

  return {
    createServerClient: vi.fn(() => ({
      from: mockFrom,
      rpc: mockRpc,
      storage: mockStorage,
    })),
    createAdminClient: vi.fn(() => ({
      from: mockFrom,
      rpc: mockRpc,
      storage: mockStorage,
    })),
    checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
    assertServerSide: vi.fn(),
  };
});
