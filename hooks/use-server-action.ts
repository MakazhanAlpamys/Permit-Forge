'use client';

// ============================================================================
// useServerAction — CP-C-2 / CP-C-3 (v1.2.0 Part A).
// ============================================================================
// Wraps a server-action call to fix the silent-failure family:
//   const result = await action(...);
//   if (result.success) { ... }   // <-- no else; user sees nothing on failure
//
// The hook does three things:
//   1. In-flight guard — second call while the first is pending is a no-op.
//      Replaces the manual `submitInFlightRef` pattern at multiple sites.
//   2. Surfaces `error` as React state so the caller can route it into a
//      <ResultDialog> (or banner / inline message). The codebase uses
//      <ResultDialog>; we deliberately don't introduce a new toast library.
//   3. Catches thrown errors and treats them like `{ success: false, error }`.
//      Server actions that hit network/permission errors mid-flight will throw
//      rather than return a typed result — the hook normalises both paths.
// ============================================================================

import { useCallback, useRef, useState } from 'react';

interface ServerActionResultLike {
  success?: boolean;
  error?: string;
}

export interface UseServerActionOptions<TResult> {
  /** Called only when the result indicates success. */
  onSuccess?: (result: TResult) => void;
  /** Surfaced when the action returns `{ success: false }` with no `error` string. */
  fallbackErrorMessage?: string;
}

export interface UseServerActionResult<TArgs extends unknown[], TResult> {
  /**
   * Execute the action. Returns the action's result, OR `null` if the call
   * was suppressed by the in-flight guard or if the action threw. Callers
   * that depend on the typed return value should null-check.
   */
  run: (...args: TArgs) => Promise<TResult | null>;
  isLoading: boolean;
  error: string | null;
  clearError: () => void;
}

export function useServerAction<TArgs extends unknown[], TResult extends ServerActionResultLike>(
  action: (...args: TArgs) => Promise<TResult>,
  options?: UseServerActionOptions<TResult>,
): UseServerActionResult<TArgs, TResult> {
  // Refs so that consumers passing inline { onSuccess: ..., fallbackErrorMessage: ... }
  // don't churn the `run` callback identity each render.
  const onSuccessRef = useRef(options?.onSuccess);
  onSuccessRef.current = options?.onSuccess;
  const fallbackErrorMessageRef = useRef(options?.fallbackErrorMessage);
  fallbackErrorMessageRef.current = options?.fallbackErrorMessage;
  const actionRef = useRef(action);
  actionRef.current = action;

  const inFlightRef = useRef(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (...args: TArgs): Promise<TResult | null> => {
      if (inFlightRef.current) return null;
      inFlightRef.current = true;
      setIsLoading(true);
      setError(null);
      try {
        const result = await actionRef.current(...args);
        if (result && result.success === false) {
          setError(result.error || fallbackErrorMessageRef.current || 'Operation failed');
        } else {
          onSuccessRef.current?.(result);
        }
        return result;
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Unexpected error';
        setError(msg);
        return null;
      } finally {
        inFlightRef.current = false;
        setIsLoading(false);
      }
    },
    [],
  );

  const clearError = useCallback(() => setError(null), []);

  return { run, isLoading, error, clearError };
}
