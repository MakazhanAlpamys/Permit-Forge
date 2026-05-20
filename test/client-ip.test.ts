// ============================================================================
// Tests: lib/client-ip — trusted-proxy XFF allow-list (C2H / H3)
// ============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getClientIp } from '@/lib/client-ip';

function mkHeaders(map: Record<string, string>): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(map)) h.set(k, v);
  return h;
}

describe('getClientIp', () => {
  const ORIGINAL_VERCEL = process.env.VERCEL;
  const ORIGINAL_TRUSTED = process.env.TRUSTED_PROXY_HOSTS;

  beforeEach(() => {
    delete process.env.VERCEL;
    delete process.env.TRUSTED_PROXY_HOSTS;
  });

  afterEach(() => {
    if (ORIGINAL_VERCEL === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = ORIGINAL_VERCEL;
    if (ORIGINAL_TRUSTED === undefined) delete process.env.TRUSTED_PROXY_HOSTS;
    else process.env.TRUSTED_PROXY_HOSTS = ORIGINAL_TRUSTED;
  });

  it('trusts XFF on localhost dev', () => {
    const h = mkHeaders({
      host: 'localhost:3000',
      'x-forwarded-for': '203.0.113.7, 10.0.0.1',
    });
    expect(getClientIp(h)).toBe('203.0.113.7');
  });

  it('trusts XFF on Vercel', () => {
    process.env.VERCEL = '1';
    const h = mkHeaders({
      host: 'permitforge.vercel.app',
      'x-forwarded-for': '198.51.100.4',
    });
    expect(getClientIp(h)).toBe('198.51.100.4');
  });

  it('returns "unknown" when XFF arrives via untrusted host', () => {
    const h = mkHeaders({
      host: 'attacker.example.org',
      'x-forwarded-for': '203.0.113.7',
      'x-real-ip': '203.0.113.7',
    });
    expect(getClientIp(h)).toBe('unknown');
  });

  it('respects TRUSTED_PROXY_HOSTS allow-list (exact match)', () => {
    process.env.TRUSTED_PROXY_HOSTS = 'app.example.com';
    const h = mkHeaders({
      host: 'app.example.com',
      'x-forwarded-for': '198.51.100.42',
    });
    expect(getClientIp(h)).toBe('198.51.100.42');
  });

  it('respects TRUSTED_PROXY_HOSTS allow-list (subdomain wildcard via bare host)', () => {
    process.env.TRUSTED_PROXY_HOSTS = 'example.com';
    const h = mkHeaders({
      host: 'api.example.com',
      'x-forwarded-for': '198.51.100.99',
    });
    expect(getClientIp(h)).toBe('198.51.100.99');
  });

  it('rejects host substring impersonation', () => {
    process.env.TRUSTED_PROXY_HOSTS = 'example.com';
    const h = mkHeaders({
      host: 'fake-example.com',
      'x-forwarded-for': '198.51.100.99',
    });
    expect(getClientIp(h)).toBe('unknown');
  });

  it('falls back to x-real-ip when XFF is missing and host is trusted', () => {
    const h = mkHeaders({
      host: 'localhost:3000',
      'x-real-ip': '203.0.113.50',
    });
    expect(getClientIp(h)).toBe('203.0.113.50');
  });

  it('returns "unknown" when no IP headers present on trusted host', () => {
    const h = mkHeaders({ host: 'localhost:3000' });
    expect(getClientIp(h)).toBe('unknown');
  });

  it('handles XFF with whitespace and multiple hops', () => {
    const h = mkHeaders({
      host: 'localhost',
      'x-forwarded-for': '  203.0.113.7  , 10.0.0.1, 192.168.1.1',
    });
    expect(getClientIp(h)).toBe('203.0.113.7');
  });
});
