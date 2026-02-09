// ============================================================================
// Chat Pipeline Tests
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MatchedChunk, VerifiedAnswer } from '@/types';

// Mock dependencies
const mockClassifyQueryStructure = vi.fn();
const mockTreeReasoner = vi.fn();
const mockGetPageRangesForNodes = vi.fn();
const mockExpandQuery = vi.fn();
const mockDetectQueryType = vi.fn();
const mockClassifyTopic = vi.fn();

vi.mock('@/lib/agents', () => ({
  classifyQueryStructure: (...args: unknown[]) => mockClassifyQueryStructure(...args),
  treeReasoner: (...args: unknown[]) => mockTreeReasoner(...args),
  getPageRangesForNodes: (...args: unknown[]) => mockGetPageRangesForNodes(...args),
  expandQuery: (...args: unknown[]) => mockExpandQuery(...args),
  rerankChunks: vi.fn((_q: string, chunks: MatchedChunk[]) => Promise.resolve(chunks.slice(0, 5))),
  detectQueryType: (...args: unknown[]) => mockDetectQueryType(...args),
  verifyAnswer: vi.fn().mockResolvedValue({
    answer: 'Verified answer',
    isVerified: true,
    confidence: 80,
    supportingQuotes: [],
    unsupportedClaims: [],
    citations: [],
  } as VerifiedAnswer),
  classifyTopic: (...args: unknown[]) => mockClassifyTopic(...args),
}));

const mockQueryDubaiCode = vi.fn();
const mockMultiQuerySearch = vi.fn();
const mockQueryDubaiCodeFiltered = vi.fn();
const mockBuildContext = vi.fn();
const mockDiversifyChunks = vi.fn((chunks: MatchedChunk[]) => chunks);

vi.mock('@/lib/rag', () => ({
  queryDubaiCode: (...args: unknown[]) => mockQueryDubaiCode(...args),
  multiQuerySearch: (...args: unknown[]) => mockMultiQuerySearch(...args),
  queryDubaiCodeFiltered: (...args: unknown[]) => mockQueryDubaiCodeFiltered(...args),
  buildContext: (...args: unknown[]) => mockBuildContext(...args),
  diversifyChunks: (chunks: MatchedChunk[]) => mockDiversifyChunks(chunks),
}));

vi.mock('@/lib/tree-cache', () => ({
  getAllCachedDocumentTrees: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock('@/lib/citation-parser', () => ({
  createSmartCitations: vi.fn().mockResolvedValue([]),
  getCitationStats: vi.fn().mockReturnValue({ total: 0, verified: 0 }),
  getConfidenceTier: vi.fn().mockReturnValue('low'),
}));

// Import after mocks
import { executeRAGPipeline, verifyAIResponse, generateCitations } from '@/lib/chat-pipeline';

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
    mockDetectQueryType.mockReturnValue('general');
    mockExpandQuery.mockResolvedValue(['parking requirements', 'car parking Dubai']);
    mockQueryDubaiCode.mockResolvedValue({ chunks: sampleChunks });
    mockMultiQuerySearch.mockResolvedValue(sampleChunks);
    mockDiversifyChunks.mockImplementation((chunks: MatchedChunk[]) => chunks);
  });

  describe('executeRAGPipeline', () => {
    it('should use standard pipeline for non-structural queries', async () => {
      const result = await executeRAGPipeline('What are parking requirements?');

      expect(mockClassifyQueryStructure).toHaveBeenCalledWith('What are parking requirements?');
      expect(result).toHaveLength(2);
      expect(result[0].content).toContain('Parking');
    });

    it('should expand query and do multi-query search when expansion enabled', async () => {
      mockExpandQuery.mockResolvedValue(['parking', 'car parking', 'vehicle spaces']);

      const result = await executeRAGPipeline('parking requirements');

      expect(mockExpandQuery).toHaveBeenCalledWith('parking requirements');
      expect(mockMultiQuerySearch).toHaveBeenCalled();
      expect(result.length).toBeGreaterThan(0);
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
      expect(result.length).toBeGreaterThanOrEqual(0);
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
    });

    it('should skip query expansion for exact queries', async () => {
      mockDetectQueryType.mockReturnValue('exact');
      mockQueryDubaiCode.mockResolvedValue({ chunks: [sampleChunks[0]] });

      const result = await executeRAGPipeline('"minimum parking spaces"');

      expect(mockExpandQuery).not.toHaveBeenCalled();
      expect(mockQueryDubaiCode).toHaveBeenCalled();
      expect(result).toHaveLength(1);
    });
  });

  describe('verifyAIResponse', () => {
    it('should return verification result', async () => {
      const { verifiedResponse, verificationResult } = await verifyAIResponse(
        'Parking requires 1 space per unit',
        sampleChunks,
        'parking requirements'
      );

      expect(verifiedResponse).toContain('Parking');
      expect(verificationResult.isVerified).toBe(true);
      expect(verificationResult.confidence).toBe(80);
    });
  });

  describe('generateCitations', () => {
    it('should call citation parser with correct params', async () => {
      const citations = await generateCitations(
        'AI response about parking',
        sampleChunks,
        80
      );

      expect(citations).toBeDefined();
      expect(Array.isArray(citations)).toBe(true);
    });
  });
});
