// ============================================================================
// Document Registry — cache behavior on DB error (B2 / C7)
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockOrder = vi.fn();
const mockEq = vi.fn();
const mockSelect = vi.fn();
const mockFrom = vi.fn();

function resetChain() {
  mockOrder.mockResolvedValue({ data: [], error: null });
  mockEq.mockReturnValue({ order: mockOrder });
  mockSelect.mockReturnValue({ eq: mockEq });
  mockFrom.mockReturnValue({ select: mockSelect });
}

vi.mock('@/lib/supabase-server', () => ({
  createServerClient: vi.fn(() => ({ from: (...args: unknown[]) => mockFrom(...args) })),
  createAdminClient: vi.fn(() => ({ from: (...args: unknown[]) => mockFrom(...args) })),
}));

// Import after mocks so module-scope cache state is fresh-per-test
async function freshModule() {
  vi.resetModules();
  resetChain();
  return await import('@/lib/document-registry');
}

describe('document-registry cache — error path (B2 / C7)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChain();
  });

  it('does NOT cache an empty result when the DB returns an error', async () => {
    const reg = await freshModule();

    // First call: simulate DB error.
    mockOrder.mockResolvedValueOnce({ data: null, error: { message: 'connection refused' } });
    const first = await reg.getAllDocuments();
    expect(first).toEqual([]);

    // Second call: DB recovered. Cache from call 1 must NOT have been used.
    mockOrder.mockResolvedValueOnce({
      data: [
        {
          id: 'doc-a',
          display_name: 'Doc A',
          short_name: 'A',
          file_name: 'a.pdf',
          source_url: '',
          authority: '',
          description: '',
          badge_color: '',
        },
      ],
      error: null,
    });

    const second = await reg.getAllDocuments();
    expect(second).toHaveLength(1);
    expect(second[0].id).toBe('doc-a');
    // Both calls must have hit the DB — proving the error response was not cached.
    expect(mockFrom).toHaveBeenCalledTimes(2);
  });

  it('does NOT cache an empty result when the DB query throws', async () => {
    const reg = await freshModule();

    mockOrder.mockRejectedValueOnce(new Error('socket hang up'));
    const first = await reg.getAllDocuments();
    expect(first).toEqual([]);

    mockOrder.mockResolvedValueOnce({
      data: [
        {
          id: 'doc-b',
          display_name: 'Doc B',
          short_name: 'B',
          file_name: 'b.pdf',
          source_url: '',
          authority: '',
          description: '',
          badge_color: '',
        },
      ],
      error: null,
    });

    const second = await reg.getAllDocuments();
    expect(second).toHaveLength(1);
    expect(second[0].id).toBe('doc-b');
    expect(mockFrom).toHaveBeenCalledTimes(2);
  });

  it('DOES cache a legitimate empty result (no rows, no error)', async () => {
    const reg = await freshModule();

    mockOrder.mockResolvedValueOnce({ data: [], error: null });
    const first = await reg.getAllDocuments();
    expect(first).toEqual([]);

    // Second call within TTL — must serve from cache, no second DB hit.
    const second = await reg.getAllDocuments();
    expect(second).toEqual([]);
    expect(mockFrom).toHaveBeenCalledTimes(1);
  });
});
