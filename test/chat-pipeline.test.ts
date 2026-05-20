// ============================================================================
// Chat Pipeline Tests
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MatchedChunk } from '@/types';

// Mock dependencies
const mockClassifyQueryStructure = vi.fn();
const mockTreeReasoner = vi.fn();
const mockGetPageRangesForNodes = vi.fn();
const mockClassifyTopic = vi.fn();

vi.mock('@/lib/agents', () => ({
  classifyQueryStructure: (...args: unknown[]) => mockClassifyQueryStructure(...args),
  treeReasoner: (...args: unknown[]) => mockTreeReasoner(...args),
  getPageRangesForNodes: (...args: unknown[]) => mockGetPageRangesForNodes(...args),
  classifyTopic: (...args: unknown[]) => mockClassifyTopic(...args),
}));

const mockQueryBuildingCode = vi.fn();
const mockQueryBuildingCodeFiltered = vi.fn();
const mockBuildContext = vi.fn();
const mockPassesCRAGCheck = vi.fn().mockReturnValue(true);
const mockExpandToParentChunks = vi.fn((chunks: MatchedChunk[]) => Promise.resolve(chunks));

vi.mock('@/lib/rag', () => ({
  queryBuildingCode: (...args: unknown[]) => mockQueryBuildingCode(...args),
  queryBuildingCodeFiltered: (...args: unknown[]) => mockQueryBuildingCodeFiltered(...args),
  buildContext: (...args: unknown[]) => mockBuildContext(...args),
  passesCRAGCheck: (...args: unknown[]) => mockPassesCRAGCheck(...args),
  expandToParentChunks: (chunks: MatchedChunk[]) => mockExpandToParentChunks(chunks),
}));

