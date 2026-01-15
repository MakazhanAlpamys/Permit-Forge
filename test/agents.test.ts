// ============================================================================
// AI Agents Tests - Topic Classification, Query Expansion, Reranking, Verification
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Create mock function directly in test file
const mockInvokeFn = vi.fn();

// Mock the ChatGoogleGenerativeAI model with class syntax
vi.mock('@langchain/google-genai', () => {
  return {
    ChatGoogleGenerativeAI: class MockChatGoogleGenerativeAI {
      constructor() {}
      async invoke(...args: unknown[]) {
        // Use the imported mock function
        return mockInvokeFn(...args);
      }
    },
  };
});

vi.mock('@langchain/core/messages', () => ({
  HumanMessage: class MockHumanMessage {
    content: string;
    role = 'user';
    constructor(content: string) { this.content = content; }
  },
  SystemMessage: class MockSystemMessage {
    content: string;
    role = 'system';
    constructor(content: string) { this.content = content; }
  },
}));

// Import after mocks
import { 
  classifyTopic, 
  expandQuery, 
  rerankChunks, 
  verifyAnswer, 
  detectQueryType 
} from '@/lib/agents';
import type { MatchedChunk } from '@/types';

describe('AI Agents', () => {
  beforeEach(() => {
    mockInvokeFn.mockReset();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('classifyTopic', () => {
    it('should return on-topic for building-related keywords', async () => {
      const result = await classifyTopic('parking requirements for commercial buildings');
      
      expect(result.isOnTopic).toBe(true);
      expect(result.shouldUseRAG).toBe(true);
      // Should not call LLM for obvious keywords
      expect(mockInvokeFn).not.toHaveBeenCalled();
    });

    it('should return on-topic but no RAG for greetings', async () => {
      const result = await classifyTopic('hello');
      
      expect(result.isOnTopic).toBe(true);
      expect(result.shouldUseRAG).toBe(false);
    });

    it('should use LLM for ambiguous queries', async () => {
      mockInvokeFn.mockResolvedValueOnce({ content: 'ON_TOPIC' });
      
      const result = await classifyTopic('what are the rules for that?');
      
      expect(mockInvokeFn).toHaveBeenCalled();
      expect(result.isOnTopic).toBe(true);
    });

    it('should mark off-topic queries correctly', async () => {
      mockInvokeFn.mockResolvedValueOnce({ content: 'OFF_TOPIC' });
      
      const result = await classifyTopic('how to cook pasta');
      
      expect(result.isOnTopic).toBe(false);
      expect(result.shouldUseRAG).toBe(false);
    });

    it('should default to on-topic on LLM error', async () => {
      mockInvokeFn.mockRejectedValueOnce(new Error('API Error'));
      
      const result = await classifyTopic('ambiguous query');
      
      expect(result.isOnTopic).toBe(true);
      expect(result.shouldUseRAG).toBe(true);
    });
  });

  describe('expandQuery', () => {
    it('should return original query plus expanded variations', async () => {
      mockInvokeFn.mockResolvedValueOnce({
        content: '["parking space dimensions", "vehicle parking requirements", "parking area calculations"]',
      });

      const queries = await expandQuery('parking requirements');

      expect(queries[0]).toBe('parking requirements'); // Original first
      expect(queries.length).toBeGreaterThan(1);
      expect(queries.length).toBeLessThanOrEqual(5);
    });

    it('should handle invalid JSON response gracefully', async () => {
      mockInvokeFn.mockResolvedValueOnce({ content: 'invalid response' });

      const queries = await expandQuery('test query');

      expect(queries).toEqual(['test query']); // Fallback to original
    });

    it('should handle LLM errors gracefully', async () => {
      mockInvokeFn.mockRejectedValueOnce(new Error('API Error'));

      const queries = await expandQuery('test query');

      expect(queries).toEqual(['test query']); // Fallback to original
    });
  });

  describe('rerankChunks', () => {
    const mockChunks: MatchedChunk[] = [
      { id: 1, content: 'Parking spaces must be 2.5m wide', metadata: { page: 45, startPage: 45, endPage: 45, section: '3.1' }, similarity: 0.8 },
      { id: 2, content: 'Fire exits should be clearly marked', metadata: { page: 100, startPage: 100, endPage: 100, section: '5.1' }, similarity: 0.7 },
      { id: 3, content: 'Building heights are regulated', metadata: { page: 30, startPage: 30, endPage: 30, section: '2.1' }, similarity: 0.6 },
    ];

    it('should rerank chunks based on relevance scores', async () => {
      // Scores use 1-based index (idx + 1), not chunk.id
      // Chunk at index 0 gets id=1, index 1 gets id=2, etc.
      mockInvokeFn.mockResolvedValueOnce({
        content: '[{"id": 1, "score": 95}, {"id": 2, "score": 60}, {"id": 3, "score": 50}]',
      });

      const reranked = await rerankChunks('parking requirements', mockChunks, 2);

      expect(reranked.length).toBe(2);
      expect(reranked[0].id).toBe(1); // Highest score chunk (original index 0)
    });

    it('should filter out low relevance chunks (below 40)', async () => {
      // Need more chunks than topK to trigger reranking
      const manyChunks: MatchedChunk[] = [
        { id: 1, content: 'Parking spaces must be 2.5m wide', metadata: { page: 45, startPage: 45, endPage: 45, section: '3.1' }, similarity: 0.8 },
        { id: 2, content: 'Fire exits should be clearly marked', metadata: { page: 100, startPage: 100, endPage: 100, section: '5.1' }, similarity: 0.7 },
        { id: 3, content: 'Building heights are regulated', metadata: { page: 30, startPage: 30, endPage: 30, section: '2.1' }, similarity: 0.6 },
        { id: 4, content: 'Extra chunk 1', metadata: { page: 40, startPage: 40, endPage: 40, section: '4.1' }, similarity: 0.5 },
        { id: 5, content: 'Extra chunk 2', metadata: { page: 50, startPage: 50, endPage: 50, section: '5.1' }, similarity: 0.4 },
        { id: 6, content: 'Extra chunk 3', metadata: { page: 60, startPage: 60, endPage: 60, section: '6.1' }, similarity: 0.3 },
      ];
      
      // Only chunk at index 0 (id=1) has score >= 40
      mockInvokeFn.mockResolvedValueOnce({
        content: '[{"id": 1, "score": 95}, {"id": 2, "score": 30}, {"id": 3, "score": 10}, {"id": 4, "score": 20}, {"id": 5, "score": 15}, {"id": 6, "score": 5}]',
      });

      const reranked = await rerankChunks('parking requirements', manyChunks, 5);

      expect(reranked.length).toBe(1);
      expect(reranked[0].id).toBe(1);
    });

    it('should return original chunks on error', async () => {
      mockInvokeFn.mockRejectedValueOnce(new Error('API Error'));

      const reranked = await rerankChunks('test', mockChunks, 2);

      expect(reranked.length).toBe(2);
    });

    it('should return all chunks if count is less than topK', async () => {
      const smallChunks = [mockChunks[0]];
      
      const result = await rerankChunks('test', smallChunks, 5);
      
      expect(result).toEqual(smallChunks);
      expect(mockInvokeFn).not.toHaveBeenCalled();
    });
  });

  describe('verifyAnswer', () => {
    const mockChunks: MatchedChunk[] = [
      { id: 1, content: 'Parking spaces must be minimum 2.5m wide', metadata: { page: 45, startPage: 45, endPage: 45, section: '3.1' }, similarity: 0.9 },
    ];

    it('should verify answer against source chunks', async () => {
      mockInvokeFn.mockResolvedValueOnce({
        content: JSON.stringify({
          isVerified: true,
          confidence: 85,
          supportingQuotes: ['Parking spaces must be minimum 2.5m wide'],
          unsupportedClaims: [],
          suggestedCorrection: null,
        }),
      });

      const result = await verifyAnswer(
        'Parking spaces need to be at least 2.5m wide.',
        mockChunks,
        'How wide should parking spaces be?'
      );

      expect(result.isVerified).toBe(true);
      expect(result.confidence).toBe(85);
      expect(result.citations.length).toBeGreaterThan(0);
    });

    it('should return unverified result on LLM error', async () => {
      mockInvokeFn.mockRejectedValueOnce(new Error('API Error'));

      const result = await verifyAnswer('test answer', mockChunks, 'test question');

      expect(result.isVerified).toBe(false);
      expect(result.confidence).toBe(0);
    });

    it('should return low confidence for empty chunks', async () => {
      const result = await verifyAnswer('test answer', [], 'test question');

      expect(result.isVerified).toBe(false);
      expect(result.confidence).toBe(0);
    });
  });

  describe('detectQueryType', () => {
    it('should detect exact queries with section numbers', () => {
      expect(detectQueryType('section 3.2.1 requirements')).toBe('exact');
      expect(detectQueryType('what is in table 5-2?')).toBe('exact');
      expect(detectQueryType('chapter 4 content')).toBe('exact');
    });

    it('should default to hybrid for most queries', () => {
      expect(detectQueryType('parking requirements')).toBe('hybrid');
      expect(detectQueryType('fire safety rules')).toBe('hybrid');
    });

    it('should use hybrid for short queries', () => {
      expect(detectQueryType('parking')).toBe('hybrid');
      expect(detectQueryType('fire')).toBe('hybrid');
    });
  });
});
