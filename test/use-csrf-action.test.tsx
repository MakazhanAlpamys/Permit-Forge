/**
 * @vitest-environment jsdom
 */
// ============================================================================
// useCsrfAction — B12: refetch CSRF and retry once on rejection.
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const mockGetCSRFTokenAction = vi.fn();

vi.mock('@/actions/auth', () => ({
  getCSRFTokenAction: (...args: unknown[]) => mockGetCSRFTokenAction(...args),
}));

import { useCsrfAction } from '@/hooks/use-csrf-action';

describe('useCsrfAction (B12)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches an initial CSRF token on mount', async () => {
    mockGetCSRFTokenAction.mockResolvedValue('csrf-initial');

    const { result } = renderHook(() => useCsrfAction());

    await waitFor(() => expect(result.current.csrfToken).toBe('csrf-initial'));
  });

  it('retries the action once when result.error mentions CSRF', async () => {
    mockGetCSRFTokenAction.mockResolvedValueOnce('csrf-old').mockResolvedValueOnce('csrf-fresh');

    const action = vi
      .fn()
      .mockResolvedValueOnce({ success: false, error: 'CSRF token invalid' })
      .mockResolvedValueOnce({ success: true });

    const { result } = renderHook(() => useCsrfAction());
    await waitFor(() => expect(result.current.csrfToken).toBe('csrf-old'));

    let actionResult: { success?: boolean; error?: string } | undefined;
    await act(async () => {
      actionResult = await result.current.runWithCsrf(action);
    });

    expect(action).toHaveBeenCalledTimes(2);
    expect(action).toHaveBeenNthCalledWith(1, 'csrf-old');
    expect(action).toHaveBeenNthCalledWith(2, 'csrf-fresh');
    expect(actionResult?.success).toBe(true);
    expect(result.current.csrfToken).toBe('csrf-fresh');
  });

  it('does not retry on non-CSRF errors', async () => {
    mockGetCSRFTokenAction.mockResolvedValue('csrf-initial');

    const action = vi.fn().mockResolvedValue({ success: false, error: 'Permit not found' });

    const { result } = renderHook(() => useCsrfAction());
    await waitFor(() => expect(result.current.csrfToken).toBe('csrf-initial'));

    await act(async () => {
      await result.current.runWithCsrf(action);
    });

    expect(action).toHaveBeenCalledTimes(1);
  });

  it('does not retry on success', async () => {
    mockGetCSRFTokenAction.mockResolvedValue('csrf-initial');

    const action = vi.fn().mockResolvedValue({ success: true });

    const { result } = renderHook(() => useCsrfAction());
    await waitFor(() => expect(result.current.csrfToken).toBe('csrf-initial'));

    await act(async () => {
      await result.current.runWithCsrf(action);
    });

    expect(action).toHaveBeenCalledTimes(1);
  });

  it('refreshCsrf manually replaces the token', async () => {
    mockGetCSRFTokenAction.mockResolvedValueOnce('csrf-initial').mockResolvedValueOnce('csrf-new');

    const { result } = renderHook(() => useCsrfAction());
    await waitFor(() => expect(result.current.csrfToken).toBe('csrf-initial'));

    let returned: string | null = null;
    await act(async () => {
      returned = await result.current.refreshCsrf();
    });

    expect(returned).toBe('csrf-new');
    expect(result.current.csrfToken).toBe('csrf-new');
  });
});
