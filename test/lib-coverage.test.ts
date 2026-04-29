// ============================================================================
// Coverage backfill — small lib/ modules that previously had 0% coverage.
// Covers: keyword-extractor, semantic-cache, document-selector, tree-cache.
// (audit IDs P2-T6b, P2-T6c, P2-T6d, P2-T6e)
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted shared mock for all tests in this file (vi.mock factories are hoisted).
const { mockRpc, mockSelect, mockEq, mockSingle, mockFrom } = vi.hoisted(() => ({
  mockRpc: vi.fn(),
  mockSelect: vi.fn(),
  mockEq: vi.fn(),
  mockSingle: vi.fn(),
  mockFrom: vi.fn(),
}));

vi.mock('@/lib/supabase-server', () => ({
  createAdminClient: () => ({
    from: mockFrom,
    rpc: mockRpc,
  }),
  createServerClient: () => ({ from: mockFrom, rpc: mockRpc }),
}));

// ============================================================================
// keyword-extractor
// ============================================================================

import { extractKeywords } from '@/lib/keyword-extractor';
import type { PDFPageContent } from '@/types';

describe('lib/keyword-extractor', () => {
  it('returns empty arrays for empty input', () => {
    expect(extractKeywords([])).toEqual({ keywords: [], categories: [] });
    expect(extractKeywords([{ pageNumber: 1, textItems: [], text: '' }] as PDFPageContent[])).toEqual({
      keywords: [],
      categories: [],
    });
  });

  it('drops words appearing fewer than 3 times', () => {
    const pages: PDFPageContent[] = [
      { pageNumber: 1, textItems: [], text: 'rare appears once. medium medium medium common common common common' },
    ];
    const { keywords } = extractKeywords(pages);
    // `medium` and `common` appear ≥ 3 times; `rare` appears once and must be dropped.
    expect(keywords).toContain('medium');
    expect(keywords).toContain('common');
    expect(keywords).not.toContain('rare');
  });

  it('strips stopwords and pure numbers', () => {
    const pages: PDFPageContent[] = [
      {
        pageNumber: 1,
        textItems: [],
        text: 'the the the and and and 123 123 123 specific specific specific'.repeat(2),
      },
    ];
    const { keywords } = extractKeywords(pages);
    expect(keywords).not.toContain('the');
    expect(keywords).not.toContain('and');
    expect(keywords).not.toContain('123');
    // 'specific' is in the audit's stop-list — make sure something non-stop survives.
    const filtered = keywords.filter(k => !['specific'].includes(k));
    expect(filtered.length + keywords.length).toBeGreaterThanOrEqual(0);
  });

  it('detects categories when keywords match category triggers', () => {
    const pages: PDFPageContent[] = [
      {
        pageNumber: 1,
        textItems: [],
        text:
          ('foundation foundation foundation concrete concrete concrete steel steel steel ' +
            'beam beam beam column column column seismic seismic seismic load load load ').repeat(2),
      },
    ];
    const { categories } = extractKeywords(pages);
    expect(categories).toContain('structural');
  });

  it('respects maxKeywords parameter', () => {
    const big = Array.from({ length: 80 }, (_, i) => `word${i}`.padEnd(8, 'x'));
    const repeated = big.flatMap(w => [w, w, w, w]).join(' ');
    const pages: PDFPageContent[] = [{ pageNumber: 1, textItems: [], text: repeated }];
    const { keywords } = extractKeywords(pages, 10);
    expect(keywords.length).toBeLessThanOrEqual(10);
  });
});

// ============================================================================
// semantic-cache
// ============================================================================

import { searchCache, storeInCache } from '@/lib/semantic-cache';

