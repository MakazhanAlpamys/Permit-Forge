// ============================================================================
// Middleware nonce-based CSP (A5/H1)
// ============================================================================
// We can't easily unit-test the full middleware because it does a real fetch
// against Supabase for the block-status check. Instead we exercise the same
// flow at the integration boundary: spin up a NextRequest, run middleware,
// and assert on the response headers it sets for the public-path branch
// (which short-circuits before the fetch).

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.unmock('@/lib/supabase-server');

import { NextRequest } from 'next/server';
import { middleware } from '@/middleware';

afterEach(() => {
  vi.unstubAllEnvs();
});

async function runMiddleware(url: string): Promise<Response> {
  const request = new NextRequest(url);
  return (await middleware(request)) as unknown as Response;
}

describe('middleware CSP (A5/H1)', () => {
  it('emits a CSP with per-request script-src nonce', async () => {
    const res = await runMiddleware('http://localhost:3000/login');
    const csp = res.headers.get('Content-Security-Policy');
    expect(csp).toBeTruthy();
    expect(csp).toMatch(/script-src[^;]*'nonce-[A-Za-z0-9_-]+'/);
    expect(csp).toMatch(/script-src[^;]*'strict-dynamic'/);
  });

  it('does NOT allow unsafe-inline on script-src', async () => {
    const res = await runMiddleware('http://localhost:3000/login');
    const csp = res.headers.get('Content-Security-Policy') ?? '';
    const scriptSrc = csp.split(';').find((d) => d.trim().startsWith('script-src')) ?? '';
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  it('drops unsafe-eval from script-src in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const res = await runMiddleware('http://localhost:3000/login');
    const csp = res.headers.get('Content-Security-Policy') ?? '';
    const scriptSrc = csp.split(';').find((d) => d.trim().startsWith('script-src')) ?? '';
    expect(scriptSrc).not.toContain("'unsafe-eval'");
  });

  it('keeps unsafe-eval in dev for HMR', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const res = await runMiddleware('http://localhost:3000/login');
    const csp = res.headers.get('Content-Security-Policy') ?? '';
    const scriptSrc = csp.split(';').find((d) => d.trim().startsWith('script-src')) ?? '';
    expect(scriptSrc).toContain("'unsafe-eval'");
  });

  it('uses a different nonce on each request', async () => {
    const a = await runMiddleware('http://localhost:3000/login');
    const b = await runMiddleware('http://localhost:3000/login');
    const nonceOf = (r: Response) => {
      const csp = r.headers.get('Content-Security-Policy') ?? '';
      return csp.match(/'nonce-([A-Za-z0-9_-]+)'/)?.[1];
    };
    expect(nonceOf(a)).toBeTruthy();
    expect(nonceOf(b)).toBeTruthy();
    expect(nonceOf(a)).not.toBe(nonceOf(b));
  });
});
