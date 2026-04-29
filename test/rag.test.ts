// ============================================================================
// RAG Module Tests - Hybrid Search and Multi-Query Search
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock Supabase client - must mock the actual import path used in rag.ts
const mockRpc = vi.fn();
const mockSupabase = {
  rpc: mockRpc,
};

vi.mock('@/lib/supabase-server', () => ({
  createServerClient: () => mockSupabase,
  createAdminClient: () => mockSupabase,
}));

// Mock embeddings model
vi.mock('@/lib/gemini', () => ({
  embeddingsModel: {
    embedQuery: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
  },
}));

vi.mock('@/lib/document-registry', () => ({
  getDocumentByIdSync: vi.fn((id: string) => id ? { displayName: 'Building Code', shortName: 'DBC' } : undefined),
  getAllDocuments: vi.fn(async () => []),
  getAllDocumentIds: vi.fn(async () => ['building-code-2021']),
  getAllDocumentsSync: vi.fn(() => []),
  getAllDocumentIdsSync: vi.fn(() => ['building-code-2021']),
  getDocumentById: vi.fn(async (id: string) => id ? { displayName: 'Building Code', shortName: 'DBC' } : undefined),
  getDocumentByFileName: vi.fn(),
  getDocumentPdfPath: vi.fn(),
  invalidateRegistryCache: vi.fn(),
}));

// Import after mocks
import { hybridSearch, queryBuildingCode } from '@/lib/rag';

describe('RAG Module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('hybridSearch', () => {
    it('should call hybrid search RPC with correct parameters', async () => {
      const mockData = [
        {
          id: 1,
          content: 'Test content about parking',
          metadata: { page: 45, section: '3.2.1' },
          vector_similarity: 0.85,
          keyword_rank: 2,
          hybrid_score: 0.78,
        },
      ];

      mockRpc.mockResolvedValueOnce({ data: mockData, error: null });

      const results = await hybridSearch('parking requirements', 10);

      expect(mockRpc).toHaveBeenCalledWith('match_dubai_code_hybrid', {
        query_text: 'parking requirements',
        query_embedding: [0.1, 0.2, 0.3],
        match_count: 10,
        keyword_weight: 0.3,
        vector_weight: 0.7,
        rrf_k: 60,
        filter_document: null,
      });

      expect(results).toHaveLength(1);
      expect(results[0].vectorSimilarity).toBe(0.85);
      expect(results[0].hybridScore).toBe(0.78);
    });

    it('should throw error when RPC fails', async () => {
      mockRpc.mockResolvedValueOnce({ 
        data: null, 
        error: { message: 'RPC function not found' } 
      });

      await expect(hybridSearch('test query')).rejects.toThrow(
        'Hybrid search failed: RPC function not found'
      );
    });

    it('should handle empty results', async () => {
      mockRpc.mockResolvedValueOnce({ data: [], error: null });

      const results = await hybridSearch('unknown topic');

      expect(results).toEqual([]);
    });
  });

  describe('queryBuildingCode', () => {
    it('should perform hybrid search and return formatted results', async () => {
      const mockHybridData = [
        {
          id: 1,
          content: 'Fire safety requirements...',
          metadata: { page: 100, section: '5.1' },
          vector_similarity: 0.9,
          keyword_rank: 1,
          hybrid_score: 0.85,
        },
        {
          id: 2,
          content: 'Emergency exits must be...',
          metadata: { page: 101, section: '5.2' },
          vector_similarity: 0.7,
          keyword_rank: 3,
          hybrid_score: 0.6,
        },
      ];

      mockRpc.mockResolvedValueOnce({ data: mockHybridData, error: null });

      const result = await queryBuildingCode({
        query: 'fire safety requirements',
        matchCount: 10,
      });

      expect(result.chunks).toHaveLength(2);
      expect(result.chunks[0].metadata.section).toBe('5.1');
      expect(result.context).toContain('CONTEXT FROM');
    });

    it('should detect exact search patterns and include exact results', async () => {
      // Mock for exact search
      mockRpc
        .mockResolvedValueOnce({ 
          data: [{ id: 5, content: 'Section 3.2.1 content', metadata: { section: '3.2.1' }, match_position: 0 }], 
          error: null 
        })
        .mockResolvedValueOnce({ data: [], error: null }); // Hybrid search

      const _result = await queryBuildingCode({
        query: 'section 3.2.1 requirements',
        matchCount: 10,
      });

      expect(mockRpc).toHaveBeenCalledWith('search_dubai_code_exact', expect.any(Object));
    });
  });

  describe('hybridSearch with options', () => {
    it('should accept precomputedEmbedding option', async () => {
      const precomputed = [0.5, 0.6, 0.7];
      mockRpc.mockResolvedValueOnce({ data: [], error: null });

      await hybridSearch('test query', 10, { precomputedEmbedding: precomputed });

      expect(mockRpc).toHaveBeenCalledWith('match_dubai_code_hybrid', expect.objectContaining({
        query_embedding: precomputed,
      }));
    });

    it('should accept documentFilter option with single document', async () => {
      mockRpc.mockResolvedValueOnce({ data: [], error: null });

      await hybridSearch('test query', 10, { documentFilter: ['building-code-2021'] });

      expect(mockRpc).toHaveBeenCalledWith('match_dubai_code_hybrid', expect.objectContaining({
        filter_document: 'building-code-2021',
      }));
    });

    it('should pass null filter_document when no documentFilter', async () => {
      mockRpc.mockResolvedValueOnce({ data: [], error: null });

      await hybridSearch('test query', 10);

      expect(mockRpc).toHaveBeenCalledWith('match_dubai_code_hybrid', expect.objectContaining({
        filter_document: null,
      }));
    });
  });
});
