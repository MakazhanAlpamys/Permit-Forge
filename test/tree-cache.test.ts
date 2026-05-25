// ============================================================================
// E9b — lib/tree-cache.ts coverage
// ============================================================================
// Two-tier cache:
//   L1: in-memory Map with TTL
//   L2: document_trees table in Supabase
// Tests:
//   - L1 hit short-circuits the DB
//   - stale L1 + unchanged updated_at refreshes TTL without re-fetching JSONB
//   - missing row falls back to RPC, then to stale cache, then to []
//   - getAllCachedDocumentTrees populates the L1 map from a single SELECT
//   - clearDocumentTreeCache scoping
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSingle = vi.fn();
const mockEq = vi.fn();
const mockSelect = vi.fn();
const mockRpc = vi.fn();
const mockFromTrees = vi.fn();

vi.mock('@/lib/supabase-server', () => ({
  createAdminClient: () => ({
    from: (_table: string) => mockFromTrees(_table),
    rpc: (...args: unknown[]) => mockRpc(...args),
  }),
}));

function resetChain() {
  mockSingle.mockResolvedValue({ data: null, error: null });
  mockEq.mockReturnValue({ single: mockSingle, then: undefined });
  mockSelect.mockReturnValue({ eq: mockEq });
  mockFromTrees.mockReturnValue({ select: mockSelect });
  mockRpc.mockResolvedValue({ data: null, error: null });
}

async function freshModule() {
  vi.resetModules();
  resetChain();
  return await import('@/lib/tree-cache');
}

beforeEach(() => {
  vi.clearAllMocks();
  resetChain();
});

const sampleTree = [
  { title: 'Chapter 1', startPage: 1, endPage: 10, children: [] },
];

// ----------------------------------------------------------------------------
// getCachedDocumentTree
// ----------------------------------------------------------------------------

describe('getCachedDocumentTree', () => {
  it('returns L1 hit without any DB call when within TTL', async () => {
    const mod = await freshModule();
    // Seed cache.
    mod._seedCache(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { data: sampleTree as any, updatedAt: '2025-01-01T00:00:00Z', cachedAt: Date.now() },
      'doc-a',
    );

    const out = await mod.getCachedDocumentTree('doc-a');
    expect(out).toEqual(sampleTree);
    expect(mockFromTrees).not.toHaveBeenCalled();
  });

  it('refreshes TTL only when L1 is stale but L2 updated_at is unchanged', async () => {
    const mod = await freshModule();
    // Seed an entry whose cachedAt is older than TTL (using a far-past time).
    mod._seedCache(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { data: sampleTree as any, updatedAt: '2025-01-01T00:00:00Z', cachedAt: 0 },
      'doc-a',
    );

    // First DB call: lightweight updated_at SELECT — returns unchanged ts.
    mockSingle.mockResolvedValueOnce({
      data: { updated_at: '2025-01-01T00:00:00Z' },
      error: null,
    });

    const out = await mod.getCachedDocumentTree('doc-a');
    expect(out).toEqual(sampleTree);
    // Only the metadata SELECT — not the full JSONB fetch.
    expect(mockSelect).toHaveBeenCalledTimes(1);
    expect(mockSelect).toHaveBeenCalledWith('updated_at');
  });

  it('re-fetches full JSONB when L1 stale and updated_at changed', async () => {
    const mod = await freshModule();
    mod._seedCache(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { data: sampleTree as any, updatedAt: '2025-01-01T00:00:00Z', cachedAt: 0 },
      'doc-a',
    );

    // 1st single: updated_at check returns a NEWER timestamp.
    mockSingle.mockResolvedValueOnce({
      data: { updated_at: '2025-06-01T00:00:00Z' },
      error: null,
    });
    // 2nd single: full payload fetch.
    mockSingle.mockResolvedValueOnce({
      data: {
        tree_data: [{ title: 'Chapter 2', startPage: 11, endPage: 20, children: [] }],
        updated_at: '2025-06-01T00:00:00Z',
      },
      error: null,
    });

    const out = await mod.getCachedDocumentTree('doc-a');
    expect(out[0].title).toBe('Chapter 2');
    expect(mockSelect).toHaveBeenCalledWith('updated_at');
    expect(mockSelect).toHaveBeenCalledWith('tree_data, updated_at');
  });

  it('falls back to RPC when document_trees has no row', async () => {
    const mod = await freshModule();
    // No prior cache.
    mockSingle.mockResolvedValueOnce({
      data: null,
      error: { message: 'no rows' },
    });
    mockRpc.mockResolvedValueOnce({
      data: sampleTree,
      error: null,
    });

    const out = await mod.getCachedDocumentTree('doc-new');
    expect(out).toEqual(sampleTree);
    expect(mockRpc).toHaveBeenCalledWith('get_document_tree', {
      p_document_name: 'doc-new',
    });
  });

  it('returns [] when neither the table nor the RPC has data and no cache', async () => {
    const mod = await freshModule();
    mockSingle.mockResolvedValueOnce({
      data: null,
      error: { message: 'no rows' },
    });
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'rpc not found' },
    });

    const out = await mod.getCachedDocumentTree('doc-nope');
    expect(out).toEqual([]);
  });

  it('returns stale cache when both DB and RPC fail', async () => {
    const mod = await freshModule();
    mod._seedCache(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { data: sampleTree as any, updatedAt: '2025-01-01T00:00:00Z', cachedAt: 0 },
      'doc-a',
    );

    // updated_at check fails → goes to full fetch
    mockSingle.mockResolvedValueOnce({ data: null, error: { message: 'down' } });
    // full fetch fails → tries RPC
    mockSingle.mockResolvedValueOnce({ data: null, error: { message: 'down' } });
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'rpc down' } });

    const out = await mod.getCachedDocumentTree('doc-a');
    expect(out).toEqual(sampleTree);
  });

  it('returns stale cache when the call throws entirely', async () => {
    const mod = await freshModule();
    mod._seedCache(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { data: sampleTree as any, updatedAt: '2025-01-01T00:00:00Z', cachedAt: 0 },
      'doc-a',
    );
    mockFromTrees.mockImplementationOnce(() => {
      throw new Error('boom');
    });

    const out = await mod.getCachedDocumentTree('doc-a');
    expect(out).toEqual(sampleTree);
  });
});