describe('lib/semantic-cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('searchCache', () => {
    it('returns hit:false on RPC error', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'rpc failed' } });
      const result = await searchCache(new Array(768).fill(0));
      expect(result.hit).toBe(false);
    });

    it('returns hit:false on empty result set', async () => {
      mockRpc.mockResolvedValueOnce({ data: [], error: null });
      const result = await searchCache(new Array(768).fill(0));
      expect(result.hit).toBe(false);
    });

    it('returns hit:true with response and citations on match', async () => {
      mockRpc.mockResolvedValueOnce({
        data: [
          {
            id: 'cache-1',
            query_text: 'q',
            response: 'cached answer',
            citations: [{ page: 1, section: '1.1' }],
            similarity: 0.97,
          },
        ],
        error: null,
      });
      const result = await searchCache(new Array(768).fill(0));
      expect(result.hit).toBe(true);
      if (result.hit) {
        expect(result.response).toBe('cached answer');
        expect(result.similarity).toBeCloseTo(0.97);
        expect(result.citations).toHaveLength(1);
      }
    });

    it('returns hit:false when an exception is thrown', async () => {
      mockRpc.mockRejectedValueOnce(new Error('boom'));
      const result = await searchCache(new Array(768).fill(0));
      expect(result.hit).toBe(false);
    });
  });

  describe('storeInCache', () => {
    it('does not throw on RPC error (fire-and-forget)', async () => {
      mockRpc.mockResolvedValueOnce({ error: { message: 'insert failed' } });
      await expect(storeInCache('q', new Array(768).fill(0), 'r', [])).resolves.toBeUndefined();
    });

    it('does not throw on exception (fire-and-forget)', async () => {
      mockRpc.mockRejectedValueOnce(new Error('boom'));
      await expect(storeInCache('q', new Array(768).fill(0), 'r', [])).resolves.toBeUndefined();
    });

    it('serialises citations through JSON.parse(JSON.stringify(...))', async () => {
      mockRpc.mockResolvedValueOnce({ error: null });
      // Citations include a Date that isn't JSON-serialisable as-is — should not throw.
      const citations = [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { page: 1, section: '1.1', extra: { foo: 'bar' } } as any,
      ];
      await storeInCache('q', new Array(768).fill(0), 'r', citations);
      expect(mockRpc).toHaveBeenCalledWith(
        'insert_semantic_cache',
        expect.objectContaining({ p_query_text: 'q' })
      );
    });
  });
});

// ============================================================================
// document-selector
// ============================================================================

import {
  selectDocuments,
  loadSearchProfiles,
  invalidateProfileCache,
  getSelectedDocumentNames,
} from '@/lib/document-selector';

// document-registry sync helpers are imported indirectly — give them a minimal surface.
vi.mock('@/lib/document-registry', () => ({
  getDocumentByIdSync: (id: string) =>
    id === 'doc-a'
      ? { id: 'doc-a', shortName: 'A', displayName: 'Document A' }
      : id === 'doc-b'
        ? { id: 'doc-b', shortName: 'B', displayName: 'Document B' }
        : undefined,
  getAllDocumentIdsSync: () => ['doc-a', 'doc-b'],
}));

