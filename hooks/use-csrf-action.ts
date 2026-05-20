'use client';

// ============================================================================
// useCsrfAction — B12: centralize CSRF-refetch-and-retry-once for server
// actions. A user who keeps a tab open past CSRF cookie expiry hits a single
// "CSRF token invalid" error today; this hook makes that recoverable by
// transparently refetching the token and retrying the action exactly once.
// ============================================================================

import { useState, useEffect, useCallback, useRef } from 'react';
import { getCSRFTokenAction } from '@/actions/auth';

// Server actions return either an `error` (action layer) or `valid: false` +
// `error` (requireCSRF helper). Both forms surface the same strings.
interface ActionResultLike {
  error?: string;
  valid?: boolean;
  success?: boolean;
}

// Match by trimmed string equality (case-insensitive contains) so a tweak to
// the message doesn't silently disable retry.
function isCsrfRejection(result: ActionResultLike): boolean {
  if (!result || !result.error) return false;
  const lower = result.error.toLowerCase();
  return lower.includes('csrf');
}

export interface UseCsrfActionResult {
  csrfToken: string | null;
  /**
   * Run `fn(csrfToken)`. If the result looks like a CSRF rejection, refetch
   * a fresh token, update the hook's state, and call `fn` once more with the
   * new token. Returns the second result (or the first if it didn't need
   * retrying). Does NOT retry on non-CSRF errors.
   */
  runWithCsrf: <T extends ActionResultLike>(fn: (token: string) => Promise<T>) => Promise<T>;
  /** Manually force a token refetch (e.g. after `logoutAction`). */
  refreshCsrf: () => Promise<string | null>;
}

export function useCsrfAction(): UseCsrfActionResult {
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  // Ref mirror so runWithCsrf doesn't have to rebind on every csrf change.
  const tokenRef = useRef<string | null>(null);

  const refreshCsrf = useCallback(async () => {
    const fresh = await getCSRFTokenAction();
    tokenRef.current = fresh;
    setCsrfToken(fresh);
    return fresh;
  }, []);

  useEffect(() => {
    refreshCsrf();
  }, [refreshCsrf]);

  const runWithCsrf = useCallback(
    async <T extends ActionResultLike>(fn: (token: string) => Promise<T>): Promise<T> => {
      const first = await fn(tokenRef.current || '');
      if (isCsrfRejection(first)) {
        const fresh = await refreshCsrf();
        return fn(fresh || '');
      }
      return first;
    },
    [refreshCsrf],
  );

  return { csrfToken, runWithCsrf, refreshCsrf };
}
