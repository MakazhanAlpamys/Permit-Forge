// ============================================================================
// E6 — lib/document-selector.ts coverage
// ============================================================================
// Complements test/document-selector-cache.test.ts (B2 error paths) with
// scoring + selection + name-mapping coverage.

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

// Stub registry — we only need sync lookups.
vi.mock('@/lib/document-registry', () => ({
  getDocumentByIdSync: vi.fn((id: string) => {
    if (id === 'doc-a') return { displayName: 'Doc A', shortName: 'A' };
    if (id === 'doc-b') return { displayName: 'Doc B', shortName: 'B' };
    if (id === 'doc-c') return { displayName: 'Doc C', shortName: 'C' };
    return undefined;
  }),
  getAllDocumentIdsSync: vi.fn(() => ['doc-a', 'doc-b']),
}));

async function freshModule() {
  vi.resetModules();
  resetChain();
  return await import('@/lib/document-selector');
}

beforeEach(() => {
  vi.clearAllMocks();
  resetChain();
});

// ----------------------------------------------------------------------------
// Profile load + selectDocuments
// ----------------------------------------------------------------------------

describe('selectDocuments scoring', () => {
  it('returns ALL document ids when profiles are not loaded yet', async () => {
    const sel = await freshModule();
    const out = sel.selectDocuments('anything about concrete');
    // getAllDocumentIdsSync mock returns the fallback array.
    expect(out).toEqual(['doc-a', 'doc-b']);
  });

  it('picks the single best document when one has clear keyword hits', async () => {
    const sel = await freshModule();
    mockEq.mockResolvedValueOnce({
      data: [
        { id: 'doc-a', keywords: ['concrete', 'reinforcement'], categories: ['structural'] },
        { id: 'doc-b', keywords: ['glass', 'aluminum'], categories: ['envelope'] },
      ],
      error: null,
    });
    await sel.loadSearchProfiles();

    expect(sel.selectDocuments('what are concrete reinforcement rules?')).toEqual(['doc-a']);
  });

  it('returns ALL profile ids when nothing matches (zero score)', async () => {
    const sel = await freshModule();
    mockEq.mockResolvedValueOnce({
      data: [
        { id: 'doc-a', keywords: ['concrete'], categories: ['structural'] },
        { id: 'doc-b', keywords: ['glass'], categories: ['envelope'] },
      ],
      error: null,
    });
    await sel.loadSearchProfiles();

    const out = sel.selectDocuments('a completely unrelated topic');
    expect(out.sort()).toEqual(['doc-a', 'doc-b']);
  });

  it('returns ALL ids when 4+ documents score above threshold', async () => {
    const sel = await freshModule();
    // All four docs have the same keyword → they all tie and exceed the 0.8
    // cutoff together, triggering the "too many selected → search all" branch.
    mockEq.mockResolvedValueOnce({
      data: [
        { id: 'doc-a', keywords: ['parking'], categories: [] },
        { id: 'doc-b', keywords: ['parking'], categories: [] },
        { id: 'doc-c', keywords: ['parking'], categories: [] },
        { id: 'doc-d', keywords: ['parking'], categories: [] },
      ],
      error: null,
    });
    await sel.loadSearchProfiles();

    const out = sel.selectDocuments('parking lot requirements');
    expect(out.sort()).toEqual(['doc-a', 'doc-b', 'doc-c', 'doc-d']);
  });

  it('keeps multiple docs within the 20% gap window', async () => {
    const sel = await freshModule();
    mockEq.mockResolvedValueOnce({
      data: [
        // doc-a hits 1 long keyword (>5 chars) → score 3
        { id: 'doc-a', keywords: ['parking'], categories: [] },
        // doc-b hits 1 long keyword → score 3 (tied with a)
        { id: 'doc-b', keywords: ['parking'], categories: [] },
        // doc-c misses → score 0
        { id: 'doc-c', keywords: ['ventilation'], categories: [] },
      ],
      error: null,
    });
    await sel.loadSearchProfiles();

    const out = sel.selectDocuments('parking rules');
    expect(out.sort()).toEqual(['doc-a', 'doc-b']);
  });
});

// ----------------------------------------------------------------------------
// Profile load dedup + cache lifecycle
// ----------------------------------------------------------------------------

describe('loadSearchProfiles caching', () => {
  it('deduplicates concurrent calls into a single DB hit', async () => {
    const sel = await freshModule();
    mockEq.mockResolvedValueOnce({
      data: [{ id: 'doc-a', keywords: ['x'], categories: [] }],
      error: null,
    });

    await Promise.all([
      sel.loadSearchProfiles(),
      sel.loadSearchProfiles(),
      sel.loadSearchProfiles(),
    ]);

    expect(mockFrom).toHaveBeenCalledTimes(1);
  });

  it('serves second call from cache when within TTL', async () => {
    const sel = await freshModule();
    mockEq.mockResolvedValueOnce({
      data: [{ id: 'doc-a', keywords: ['x'], categories: [] }],
      error: null,
    });
    await sel.loadSearchProfiles();
    await sel.loadSearchProfiles();

    expect(mockFrom).toHaveBeenCalledTimes(1);
  });

  it('re-loads after invalidateProfileCache', async () => {
    const sel = await freshModule();
    mockEq.mockResolvedValueOnce({
      data: [{ id: 'doc-a', keywords: ['x'], categories: [] }],
      error: null,
    });
    await sel.loadSearchProfiles();

    sel.invalidateProfileCache();

    mockEq.mockResolvedValueOnce({
      data: [{ id: 'doc-b', keywords: ['y'], categories: [] }],
      error: null,
    });
    await sel.loadSearchProfiles();
    expect(mockFrom).toHaveBeenCalledTimes(2);
    expect(sel.selectDocuments('y')).toEqual(['doc-b']);
  });
});

// ----------------------------------------------------------------------------
// getSelectedDocumentNames
// ----------------------------------------------------------------------------

describe('getSelectedDocumentNames', () => {
  it('maps known doc ids to their shortName', async () => {
    const sel = await freshModule();
    expect(sel.getSelectedDocumentNames(['doc-a', 'doc-b'])).toEqual(['A', 'B']);
  });

  it('falls back to the id when the registry has no entry', async () => {
    const sel = await freshModule();
    expect(sel.getSelectedDocumentNames(['unknown-id'])).toEqual(['unknown-id']);
  });
});
