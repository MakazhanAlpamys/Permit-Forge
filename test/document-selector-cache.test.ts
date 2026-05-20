// ============================================================================
// Document Selector — profile cache behavior on DB error (B2 / C7)
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockEq = vi.fn();
const mockSelect = vi.fn();
const mockFrom = vi.fn();

function resetChain() {
  mockEq.mockResolvedValue({ data: [], error: null });
  mockSelect.mockReturnValue({ eq: mockEq });
  mockFrom.mockReturnValue({ select: mockSelect });
}

vi.mock('@/lib/supabase-server', () => ({
  createServerClient: vi.fn(() => ({ from: (...args: unknown[]) => mockFrom(...args) })),
  createAdminClient: vi.fn(() => ({ from: (...args: unknown[]) => mockFrom(...args) })),
}));

// document-registry is imported by document-selector for syncronous lookups;
// stub it so we don't accidentally trigger its own DB path.
vi.mock('@/lib/document-registry', () => ({
  getDocumentByIdSync: vi.fn(),
  getAllDocumentIdsSync: vi.fn(() => []),
}));

async function freshModule() {
  vi.resetModules();
  resetChain();
  return await import('@/lib/document-selector');
}

describe('document-selector profile cache — error path (B2 / C7)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChain();
  });

  it('does NOT mark cache as loaded when the DB returns an error', async () => {
    const sel = await freshModule();

    mockEq.mockResolvedValueOnce({ data: null, error: { message: 'timeout' } });
    await sel.loadSearchProfiles();

    // Cache must NOT be considered valid — next call must re-hit the DB.
    mockEq.mockResolvedValueOnce({
      data: [{ id: 'doc-a', keywords: ['concrete'], categories: ['structural'] }],
      error: null,
    });
    await sel.loadSearchProfiles();

    expect(mockFrom).toHaveBeenCalledTimes(2);
    // After the successful retry, selectDocuments should see the keyword.
    expect(sel.selectDocuments('concrete strength')).toEqual(['doc-a']);
  });

  it('does NOT mark cache as loaded when the DB query throws', async () => {
    const sel = await freshModule();

    mockEq.mockRejectedValueOnce(new Error('ECONNRESET'));
    await sel.loadSearchProfiles();

    mockEq.mockResolvedValueOnce({
      data: [{ id: 'doc-b', keywords: ['glass'], categories: ['envelope'] }],
      error: null,
    });
    await sel.loadSearchProfiles();

    expect(mockFrom).toHaveBeenCalledTimes(2);
    expect(sel.selectDocuments('glass facade')).toEqual(['doc-b']);
  });

  it('DOES cache a legitimate empty profile set (no rows, no error)', async () => {
    const sel = await freshModule();

    mockEq.mockResolvedValueOnce({ data: [], error: null });
    await sel.loadSearchProfiles();

    // Second call within TTL must serve from cache.
    await sel.loadSearchProfiles();
    expect(mockFrom).toHaveBeenCalledTimes(1);
  });
});
