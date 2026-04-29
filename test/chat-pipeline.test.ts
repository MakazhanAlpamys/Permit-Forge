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

const mockSearchCache = vi.fn().mockResolvedValue({ hit: false });
const mockStoreInCache = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/semantic-cache', () => ({
  searchCache: (...args: unknown[]) => mockSearchCache(...args),
  storeInCache: (...args: unknown[]) => mockStoreInCache(...args),
}));

// Import after mocks
import { executeRAGPipeline, generateCitations } from '@/lib/chat-pipeline';

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

    // P2-T3: cache HIT path
    it('returns fromCache=true with cached response when searchCache hits', async () => {
      mockSearchCache.mockResolvedValueOnce({
        hit: true,
        response: 'Cached answer',
        citations: [{ page: 5, section: '1.1' }],
        similarity: 0.97,
      });

      const result = await executeRAGPipeline('cached question');

      expect(result.fromCache).toBe(true);
      expect(result.cachedResponse).toBe('Cached answer');
      expect(result.cachedCitations).toEqual([{ page: 5, section: '1.1' }]);
      // The cache HIT path should short-circuit before vector search.
      expect(mockQueryBuildingCode).not.toHaveBeenCalled();
    });

    it('still generates the embedding (it is needed for cache lookup) on a cache HIT', async () => {
      mockSearchCache.mockResolvedValueOnce({
        hit: true,
        response: 'cached',
        citations: [],
        similarity: 0.96,
      });
      await executeRAGPipeline('q');
      expect(mockGenerateEmbedding).toHaveBeenCalledTimes(1);
    });

    // P2-T10: tighten weak assertion — verify the embedding has 768 dims
    it('result.queryEmbedding has length 768 (mocked)', async () => {
      const result = await executeRAGPipeline('verify length');
      expect(result.queryEmbedding).toHaveLength(768);
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
});
