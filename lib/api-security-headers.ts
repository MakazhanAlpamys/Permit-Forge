// ============================================================================
// Security headers for /api/* routes (A6 / H8 + M7)
// ============================================================================
// The middleware matcher excludes `api/*` (intentional — auth gating happens
// per-route via getQuickSession), which also meant API responses never got
// the security headers middleware adds to HTML responses. Each API route
// imports this helper and calls applySecurityHeaders(response) before
// returning. HSTS is only emitted in production to avoid mis-pinning local
// dev HTTP responses to HTTPS in the browser cache.
// ============================================================================

export function applySecurityHeaders<T extends Response>(response: T): T {
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-XSS-Protection', '1; mode=block');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  // HSTS: production-only. preload + includeSubDomains so once the policy is
  // honored, browsers refuse plaintext to any subdomain for 2 years.
  if (process.env.NODE_ENV === 'production') {
    response.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  }

  return response;
}
