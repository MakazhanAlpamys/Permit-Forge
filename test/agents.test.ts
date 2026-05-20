// ============================================================================
// AI Agents Tests - Topic Classification, Query Structure, Tree Reasoning
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
    GoogleGenerativeAIEmbeddings: class MockGoogleGenerativeAIEmbeddings {
      constructor() {}
      async embedQuery() { return new Array(768).fill(0); }
      async embedDocuments(docs: string[]) { return docs.map(() => new Array(768).fill(0)); }
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
  detectQueryType,
  classifyQueryStructure,
  treeReasoner,
  getPageRangesForNodes,
} from '@/lib/agents';
import type { TreeNode } from '@/types';

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

  describe('classifyQueryStructure', () => {
    it('should detect structural queries with chapter/section references', () => {
      const result = classifyQueryStructure('summarize chapter 3');
      expect(result.isStructural).toBe(true);
      expect(result.suggestedPath).toBe('tree');
    });

    it('should detect non-structural queries', () => {
      const result = classifyQueryStructure('what are parking requirements?');
      expect(result.isStructural).toBe(false);
      expect(result.suggestedPath).toBe('standard');
    });

    it('should detect contextual queries with building types and topics', () => {
      const result = classifyQueryStructure('parking requirements for residential buildings');
      expect(result.isStructural).toBe(true);
      expect(result.structuralHints).toContain('contextual');
    });

    it('should detect comparison queries', () => {
      const result = classifyQueryStructure('compare residential and commercial requirements');
      expect(result.isStructural).toBe(true);
      expect(result.structuralHints).toContain('comparison');
    });

    it('should suggest exact path for section-number queries', () => {
      const result = classifyQueryStructure('clause 4.5.2');
      expect(result.suggestedPath).toBe('exact');
    });
  });

  describe('treeReasoner', () => {
    const sampleTree: TreeNode[] = [
      { id: 'n1', title: 'Parking Requirements', level: 1, startPage: 40, endPage: 50, path: 'Chapter 3 > Parking', section: '3.1' },
      { id: 'n2', title: 'Fire Safety', level: 1, startPage: 90, endPage: 110, path: 'Chapter 5 > Fire Safety', section: '5.1' },
      { id: 'n3', title: 'Structural Loads', level: 2, startPage: 150, endPage: 170, path: 'Chapter 7 > Structural > Loads', section: '7.2' },
    ];

    it('should score and select relevant nodes', () => {
      const result = treeReasoner('parking requirements', sampleTree);
      expect(result.selectedNodes.length).toBeGreaterThan(0);
      expect(result.selectedNodes).toContain('n1');
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('should return empty for unrelated queries', () => {
      const result = treeReasoner('cooking recipes', sampleTree);
      expect(result.selectedNodes).toHaveLength(0);
      expect(result.confidence).toBe(0);
    });

    it('should return empty for empty tree', () => {
      const result = treeReasoner('parking', []);
      expect(result.selectedNodes).toHaveLength(0);
      expect(result.reasoning).toBe('No document tree available');
    });

    it('should boost score for exact section matches', () => {
      const result = treeReasoner('section 3.1 requirements', sampleTree);
      expect(result.selectedNodes).toContain('n1');
      expect(result.confidence).toBeGreaterThanOrEqual(100);
    });
  });

  describe('getPageRangesForNodes', () => {
    const sampleTree: TreeNode[] = [
      { id: 'n1', title: 'Parking', level: 1, startPage: 40, endPage: 50, path: 'Chapter 3 > Parking', section: '3.1' },
      { id: 'n2', title: 'Fire Safety', level: 1, startPage: 90, endPage: 110, path: 'Chapter 5 > Fire Safety', section: '5.1' },
      { id: 'n3', title: 'Exits', level: 2, startPage: 48, endPage: 55, path: 'Chapter 3 > Exits', section: '3.2' },
    ];

    it('should return page ranges for selected nodes', () => {
      const ranges = getPageRangesForNodes(['n1', 'n2'], sampleTree);
      expect(ranges).toHaveLength(2);
      expect(ranges[0]).toEqual({ startPage: 40, endPage: 50, section: '3.1' });
      // E17: the second non-overlapping range must also come through
      // unmerged — a regression that always merged would have hidden here.
      expect(ranges[1]).toEqual({ startPage: 90, endPage: 110, section: '5.1' });
    });

    it('should merge overlapping ranges', () => {
      const ranges = getPageRangesForNodes(['n1', 'n3'], sampleTree);
      // n1: 40-50, n3: 48-55 → merged to 40-55
      expect(ranges).toHaveLength(1);
      expect(ranges[0].startPage).toBe(40);
      expect(ranges[0].endPage).toBe(55);
    });

    it('should handle unknown node IDs', () => {
      const ranges = getPageRangesForNodes(['unknown'], sampleTree);
      expect(ranges).toHaveLength(0);
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
