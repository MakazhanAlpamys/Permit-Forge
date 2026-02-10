// ============================================================================
// Tree Reasoning Tests - Structure-Aware RAG (Deterministic Scoring)
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the ChatGoogleGenerativeAI model (still needed for other agents functions)
const mockInvokeFn = vi.fn();

vi.mock('@langchain/google-genai', () => {
  return {
    ChatGoogleGenerativeAI: class MockChatGoogleGenerativeAI {
      constructor() {}
      async invoke(...args: unknown[]) {
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

    it('should detect topic + building type queries like "fire safety for high-rise"', () => {
      const result = classifyQueryStructure('fire safety for high-rise');
      expect(result.isStructural).toBe(true);
      expect(result.suggestedPath).toBe('tree');
    });

    it('should detect building type + topic queries like "residential egress requirements"', () => {
      const result = classifyQueryStructure('residential egress requirements');
      expect(result.isStructural).toBe(true);
      expect(result.suggestedPath).toBe('tree');
    });

    it('should detect "egress requirements for hotel" as structural', () => {
      const result = classifyQueryStructure('egress requirements for hotel');
      expect(result.isStructural).toBe(true);
    });

    it('should detect "ventilation standards for commercial" as structural', () => {
      const result = classifyQueryStructure('ventilation standards for commercial buildings');
      expect(result.isStructural).toBe(true);
    });

    it('should detect "list all requirements for parking" as structural', () => {
      const result = classifyQueryStructure('list all requirements for parking');
      expect(result.isStructural).toBe(true);
      expect(result.structuralHints).toContain('overview');
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

  describe('treeReasoner (deterministic scoring)', () => {
    it('should select parking-related nodes for parking query', () => {
      const result = treeReasoner('parking requirements for residential', sampleTree);

      expect(result.selectedNodes).toContain('0007'); // Chapter 4: Parking
      expect(result.selectedNodes).toContain('0008'); // 4.1 Residential Parking
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('should select fire safety nodes for fire query', () => {
      const result = treeReasoner('fire safety requirements', sampleTree);

      // Should include fire safety chapter and/or sub-sections
      expect(result.selectedNodes).toContain('0004'); // Chapter 3: Fire Safety
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('should prefer specific sub-sections over broad chapters', () => {
      const result = treeReasoner('residential parking dimensions', sampleTree);

      // The residential parking sub-section should score well
      expect(result.selectedNodes).toContain('0008'); // 4.1 Residential Parking
    });

    it('should return empty for completely unrelated query', () => {
      const result = treeReasoner('recipe for chocolate cake', sampleTree);

      expect(result.selectedNodes).toEqual([]);
      expect(result.confidence).toBe(0);
    });

    it('should return empty for empty tree', () => {
      const result = treeReasoner('parking requirements', []);

      expect(result.selectedNodes).toEqual([]);
      expect(result.confidence).toBe(0);
    });

    it('should match exact section numbers', () => {
      const result = treeReasoner('what does section 3.1 say?', sampleTree);

      expect(result.selectedNodes).toContain('0005'); // 3.1 Fire Protection Systems
      expect(result.confidence).toBeGreaterThanOrEqual(100); // Exact section match = high confidence
    });

    it('should select multiple sections for comparative queries', () => {
      const result = treeReasoner('compare parking and fire safety', sampleTree);

      // Should include both parking and fire safety nodes
      const hasParking = result.selectedNodes.some(id =>
        ['0007', '0008', '0009'].includes(id)
      );
      const hasFireSafety = result.selectedNodes.some(id =>
        ['0004', '0005', '0006'].includes(id)
      );
      expect(hasParking).toBe(true);
      expect(hasFireSafety).toBe(true);
    });

    it('should select emergency exits node for exit-related query', () => {
      const result = treeReasoner('emergency exit requirements', sampleTree);

      expect(result.selectedNodes).toContain('0006'); // 3.2 Emergency Exits
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
      'fire safety for high-rise',
      'egress requirements for hotel',
      'elevator standards for commercial',
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
