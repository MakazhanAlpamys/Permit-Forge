// ============================================================================
// Client IP extraction with trusted-proxy allow-list (C2H / H3)
// ============================================================================
// X-Forwarded-For is client-controlled when the request reaches us directly,
// so reading the leftmost value blindly lets attackers forge IPs and either
// bypass per-IP rate limiting or poison audit logs / blocked-user reports.
//
// We only trust forwarding headers when the request arrived through a
// deployment we know terminates and rewrites them safely:
//   1. Vercel — `VERCEL=1` is set in their runtime; they strip any
//      client-supplied XFF before appending the real client IP.
//   2. Localhost dev — no real proxy in front; we want devtools to "just work".
//   3. Hosts the operator explicitly allow-listed via `TRUSTED_PROXY_HOSTS`
//      (CSV of hostnames; entries can be exact `foo.example.com` or
//      bare `example.com` which matches subdomains).
//
// In any other environment we return `'unknown'` so spoofed XFF values don't
// silently make it into audit_logs or rate-limit buckets.
// ============================================================================

interface ReadonlyHeaders {
  get(name: string): string | null;
}

function isTrustedDeployment(host: string): boolean {
  if (process.env.VERCEL === '1') return true;

  const lower = host.toLowerCase();
  if (
    lower.startsWith('localhost') ||
    lower.startsWith('127.0.0.1') ||
    lower.startsWith('[::1]')
  ) {
    return true;
  }

  const allowList = (process.env.TRUSTED_PROXY_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  if (allowList.length === 0) return false;

  const bareHost = lower.split(':')[0];
  return allowList.some((h) => bareHost === h || bareHost.endsWith('.' + h));
}

/**
 * Extract the client IP from request headers, only trusting forwarded values
 * when the deployment is on a known/trusted proxy. Returns `'unknown'` when
 * the IP cannot be safely determined.
 */
export function getClientIp(headers: ReadonlyHeaders): string {
  const host = headers.get('host') ?? '';

  if (isTrustedDeployment(host)) {
    const xff = headers.get('x-forwarded-for');
    if (xff) {
      // Leftmost = original client; trusted proxies append on the right.
      const first = xff.split(',')[0]?.trim();
      if (first) return first;
    }
    const realIp = headers.get('x-real-ip');
    if (realIp) return realIp;
  }

  return 'unknown';
}
