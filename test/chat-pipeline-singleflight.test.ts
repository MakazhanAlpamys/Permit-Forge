// ============================================================================
// X18 — chat-pipeline singleflight coverage
// ============================================================================
// Verifies that N concurrent identical queries collapse to ONE pipeline run
// (one embedding + one cache lookup) instead of fanning out.
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ----------------------------------------------------------------------------
// Mocks — keep the pipeline collaborators inert so the test is a pure unit
// test of the singleflight wrapper.
// ----------------------------------------------------------------------------

const mockGenerateEmbedding = vi.fn();
vi.mock('@/lib/gemini', () => ({
  generateEmbedding: (q: string) => mockGenerateEmbedding(q),
  DailyQuotaExhaustedError: class extends Error {},
}));

vi.mock('@/lib/document-registry', () => ({
  getAllDocuments: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/lib/document-selector', () => ({
  loadSearchProfiles: vi.fn().mockResolvedValue(undefined),
  selectDocuments: vi.fn().mockReturnValue([]),
  getSelectedDocumentNames: vi.fn().mockReturnValue([]),
}));

vi.mock('@/lib/scope-detector', () => ({
  detectScope: vi.fn().mockReturnValue({ hasScope: false, pageRanges: [] }),
}));

const mockSearchCache = vi.fn();
vi.mock('@/lib/semantic-cache', () => ({
  searchCache: (...args: unknown[]) => mockSearchCache(...args),
  storeInCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/tree-cache', () => ({
  getAllCachedDocumentTrees: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock('@/lib/rag', () => ({
  queryBuildingCode: vi.fn().mockResolvedValue({ chunks: [] }),
  queryBuildingCodeFiltered: vi.fn().mockResolvedValue({ chunks: [] }),
  passesCRAGCheck: vi.fn().mockReturnValue(false),
  expandToParentChunks: vi.fn().mockImplementation(async (c) => c),
  buildContext: vi.fn().mockReturnValue(''),
}));

vi.mock('@/lib/agents', () => ({
  classifyTopic: vi.fn(),
  classifyQueryStructure: vi.fn().mockReturnValue({ isStructural: false, suggestedPath: 'standard' }),
  treeReasoner: vi.fn(),
  getPageRangesForNodes: vi.fn().mockReturnValue([]),
}));

vi.mock('@/lib/citation-parser', () => ({
  createChunkCitations: vi.fn().mockReturnValue([]),
  getCitationStats: vi.fn().mockReturnValue({ total: 0, uniquePages: 0, uniqueSections: 0 }),
}));

vi.mock('@/lib/heuristic-reranker', () => ({
  heuristicRerank: vi.fn().mockImplementation((_q, chunks) => chunks),
}));

import { executeRAGPipeline, _inflightPipelineCount } from '@/lib/chat-pipeline';

beforeEach(() => {
  vi.clearAllMocks();
  // Default: cache miss + slow embedding so concurrent callers have time to
  // dedupe on the same in-flight promise.
  mockSearchCache.mockResolvedValue({ hit: false });
  mockGenerateEmbedding.mockImplementation(
    () =>
      new Promise<number[]>((resolve) => {
        setTimeout(() => resolve(new Array(768).fill(0.1)), 20);
      }),
  );
});

describe('executeRAGPipeline — singleflight (X18)', () => {
  it('collapses 5 concurrent identical queries to one pipeline run', async () => {
    const results = await Promise.all([
      executeRAGPipeline('what is fire safety?'),
      executeRAGPipeline('what is fire safety?'),
      executeRAGPipeline('what is fire safety?'),
      executeRAGPipeline('what is fire safety?'),
      executeRAGPipeline('what is fire safety?'),
    ]);

    // All 5 callers got the same result object…
    expect(results).toHaveLength(5);
    for (const r of results) {
      expect(r).toBe(results[0]);
    }
    // …but generateEmbedding only fired once.
    expect(mockGenerateEmbedding).toHaveBeenCalledTimes(1);
    expect(mockSearchCache).toHaveBeenCalledTimes(1);
  });

  it('deduplicates whitespace + casing variations of the same query', async () => {
    const results = await Promise.all([
      executeRAGPipeline('FIRE safety'),
      executeRAGPipeline('  fire  safety  '),
      executeRAGPipeline('fire safety'),
    ]);
    expect(results[0]).toBe(results[1]);
    expect(results[1]).toBe(results[2]);
    expect(mockGenerateEmbedding).toHaveBeenCalledTimes(1);
  });

  it('runs a fresh pipeline for distinct queries', async () => {
    const [a, b] = await Promise.all([
      executeRAGPipeline('fire safety'),
      executeRAGPipeline('parking compliance'),
    ]);
    expect(a).not.toBe(b);
    expect(mockGenerateEmbedding).toHaveBeenCalledTimes(2);
  });

  it('clears the in-flight slot after the promise settles', async () => {
    await executeRAGPipeline('how tall can a building be?');
    expect(_inflightPipelineCount()).toBe(0);
  });

  it('clears the in-flight slot even when the pipeline throws', async () => {
    mockGenerateEmbedding.mockRejectedValueOnce(new Error('embedding api down'));
    // Pipeline catches its own embedding error and returns an empty result —
    // but if a future caller hits the same query, the singleflight slot
    // must be free so the embedding can be retried.
    await executeRAGPipeline('broken-query');
    expect(_inflightPipelineCount()).toBe(0);
  });

  it('next call after a settled in-flight runs the pipeline fresh', async () => {
    await executeRAGPipeline('first query');
    expect(mockGenerateEmbedding).toHaveBeenCalledTimes(1);

    await executeRAGPipeline('first query');
    // No longer in-flight when the second call started → second embedding fired.
    expect(mockGenerateEmbedding).toHaveBeenCalledTimes(2);
  });
});
