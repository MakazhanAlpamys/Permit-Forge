// ============================================================================
// API security headers helper (A6 / H8 + M7)
// ============================================================================

import { describe, it, expect, vi, afterEach } from 'vitest';
import { applySecurityHeaders } from '@/lib/api-security-headers';

describe('applySecurityHeaders', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('sets the static security headers', () => {
    const res = applySecurityHeaders(new Response('ok'));
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('X-XSS-Protection')).toBe('1; mode=block');
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('Permissions-Policy')).toBe('camera=(), microphone=(), geolocation=()');
  });

  it('does NOT set HSTS in non-production', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const res = applySecurityHeaders(new Response('ok'));
    expect(res.headers.get('Strict-Transport-Security')).toBeNull();
  });

  it('sets HSTS in production with preload + includeSubDomains', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const res = applySecurityHeaders(new Response('ok'));
    expect(res.headers.get('Strict-Transport-Security')).toBe(
      'max-age=63072000; includeSubDomains; preload',
    );
  });

  it('returns the same Response instance (mutates headers in place)', () => {
    const r = new Response('x');
    const out = applySecurityHeaders(r);
    expect(out).toBe(r);
  });
});
