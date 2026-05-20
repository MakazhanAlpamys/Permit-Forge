// ============================================================================
// lib/code-verification — extracted from actions/auth + actions/profile (F2)
// C15H: attempt counter is now DB-backed via incr_code_attempt RPC.
// ============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { safeEqual, checkCodeAttempts, resetCodeAttempts } from '@/lib/code-verification';
import { createAdminClient } from '@/lib/supabase-server';

describe('safeEqual', () => {
  it('returns true for equal strings', () => {
    expect(safeEqual('123456', '123456')).toBe(true);
  });

  it('returns false for unequal strings of the same length', () => {
    expect(safeEqual('123456', '123457')).toBe(false);
  });

  it('returns false for strings of different length (no length oracle)', () => {
    expect(safeEqual('1234', '12345')).toBe(false);
  });

  it('handles empty strings', () => {
    expect(safeEqual('', '')).toBe(true);
    expect(safeEqual('', '1')).toBe(false);
  });
});

describe('checkCodeAttempts / resetCodeAttempts (DB-backed)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true when the RPC reports allowed', async () => {
    const mockRpc = vi.fn().mockResolvedValue({
      data: [{ allowed: true, current_count: 1 }],
      error: null,
    });
    vi.mocked(createAdminClient).mockReturnValueOnce({
      rpc: mockRpc,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    expect(await checkCodeAttempts('verify:user-1')).toBe(true);
    expect(mockRpc).toHaveBeenCalledWith(
      'incr_code_attempt',
      expect.objectContaining({ p_key: 'verify:user-1' }),
    );
  });

  it('returns false when the RPC reports !allowed', async () => {
    const mockRpc = vi.fn().mockResolvedValue({
      data: [{ allowed: false, current_count: 6 }],
      error: null,
    });
    vi.mocked(createAdminClient).mockReturnValueOnce({
      rpc: mockRpc,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    expect(await checkCodeAttempts('verify:user-2')).toBe(false);
  });

  it('fails open on DB error', async () => {
    const mockRpc = vi.fn().mockResolvedValue({
      data: null,
      error: { message: 'connection refused' },
    });
    vi.mocked(createAdminClient).mockReturnValueOnce({
      rpc: mockRpc,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    expect(await checkCodeAttempts('verify:user-3')).toBe(true);
  });

  it('resetCodeAttempts calls clear_code_attempt RPC', async () => {
    const mockRpc = vi.fn().mockResolvedValue({ data: null, error: null });
    vi.mocked(createAdminClient).mockReturnValueOnce({
      rpc: mockRpc,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    await resetCodeAttempts('verify:user-4');
    expect(mockRpc).toHaveBeenCalledWith('clear_code_attempt', { p_key: 'verify:user-4' });
  });
});
