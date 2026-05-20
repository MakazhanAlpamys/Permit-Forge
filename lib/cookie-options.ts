// ============================================================================
// Cookie security defaults (C13H / M1 + M2)
// ============================================================================
// Single source of truth for cookie security flags. All app cookies (session,
// CSRF, blocked-reason) go through this so we can't accidentally ship one
// without `secure` or with `sameSite: 'lax'`.
//
// Defaults are strict: secure=true, sameSite='strict'. Local dev over plain
// http://localhost would lose its cookies under those defaults, so we honor
// NEXT_PUBLIC_DEV_INSECURE_COOKIES=1 as an explicit escape hatch.
// ============================================================================

export interface SecureCookieOptions {
  secure: boolean;
  sameSite: 'strict' | 'lax' | 'none';
}

export function devInsecureCookiesEnabled(): boolean {
  return process.env.NEXT_PUBLIC_DEV_INSECURE_COOKIES === '1';
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
