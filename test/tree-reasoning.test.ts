// ============================================================================
// Tree Reasoning Tests - Structure-Aware RAG
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Create mock function for LLM
const mockInvokeFn = vi.fn();

// Mock the ChatGoogleGenerativeAI model
vi.mock('@langchain/google-genai', () => {
  return {
    ChatGoogleGenerativeAI: class MockChatGoogleGenerativeAI {
      constructor() {}
      async invoke(...args: unknown[]) {
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
  classifyQueryStructure, 
  treeReasoner,
  getPageRangesForNodes
} from '@/lib/agents';
import type { TreeNode } from '@/types';

// Sample tree for testing
const sampleTree: TreeNode[] = [
  {
    id: '0001',
    title: 'Chapter 1: Introduction',
    level: 0,
    startPage: 1,
    endPage: 20,
    path: 'Chapter 1: Introduction',
  },
  {
    id: '0002',
    title: 'Chapter 2: General Requirements',
    level: 0,
    startPage: 21,
    endPage: 50,
    path: 'Chapter 2: General Requirements',
  },
  {
    id: '0003',
    title: '2.1 Building Classifications',
    section: '2.1',
    level: 1,
    startPage: 21,
    endPage: 30,
    parentId: '0002',
    path: 'Chapter 2: General Requirements > 2.1 Building Classifications',
  },
  {
    id: '0004',
    title: 'Chapter 3: Fire Safety',
    level: 0,
    startPage: 51,
    endPage: 100,
    path: 'Chapter 3: Fire Safety',
  },
  {
    id: '0005',
    title: '3.1 Fire Protection Systems',
    section: '3.1',
    level: 1,
    startPage: 51,
    endPage: 70,
    parentId: '0004',
    path: 'Chapter 3: Fire Safety > 3.1 Fire Protection Systems',
  },
  {
    id: '0006',
    title: '3.2 Emergency Exits',
    section: '3.2',
    level: 1,
    startPage: 71,
    endPage: 100,
    parentId: '0004',
    path: 'Chapter 3: Fire Safety > 3.2 Emergency Exits',
  },
  {
    id: '0007',
    title: 'Chapter 4: Parking',
    level: 0,
    startPage: 101,
    endPage: 150,
    path: 'Chapter 4: Parking',
  },
  {
    id: '0008',
    title: '4.1 Residential Parking',
    section: '4.1',
    level: 1,
    startPage: 101,
    endPage: 120,
    parentId: '0007',
    path: 'Chapter 4: Parking > 4.1 Residential Parking',
  },
  {
    id: '0009',
    title: '4.2 Commercial Parking',
    section: '4.2',
    level: 1,
    startPage: 121,
    endPage: 150,
    parentId: '0007',
    path: 'Chapter 4: Parking > 4.2 Commercial Parking',
  },
];

describe('Tree Reasoning', () => {
  beforeEach(() => {
    mockInvokeFn.mockReset();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('classifyQueryStructure', () => {
    it('should detect structural queries with section references', () => {
      const result = classifyQueryStructure('What is in Chapter 3?');
      expect(result.isStructural).toBe(true);
      expect(result.suggestedPath).toBe('tree');
    });

    it('should detect structural queries with "in section" pattern', () => {
      const result = classifyQueryStructure('parking requirements in section 4.1');
      expect(result.isStructural).toBe(true);
      expect(result.structuralHints).toContain('section_reference');
    });

    it('should detect summarize requests', () => {
      const result = classifyQueryStructure('summarize chapter 3');
      expect(result.isStructural).toBe(true);
      expect(result.structuralHints).toContain('summarize_section');
    });

    it('should detect comparative queries', () => {
      const result = classifyQueryStructure('compare fire safety and parking requirements');
      expect(result.isStructural).toBe(true);
      expect(result.structuralHints).toContain('comparison');
    });

    it('should detect contextual queries (topic + building type)', () => {
      const result = classifyQueryStructure('parking requirements for residential buildings');
      expect(result.isStructural).toBe(true);
      expect(result.structuralHints).toContain('contextual');
    });

    it('should NOT mark simple queries as structural', () => {
      const result = classifyQueryStructure('What are parking requirements?');
      expect(result.isStructural).toBe(false);
      expect(result.suggestedPath).toBe('standard');
    });

    it('should NOT mark exact queries as structural', () => {
      const result = classifyQueryStructure('What is section 4.2.1?');
      expect(result.suggestedPath).toBe('exact');
    });

    it('should handle greetings as non-structural', () => {
      const result = classifyQueryStructure('hello');
      expect(result.isStructural).toBe(false);
    });
  });

  describe('treeReasoner', () => {
    it('should select relevant nodes for parking query', async () => {
      mockInvokeFn.mockResolvedValueOnce({
        content: JSON.stringify({
          selectedNodes: ['0007', '0008'],
          reasoning: 'Query is about parking, selecting parking chapter and residential section',
          confidence: 85,
          searchScope: 'medium',
        }),
      });

      const result = await treeReasoner('parking requirements for residential', sampleTree);

      expect(result.selectedNodes).toContain('0007');
      expect(result.selectedNodes).toContain('0008');
      expect(result.confidence).toBe(85);
      expect(result.searchScope).toBe('medium');
    });

    it('should select fire safety nodes for fire query', async () => {
      mockInvokeFn.mockResolvedValueOnce({
        content: JSON.stringify({
          selectedNodes: ['0004', '0005', '0006'],
          reasoning: 'Query is about fire safety',
          confidence: 90,
          searchScope: 'medium',
        }),
      });

      const result = await treeReasoner('fire safety requirements', sampleTree);

      expect(result.selectedNodes).toContain('0004');
      expect(result.confidence).toBe(90);
    });

    it('should return empty nodes on LLM error', async () => {
      mockInvokeFn.mockRejectedValueOnce(new Error('API Error'));

      const result = await treeReasoner('test query', sampleTree);

      expect(result.selectedNodes).toEqual([]);
      expect(result.confidence).toBe(0);
    });

    it('should filter out invalid node IDs', async () => {
      mockInvokeFn.mockResolvedValueOnce({
        content: JSON.stringify({
          selectedNodes: ['0001', 'invalid_node', '9999'],
          reasoning: 'Test',
          confidence: 70,
          searchScope: 'narrow',
        }),
      });

      const result = await treeReasoner('test query', sampleTree);

      expect(result.selectedNodes).toEqual(['0001']);
      expect(result.selectedNodes).not.toContain('invalid_node');
      expect(result.selectedNodes).not.toContain('9999');
    });

    it('should handle malformed JSON response', async () => {
      mockInvokeFn.mockResolvedValueOnce({
        content: 'This is not JSON',
      });

      const result = await treeReasoner('test query', sampleTree);

      expect(result.selectedNodes).toEqual([]);
      expect(result.confidence).toBe(0);
    });
  });

  describe('getPageRangesForNodes', () => {
    it('should return page ranges for selected nodes', () => {
      const ranges = getPageRangesForNodes(['0007', '0008'], sampleTree);

      expect(ranges.length).toBeGreaterThan(0);
      // Should include parking chapter range
      expect(ranges.some(r => r.startPage === 101)).toBe(true);
    });

    it('should merge overlapping ranges', () => {
      // Nodes 0007 (101-150) and 0008 (101-120) should merge
      const ranges = getPageRangesForNodes(['0007', '0008'], sampleTree);

      // After merge, should have just one range covering 101-150
      expect(ranges.length).toBe(1);
      expect(ranges[0].startPage).toBe(101);
    });

    it('should handle non-overlapping ranges', () => {
      // Chapter 1 (1-20) and Chapter 4 (101-150) don't overlap
      const ranges = getPageRangesForNodes(['0001', '0007'], sampleTree);

      expect(ranges.length).toBe(2);
    });

    it('should return empty array for invalid node IDs', () => {
      const ranges = getPageRangesForNodes(['invalid', 'nonexistent'], sampleTree);

      expect(ranges).toEqual([]);
    });

    it('should return empty array for empty input', () => {
      const ranges = getPageRangesForNodes([], sampleTree);

      expect(ranges).toEqual([]);
    });
  });
});

describe('Tree Reasoning Integration', () => {
  // These tests verify the complete flow

  it('should route structural queries to tree path', () => {
    const queries = [
      'summarize chapter 4',
      'what is in the fire safety section',
      'parking requirements for commercial buildings',
      'compare residential and commercial parking',
    ];

    for (const query of queries) {
      const classification = classifyQueryStructure(query);
      expect(classification.isStructural).toBe(true);
      expect(classification.suggestedPath).toBe('tree');
    }
  });

  it('should route simple queries to standard path', () => {
    const queries = [
      'What are parking requirements?',
      'fire safety rules',
      'building height limits',
      'what is egress?',
    ];

    for (const query of queries) {
      const classification = classifyQueryStructure(query);
      expect(classification.isStructural).toBe(false);
      expect(classification.suggestedPath).not.toBe('tree');
    }
  });
});