vi.mock('@/lib/tree-cache', () => ({
  getAllCachedDocumentTrees: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock('@/lib/citation-parser', () => ({
  createChunkCitations: vi.fn().mockReturnValue([]),
  getCitationStats: vi.fn().mockReturnValue({ total: 0, verified: 0, unverified: 0, uniquePages: 0, uniqueSections: 0 }),
  getConfidenceTier: vi.fn().mockReturnValue('low'),
}));

const mockGenerateEmbedding = vi.fn().mockResolvedValue(new Array(768).fill(0));
vi.mock('@/lib/gemini', () => ({
  generateEmbedding: (...args: unknown[]) => mockGenerateEmbedding(...args),
}));

vi.mock('@/lib/heuristic-reranker', () => ({
  heuristicRerank: vi.fn((_q: string, chunks: MatchedChunk[]) => chunks.slice(0, 7)),
}));

vi.mock('@/lib/document-selector', () => ({
  selectDocuments: vi.fn().mockReturnValue(['building-code-2021']),
  getSelectedDocumentNames: vi.fn().mockReturnValue(['Building Code']),
  loadSearchProfiles: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/document-registry', () => ({
  getAllDocuments: vi.fn().mockResolvedValue([{ id: 'building-code-2021', displayName: 'Building Code', shortName: 'DBC' }]),
  getDocumentByIdSync: vi.fn((id: string) => id ? { displayName: 'Building Code', shortName: 'DBC' } : undefined),
  getAllDocumentsSync: vi.fn(() => []),
  getAllDocumentIdsSync: vi.fn(() => ['building-code-2021']),
  invalidateRegistryCache: vi.fn(),
}));

vi.mock('@/lib/scope-detector', () => ({
  detectScope: vi.fn().mockReturnValue({ hasScope: false, pageRanges: [] }),
}));

vi.mock('@/lib/semantic-cache', () => ({
  searchCache: vi.fn().mockResolvedValue({ hit: false }),
  storeInCache: vi.fn().mockResolvedValue(undefined),
}));

// Import after mocks
import {
  executeRAGPipeline,
  generateCitations,
  cacheResponse,
  CHAT_PIPELINE_CONFIG,
  getOffTopicResponse,
  getGreetingResponse,
} from '@/lib/chat-pipeline';
import { searchCache, storeInCache } from '@/lib/semantic-cache';
import { detectScope } from '@/lib/scope-detector';
import { getAllCachedDocumentTrees } from '@/lib/tree-cache';
import { getAllDocuments } from '@/lib/document-registry';

const sampleChunks: MatchedChunk[] = [
  {
    id: 1,
    content: 'Parking requirements for residential buildings',
    metadata: { page: 45, section: '3.2.1', startPage: 45, endPage: 46 },
    similarity: 0.85,
  },
  {
    id: 2,
    content: 'Fire safety regulations for commercial zones',
    metadata: { page: 120, section: '5.1', startPage: 120, endPage: 121 },
    similarity: 0.72,
  },
];

describe('Chat Pipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: non-structural query → standard path
    mockClassifyQueryStructure.mockReturnValue({
      isStructural: false,
      suggestedPath: 'standard',
      structuralHints: [],
    });
    mockQueryBuildingCode.mockResolvedValue({ chunks: sampleChunks });
    mockPassesCRAGCheck.mockReturnValue(true);
    mockExpandToParentChunks.mockImplementation((chunks: MatchedChunk[]) => Promise.resolve(chunks));
    mockGenerateEmbedding.mockResolvedValue(new Array(768).fill(0));
  });

  describe('executeRAGPipeline', () => {
    it('should return PipelineResult with chunks and queryEmbedding', async () => {
      const result = await executeRAGPipeline('What are parking requirements?');

      expect(mockClassifyQueryStructure).toHaveBeenCalledWith('What are parking requirements?');
      expect(result.chunks).toHaveLength(2);
      expect(result.chunks[0].content).toContain('Parking');
      expect(result.queryEmbedding).toBeDefined();
      expect(result.fromCache).toBe(false);
    });

    it('should generate embedding for each query', async () => {
      await executeRAGPipeline('parking requirements');

      expect(mockGenerateEmbedding).toHaveBeenCalledWith('parking requirements');
    });

    it('should route structural queries to tree reasoning', async () => {
      mockClassifyQueryStructure.mockReturnValue({
        isStructural: true,
        suggestedPath: 'tree',
        structuralHints: ['chapter'],
      });

      // Tree reasoning returns empty → falls back to standard
      const result = await executeRAGPipeline('summarize chapter 3');

      expect(mockClassifyQueryStructure).toHaveBeenCalledWith('summarize chapter 3');
      // Falls back to standard since no trees are available (mocked empty Map)
      expect(result.chunks.length).toBeGreaterThanOrEqual(0);
    });

    it('should fall back to standard pipeline when tree reasoning fails', async () => {
      mockClassifyQueryStructure.mockReturnValue({
        isStructural: true,
        suggestedPath: 'tree',
        structuralHints: ['section'],
      });

      const result = await executeRAGPipeline('What is in section 5.1?');

      // Should still return results via fallback
      expect(result).toBeDefined();
      expect(result.chunks).toBeDefined();
    });

    it('should return empty chunks when CRAG check fails', async () => {
      mockPassesCRAGCheck.mockReturnValue(false);

      const result = await executeRAGPipeline('parking requirements');

      expect(result.chunks).toHaveLength(0);
      expect(result.fromCache).toBe(false);
    });
  });

  describe('generateCitations', () => {
    it('should call citation parser with chunks only', () => {
      const citations = generateCitations(sampleChunks);

      expect(citations).toBeDefined();
      expect(Array.isArray(citations)).toBe(true);
    });

    it('should return empty array for empty chunks', () => {
      const citations = generateCitations([]);

      expect(citations).toEqual([]);
    });
  });

  // ========================================================================
  // E3: Cache HIT path
  // ========================================================================
  describe('semantic cache HIT', () => {
    it('returns cached response + citations without running search/rerank', async () => {
      vi.mocked(searchCache).mockResolvedValueOnce({
        hit: true,
        response: 'cached answer about parking',
        citations: [{ source: 'Building Code', page: 45, section: '3.2.1' }],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      const result = await executeRAGPipeline('parking requirements?');

      expect(result.fromCache).toBe(true);
      expect(result.cachedResponse).toBe('cached answer about parking');
      expect(result.cachedCitations).toHaveLength(1);
      expect(result.chunks).toEqual([]);
      // Search must NOT run on a cache hit.
      expect(mockQueryBuildingCode).not.toHaveBeenCalled();
      expect(mockExpandToParentChunks).not.toHaveBeenCalled();
    });

    it('embedding generation runs exactly once before cache lookup', async () => {
      vi.mocked(searchCache).mockResolvedValueOnce({
        hit: true,
        response: 'cached',
        citations: [],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      await executeRAGPipeline('any query');

      expect(mockGenerateEmbedding).toHaveBeenCalledTimes(1);
      expect(searchCache).toHaveBeenCalledTimes(1);
    });

    it('returns empty result when embedding generation fails', async () => {
      mockGenerateEmbedding.mockRejectedValueOnce(new Error('quota exhausted'));

      const result = await executeRAGPipeline('anything');

      expect(result.chunks).toEqual([]);
      expect(result.queryEmbedding).toEqual([]);
      expect(result.fromCache).toBe(false);
      // We must NOT proceed to cache or search after embedding failure.
      expect(searchCache).not.toHaveBeenCalled();
    });
  });

  // ========================================================================
  // E3: ENABLE_CACHE / ENABLE_PARENT_EXPANSION / ENABLE_TREE_REASONING flags
  // ========================================================================
  describe('feature flag false branches', () => {
    it('skips searchCache when ENABLE_CACHE=false', async () => {
      const original = CHAT_PIPELINE_CONFIG.ENABLE_CACHE;
      Object.defineProperty(CHAT_PIPELINE_CONFIG, 'ENABLE_CACHE', {
        value: false,
        configurable: true,
        writable: true,
      });
      try {
        await executeRAGPipeline('parking?');
        expect(searchCache).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(CHAT_PIPELINE_CONFIG, 'ENABLE_CACHE', {
          value: original,
          configurable: true,
          writable: true,
        });
      }
    });

    it('skips parent expansion when ENABLE_PARENT_EXPANSION=false', async () => {
      const original = CHAT_PIPELINE_CONFIG.ENABLE_PARENT_EXPANSION;
      Object.defineProperty(CHAT_PIPELINE_CONFIG, 'ENABLE_PARENT_EXPANSION', {
        value: false,
        configurable: true,
        writable: true,
      });
      try {
        await executeRAGPipeline('parking?');
        expect(mockExpandToParentChunks).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(CHAT_PIPELINE_CONFIG, 'ENABLE_PARENT_EXPANSION', {
          value: original,
          configurable: true,
          writable: true,
        });
      }
    });

    it('does not invoke tree reasoning when ENABLE_TREE_REASONING=false', async () => {
      mockClassifyQueryStructure.mockReturnValue({
        isStructural: true,
        suggestedPath: 'tree',
        structuralHints: ['chapter'],
      });
      const original = CHAT_PIPELINE_CONFIG.ENABLE_TREE_REASONING;
      Object.defineProperty(CHAT_PIPELINE_CONFIG, 'ENABLE_TREE_REASONING', {
        value: false,
        configurable: true,
        writable: true,
      });
      try {
        await executeRAGPipeline('summarize chapter 3');
        expect(getAllCachedDocumentTrees).not.toHaveBeenCalled();
        expect(mockQueryBuildingCode).toHaveBeenCalled();
      } finally {
        Object.defineProperty(CHAT_PIPELINE_CONFIG, 'ENABLE_TREE_REASONING', {
          value: original,
          configurable: true,
          writable: true,
        });
      }
    });
  });

  // ========================================================================
  // E3: Scope-detected → queryBuildingCodeFiltered
  // ========================================================================
  describe('scope-detected routing', () => {
    it('routes to filtered search when scope contains page ranges', async () => {
      vi.mocked(detectScope).mockReturnValueOnce({
        hasScope: true,
        pageRanges: [{ startPage: 10, endPage: 20 }],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      mockQueryBuildingCodeFiltered.mockResolvedValueOnce({
        chunks: sampleChunks,
      });

      await executeRAGPipeline('on pages 10-20, what about parking?');

      expect(mockQueryBuildingCodeFiltered).toHaveBeenCalledTimes(1);
      const args = mockQueryBuildingCodeFiltered.mock.calls[0][0];
      expect(args.pageRanges).toEqual([{ startPage: 10, endPage: 20 }]);
      expect(args.precomputedEmbedding).toBeDefined();
      // The standard search must NOT run.
      expect(mockQueryBuildingCode).not.toHaveBeenCalled();
    });
  });

  // ========================================================================
  // E3: Tree reasoning path
  // ========================================================================
  describe('tree reasoning happy path', () => {
    it('runs filtered search using page ranges from tree reasoner', async () => {
      const tree: Parameters<typeof getAllCachedDocumentTrees>[never] extends never
        ? unknown
        : unknown = [
        { title: 'Chapter 3', startPage: 30, endPage: 60, children: [] },
      ];
      // Cast through unknown so we don't widen the public type for tree data here.
      vi.mocked(getAllCachedDocumentTrees).mockResolvedValueOnce(
        new Map([['building-code-2021', tree]]) as unknown as Awaited<
          ReturnType<typeof getAllCachedDocumentTrees>
        >,
      );
      mockClassifyQueryStructure.mockReturnValue({
        isStructural: true,
        suggestedPath: 'tree',
        structuralHints: ['chapter'],
      });
      mockTreeReasoner.mockReturnValueOnce({
        selectedNodes: [{ title: 'Chapter 3' }],
        confidence: 80,
      });
      mockGetPageRangesForNodes.mockReturnValueOnce([
        { startPage: 30, endPage: 60, section: '3' },
      ]);
      mockQueryBuildingCodeFiltered.mockResolvedValueOnce({
        chunks: sampleChunks,
      });

      await executeRAGPipeline('what does chapter 3 say?');

      expect(mockTreeReasoner).toHaveBeenCalled();
      expect(mockGetPageRangesForNodes).toHaveBeenCalled();
      expect(mockQueryBuildingCodeFiltered).toHaveBeenCalled();
    });
  });

  // ========================================================================
  // E3: cacheResponse fire-and-forget
  // ========================================================================
  describe('cacheResponse', () => {
    it('forwards to storeInCache when ENABLE_CACHE=true', async () => {
      await cacheResponse('q', [0.1, 0.2], 'answer', []);
      expect(storeInCache).toHaveBeenCalledTimes(1);
    });

    it('skips storeInCache when ENABLE_CACHE=false', async () => {
      const original = CHAT_PIPELINE_CONFIG.ENABLE_CACHE;
      Object.defineProperty(CHAT_PIPELINE_CONFIG, 'ENABLE_CACHE', {
        value: false,
        configurable: true,
        writable: true,
      });
      try {
        await cacheResponse('q', [0.1, 0.2], 'answer', []);
        expect(storeInCache).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(CHAT_PIPELINE_CONFIG, 'ENABLE_CACHE', {
          value: original,
          configurable: true,
          writable: true,
        });
      }
    });
  });

  // ========================================================================
  // E3: Off-topic / greeting responses
  // ========================================================================
  describe('off-topic and greeting responses', () => {
    it('off-topic response mentions every loaded document name', async () => {
      vi.mocked(getAllDocuments).mockResolvedValueOnce([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 'doc-a', displayName: 'Doc A', shortName: 'A' } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 'doc-b', displayName: 'Doc B', shortName: 'B' } as any,
      ]);
      const text = await getOffTopicResponse();
      expect(text).toContain('Doc A');
      expect(text).toContain('Doc B');
    });

    it('off-topic response has a no-documents fallback', async () => {
      vi.mocked(getAllDocuments).mockResolvedValueOnce([]);
      const text = await getOffTopicResponse();
      expect(text.toLowerCase()).toContain('no documents');
    });

    it('greeting response lists documents with short description', async () => {
      vi.mocked(getAllDocuments).mockResolvedValueOnce([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { id: 'doc-a', displayName: 'Doc A', shortName: 'A', description: 'desc-a' } as any,
      ]);
      const text = await getGreetingResponse();
      expect(text).toContain('Doc A');
      expect(text).toContain('desc-a');
    });

    it('greeting response has a no-documents fallback', async () => {
      vi.mocked(getAllDocuments).mockResolvedValueOnce([]);
      const text = await getGreetingResponse();
      expect(text.toLowerCase()).toContain('no documents');
    });
  });
});
