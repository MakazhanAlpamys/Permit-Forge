// ============================================================================
// lib/cookie-options.ts — DEV_INSECURE_COOKIES flag (S-H-5 / v1.5.0 Part D)
// ============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { devInsecureCookiesEnabled, secureCookieDefaults } from '@/lib/cookie-options';

describe('devInsecureCookiesEnabled', () => {
  const originalDevInsecure = process.env.DEV_INSECURE_COOKIES;
  const originalPublic = process.env.NEXT_PUBLIC_DEV_INSECURE_COOKIES;

  beforeEach(() => {
    delete process.env.DEV_INSECURE_COOKIES;
    delete process.env.NEXT_PUBLIC_DEV_INSECURE_COOKIES;
  });

  afterEach(() => {
    if (originalDevInsecure === undefined) delete process.env.DEV_INSECURE_COOKIES;
    else process.env.DEV_INSECURE_COOKIES = originalDevInsecure;
    if (originalPublic === undefined) delete process.env.NEXT_PUBLIC_DEV_INSECURE_COOKIES;
    else process.env.NEXT_PUBLIC_DEV_INSECURE_COOKIES = originalPublic;
  });

  it('returns false by default (production-safe)', () => {
    expect(devInsecureCookiesEnabled()).toBe(false);
  });

  it('returns true when DEV_INSECURE_COOKIES=1', () => {
    process.env.DEV_INSECURE_COOKIES = '1';
    expect(devInsecureCookiesEnabled()).toBe(true);
  });

  // S-H-5 / SECRET-H1: NEXT_PUBLIC_ prefix leaks the flag into the client
  // bundle. The new name is the canonical one; the legacy alias keeps working
  // at runtime so a stale .env.local doesn't lock out local dev mid-upgrade.
  it('honors the legacy NEXT_PUBLIC_DEV_INSECURE_COOKIES=1 alias (backcompat, dev only)', () => {
    process.env.NEXT_PUBLIC_DEV_INSECURE_COOKIES = '1';
    expect(devInsecureCookiesEnabled()).toBe(true);
  });

  // PSE5 (v1.5.0 re-audit): the legacy alias must be IGNORED in production
  // so a stale .env.production cannot silently downgrade cookies to plain
  // HTTP with only a console warning. Cookies stay Secure + SameSite=Strict.
  it('IGNORES the legacy alias in production (PSE5)', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NEXT_PUBLIC_DEV_INSECURE_COOKIES = '1';
    // process.env.NODE_ENV is typed as readonly via @types/node but the
    // underlying object is a plain string map at runtime.
    (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
    try {
      // Security-critical: the prod branch refuses the legacy opt-out so
      // cookies stay secure regardless of which warn flag was already
      // tripped by a prior dev-mode call in this test suite.
      expect(devInsecureCookiesEnabled()).toBe(false);
      expect(secureCookieDefaults()).toEqual({ secure: true, sameSite: 'strict' });
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = originalNodeEnv;
    }
  });

  it('does NOT trigger on values other than the literal string "1"', () => {
    process.env.DEV_INSECURE_COOKIES = 'true';
    expect(devInsecureCookiesEnabled()).toBe(false);
    process.env.DEV_INSECURE_COOKIES = '0';
    expect(devInsecureCookiesEnabled()).toBe(false);
    process.env.DEV_INSECURE_COOKIES = '';
    expect(devInsecureCookiesEnabled()).toBe(false);
  });
});

describe('secureCookieDefaults', () => {
  const originalDevInsecure = process.env.DEV_INSECURE_COOKIES;

  beforeEach(() => {
    delete process.env.DEV_INSECURE_COOKIES;
    delete process.env.NEXT_PUBLIC_DEV_INSECURE_COOKIES;
  });

  afterEach(() => {
    if (originalDevInsecure === undefined) delete process.env.DEV_INSECURE_COOKIES;
    else process.env.DEV_INSECURE_COOKIES = originalDevInsecure;
  });

  it('returns secure=true, sameSite=strict in production (default)', () => {
    expect(secureCookieDefaults()).toEqual({ secure: true, sameSite: 'strict' });
  });

  it('returns secure=false, sameSite=lax when DEV_INSECURE_COOKIES=1 (local dev)', () => {
    process.env.DEV_INSECURE_COOKIES = '1';
    expect(secureCookieDefaults()).toEqual({ secure: false, sameSite: 'lax' });
  });
});