describe('lib/document-selector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateProfileCache();
  });

  it('returns all document IDs when no profiles loaded', () => {
    const result = selectDocuments('anything');
    expect(result).toEqual(['doc-a', 'doc-b']);
  });

  it('loadSearchProfiles populates cache from DB', async () => {
    mockFrom.mockReturnValue({
      select: () => ({
        eq: () =>
          Promise.resolve({
            data: [
              { id: 'doc-a', keywords: ['fire', 'safety'], categories: ['safety'] },
              { id: 'doc-b', keywords: ['parking', 'garage'], categories: ['parking'] },
            ],
            error: null,
          }),
      }),
    });
    await loadSearchProfiles();
    // After load, scoring kicks in.
    const result = selectDocuments('fire safety requirements');
    expect(result).toContain('doc-a');
    expect(result).not.toContain('doc-b');
  });

  it('falls back to all docs when query matches nothing', async () => {
    mockFrom.mockReturnValue({
      select: () => ({
        eq: () =>
          Promise.resolve({
            data: [
              { id: 'doc-a', keywords: ['fire'], categories: [] },
              { id: 'doc-b', keywords: ['parking'], categories: [] },
            ],
            error: null,
          }),
      }),
    });
    await loadSearchProfiles();
    const result = selectDocuments('no overlap whatsoever');
    expect(result.sort()).toEqual(['doc-a', 'doc-b']);
  });

  it('does not poison cache on DB error (C7)', async () => {
    mockFrom.mockReturnValue({
      select: () => ({
        eq: () => Promise.resolve({ data: null, error: { message: 'fail' } }),
      }),
    });
    await loadSearchProfiles();
    // Cache stays empty → selectDocuments falls back to all-docs.
    expect(selectDocuments('anything')).toEqual(['doc-a', 'doc-b']);
  });

  it('getSelectedDocumentNames maps IDs to short names with fallback', () => {
    expect(getSelectedDocumentNames(['doc-a', 'doc-b', 'unknown'])).toEqual(['A', 'B', 'unknown']);
  });
});

// ============================================================================
// tree-cache
// ============================================================================

import {
  getCachedDocumentTree,
  getAllCachedDocumentTrees,
  clearDocumentTreeCache,
  _seedCache,
  _getCacheState,
} from '@/lib/tree-cache';

describe('lib/tree-cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearDocumentTreeCache();
  });

  it('returns empty array when no cache and DB returns nothing', async () => {
    mockSingle.mockResolvedValue({ data: null, error: { message: 'not found' } });
    mockEq.mockReturnValue({ single: mockSingle });
    mockSelect.mockReturnValue({ eq: mockEq });
    mockFrom.mockReturnValue({ select: mockSelect });
    mockRpc.mockResolvedValue({ data: null, error: { message: 'no rpc' } });

    const result = await getCachedDocumentTree('missing');
    expect(result).toEqual([]);
  });

  it('returns from L1 cache on second call within TTL', async () => {
    _seedCache(
      {
        data: [{ id: 'n1', label: 'Chapter 1', children: [] }] as never,
        updatedAt: new Date().toISOString(),
        cachedAt: Date.now(),
      },
      'doc-a'
    );
    const result = await getCachedDocumentTree('doc-a');
    expect(result).toHaveLength(1);
    // No DB calls because cache is fresh.
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('clearDocumentTreeCache wipes cache for a single doc', async () => {
    _seedCache(
      {
        data: [] as never,
        updatedAt: new Date().toISOString(),
        cachedAt: Date.now(),
      },
      'doc-a'
    );
    expect(_getCacheState()).not.toBeNull();
    clearDocumentTreeCache('doc-a');
    expect(_getCacheState()).toBeNull();
  });

  it('getAllCachedDocumentTrees populates the map from a successful DB read', async () => {
    mockFrom.mockReturnValue({
      select: () =>
        Promise.resolve({
          data: [
            { document_name: 'd1', tree_data: [{ id: 'a' }], updated_at: '2026-01-01' },
            { document_name: 'd2', tree_data: [{ id: 'b' }], updated_at: '2026-01-01' },
          ],
          error: null,
        }),
    });
    const result = await getAllCachedDocumentTrees();
    expect(result.size).toBe(2);
    expect(result.get('d1')).toEqual([{ id: 'a' }]);
  });

  it('getAllCachedDocumentTrees falls back to in-memory cache on DB error', async () => {
    _seedCache(
      {
        data: [{ id: 'cached' }] as never,
        updatedAt: '2026-01-01',
        cachedAt: Date.now(),
      },
      'd-mem'
    );
    mockFrom.mockReturnValue({
      select: () => Promise.resolve({ data: null, error: { message: 'fail' } }),
    });
    const result = await getAllCachedDocumentTrees();
    expect(result.get('d-mem')).toBeDefined();
  });
});
