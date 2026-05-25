/**
 * @vitest-environment jsdom
 */
// ============================================================================
// useServerAction — CP-C-2/CP-C-3 (v1.2.0 Part A).
//
// Unifies the "call a server action, surface the failure, guard against
// double-clicks" pattern. The hook does NOT render UI itself — it exposes
// `error` state that the caller wires into a <ResultDialog>.
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useServerAction } from '@/hooks/use-server-action';

describe('useServerAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the action result on success and leaves error null', async () => {
    const action = vi.fn().mockResolvedValue({ success: true, id: 'abc' });
    const { result } = renderHook(() => useServerAction(action));

    let r: unknown;
    await act(async () => {
      r = await result.current.run();
    });

    expect(action).toHaveBeenCalledTimes(1);
    expect((r as { success?: boolean })?.success).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it('captures error message on result.success === false', async () => {
    const action = vi.fn().mockResolvedValue({ success: false, error: 'Permit not found' });
    const { result } = renderHook(() => useServerAction(action));

    await act(async () => {
      await result.current.run();
    });

    expect(result.current.error).toBe('Permit not found');
  });

  it('captures error when action throws', async () => {
    const action = vi.fn().mockRejectedValue(new Error('Network down'));
    const { result } = renderHook(() => useServerAction(action));

    let r: unknown = 'sentinel';
    await act(async () => {
      r = await result.current.run();
    });

    expect(r).toBeNull();
    expect(result.current.error).toBe('Network down');
  });

  it('uses fallback error message when action returns shape with no error string', async () => {
    const action = vi.fn().mockResolvedValue({ success: false });
    const { result } = renderHook(() =>
      useServerAction(action, { fallbackErrorMessage: 'Could not save' }),
    );

    await act(async () => {
      await result.current.run();
    });

    expect(result.current.error).toBe('Could not save');
  });

  it('guards against double-invocation while in flight', async () => {
    let resolve!: (v: { success: boolean }) => void;
    const action = vi.fn().mockReturnValue(new Promise((res) => { resolve = res; }));
    const { result } = renderHook(() => useServerAction(action));

    // Fire two concurrent calls — only the first should reach the action.
    let firstResult: unknown;
    let secondResult: unknown;
    await act(async () => {
      const p1 = result.current.run();
      const p2 = result.current.run();
      resolve({ success: true });
      firstResult = await p1;
      secondResult = await p2;
    });

    expect(action).toHaveBeenCalledTimes(1);
    expect(firstResult).toEqual({ success: true });
    // Second call is a no-op (returns null)
    expect(secondResult).toBeNull();
  });

  it('passes arguments through to the action', async () => {
    const action = vi.fn().mockResolvedValue({ success: true });
    const { result } = renderHook(() => useServerAction(action));

    await act(async () => {
      await result.current.run('arg1', 42);
    });

    expect(action).toHaveBeenCalledWith('arg1', 42);
  });

  it('clearError resets the error state', async () => {
    const action = vi.fn().mockResolvedValue({ success: false, error: 'Boom' });
    const { result } = renderHook(() => useServerAction(action));

    await act(async () => {
      await result.current.run();
    });
    expect(result.current.error).toBe('Boom');

    act(() => {
      result.current.clearError();
    });

    expect(result.current.error).toBeNull();
  });

  it('calls onSuccess only on successful results', async () => {
    const onSuccess = vi.fn();
    const action = vi
      .fn()
      .mockResolvedValueOnce({ success: false, error: 'no' })
      .mockResolvedValueOnce({ success: true, id: 'x' });

    const { result } = renderHook(() => useServerAction(action, { onSuccess }));

    await act(async () => {
      await result.current.run();
    });
    expect(onSuccess).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.run();
    });

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(onSuccess).toHaveBeenCalledWith({ success: true, id: 'x' });
  });

  it('reports isLoading while the action is in flight', async () => {
    let resolve!: (v: { success: boolean }) => void;
    const action = vi.fn().mockReturnValue(new Promise((res) => { resolve = res; }));
    const { result } = renderHook(() => useServerAction(action));

    let pending: Promise<unknown> | undefined;
    act(() => {
      pending = result.current.run();
    });

    await waitFor(() => expect(result.current.isLoading).toBe(true));

    await act(async () => {
      resolve({ success: true });
      await pending;
    });

    expect(result.current.isLoading).toBe(false);
  });
});
