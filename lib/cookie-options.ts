// ============================================================================
// Cookie security defaults (C13H / M1 + M2)
// ============================================================================
// Single source of truth for cookie security flags. All app cookies (session,
// CSRF, blocked-reason) go through this so we can't accidentally ship one
// without `secure` or with `sameSite: 'lax'`.
//
// Defaults are strict: secure=true, sameSite='strict'. Local dev over plain
// http://localhost would lose its cookies under those defaults, so we honor
// DEV_INSECURE_COOKIES=1 as an explicit escape hatch.
//
// S-H-5 / SECRET-H1 / v1.5.0 Part D: renamed from NEXT_PUBLIC_DEV_INSECURE_COOKIES
// — the NEXT_PUBLIC_ prefix bakes the env var into the *client* bundle, which
// is the exact wrong audience for a server-side-only switch. The legacy name
// is still honored at runtime so a stale .env.local doesn't lock out local
// dev mid-upgrade, but new deployments should set DEV_INSECURE_COOKIES.
// ============================================================================

export interface SecureCookieOptions {
  secure: boolean;
  sameSite: 'strict' | 'lax' | 'none';
}

export function devInsecureCookiesEnabled(): boolean {
  return (
    process.env.DEV_INSECURE_COOKIES === '1' ||
    // Legacy alias — log a one-time warning so operators know to rename it.
    legacyDevInsecureCookiesEnabled()
  );
}

let _legacyDevInsecureWarned = false;
function legacyDevInsecureCookiesEnabled(): boolean {
  if (process.env.NEXT_PUBLIC_DEV_INSECURE_COOKIES !== '1') return false;

  // PSE5 (v1.5.0 re-audit): refuse to honor the legacy alias in production.
  // Without this, a stale .env.production copied from .env.local would
  // silently downgrade `secure` cookies to plain HTTP with only a one-time
  // console warning — the exact failure mode v1.5.0 Part D was meant to
  // prevent. In prod we log an ERROR and return false (cookies stay secure).
  if (process.env.NODE_ENV === 'production') {
    if (!_legacyDevInsecureWarned) {
      _legacyDevInsecureWarned = true;
      console.error(
        '[cookies] NEXT_PUBLIC_DEV_INSECURE_COOKIES=1 detected in production. ' +
          'The legacy alias is IGNORED in NODE_ENV=production for safety — cookies ' +
          'remain Secure + SameSite=Strict. Rename to DEV_INSECURE_COOKIES if you ' +
          'genuinely intended to disable cookie security (you almost certainly did not).',
      );
    }
    return false;
  }

  if (!_legacyDevInsecureWarned) {
    _legacyDevInsecureWarned = true;
    console.warn(
      '[cookies] NEXT_PUBLIC_DEV_INSECURE_COOKIES is deprecated — the NEXT_PUBLIC_ ' +
        'prefix leaks the flag into the client bundle. Rename to DEV_INSECURE_COOKIES.',
    );
  }
  return true;
}

/**
 * Cookie security defaults. Use the spread form:
 *   cookieStore.set(NAME, value, { ...secureCookieDefaults(), httpOnly: true, ... });
 */
export function secureCookieDefaults(): SecureCookieOptions {
  if (devInsecureCookiesEnabled()) {
    return { secure: false, sameSite: 'lax' };
  }
  return { secure: true, sameSite: 'strict' };
}