// ----------------------------------------------------------------------------
// getAllCachedDocumentTrees
// ----------------------------------------------------------------------------

describe('getAllCachedDocumentTrees', () => {
  it('returns a map populated from a single SELECT', async () => {
    const mod = await freshModule();
    // For this path the chain is just from().select() returning a thenable.
    mockSelect.mockReturnValueOnce(
      Promise.resolve({
        data: [
          { document_name: 'doc-a', tree_data: sampleTree, updated_at: '2025-01-01T00:00:00Z' },
          { document_name: 'doc-b', tree_data: [], updated_at: '2025-01-02T00:00:00Z' },
        ],
        error: null,
      }),
    );

    const out = await mod.getAllCachedDocumentTrees();
    expect(out.get('doc-a')).toEqual(sampleTree);
    expect(out.get('doc-b')).toEqual([]);
    expect(out.size).toBe(2);
  });

  it('returns current cache snapshot when the SELECT errors', async () => {
    const mod = await freshModule();
    mod._seedCache(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { data: sampleTree as any, updatedAt: '2025-01-01', cachedAt: Date.now() },
      'doc-a',
    );
    mockSelect.mockReturnValueOnce(
      Promise.resolve({ data: null, error: { message: 'down' } }),
    );

    const out = await mod.getAllCachedDocumentTrees();
    expect(out.get('doc-a')).toEqual(sampleTree);
  });
});

// ----------------------------------------------------------------------------
// clearDocumentTreeCache
// ----------------------------------------------------------------------------

describe('clearDocumentTreeCache', () => {
  it('clears just one entry when given a document name', async () => {
    const mod = await freshModule();
    mod._seedCache(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { data: sampleTree as any, updatedAt: 'x', cachedAt: Date.now() },
      'doc-a',
    );

    mod.clearDocumentTreeCache('doc-a');

    // After clearing, next get with no DB row falls through to [] (no stale cache).
    mockSingle.mockResolvedValueOnce({ data: null, error: { message: 'gone' } });
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'gone' } });
    const out = await mod.getCachedDocumentTree('doc-a');
    expect(out).toEqual([]);
  });

  it('clears every entry when called with no argument', async () => {
    const mod = await freshModule();
    mod._seedCache(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { data: sampleTree as any, updatedAt: 'x', cachedAt: Date.now() },
      'doc-a',
    );

    mod.clearDocumentTreeCache();
    expect(mod._getCacheState()).toBeNull();
  });
});

// ----------------------------------------------------------------------------
// A-H-3 / v1.7.0 Part B: LRU eviction + dead-entry pruning
// ----------------------------------------------------------------------------

describe('LRU eviction (A-H-3)', () => {
  it('evicts the oldest entry when the cache exceeds MAX_CACHED_DOCS', async () => {
    const mod = await freshModule();
    const max = mod.MAX_CACHED_DOCS;
    expect(typeof max).toBe('number');
    expect(max).toBeGreaterThan(0);

    // Pre-populate the cache up to the cap.
    for (let i = 0; i < max; i++) {
      mod._setCacheEntry(`doc-${i}`, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: sampleTree as any,
        updatedAt: 'x',
        cachedAt: Date.now() + i, // each later entry is newer
      });
    }
    expect(mod._cacheSize()).toBe(max);

    // Adding one more must evict the oldest (doc-0).
    mod._setCacheEntry('doc-new', {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: sampleTree as any,
      updatedAt: 'x',
      cachedAt: Date.now() + max,
    });
    expect(mod._cacheSize()).toBe(max);
    expect(mod._hasCacheEntry('doc-0')).toBe(false);
    expect(mod._hasCacheEntry('doc-new')).toBe(true);
  });
});

describe('dead-entry pruning (A-L-2)', () => {
  it('drops cache entries for documents not in the L2 SELECT result', async () => {
    const mod = await freshModule();
    // Seed entries for two docs.
    mod._setCacheEntry('doc-a', {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: sampleTree as any,
      updatedAt: 'x',
      cachedAt: Date.now(),
    });
    mod._setCacheEntry('doc-ghost', {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: sampleTree as any,
      updatedAt: 'x',
      cachedAt: Date.now(),
    });
    expect(mod._cacheSize()).toBe(2);

    // L2 returns only doc-a — doc-ghost was deleted from the registry.
    mockSelect.mockReturnValueOnce(
      Promise.resolve({
        data: [
          { document_name: 'doc-a', tree_data: sampleTree, updated_at: '2025-06-01T00:00:00Z' },
        ],
        error: null,
      }),
    );

    await mod.getAllCachedDocumentTrees();

    expect(mod._hasCacheEntry('doc-a')).toBe(true);
    expect(mod._hasCacheEntry('doc-ghost')).toBe(false);
  });
});
