// ============================================================================
// Citation Parser Tests - Chunk-Based Citations
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Import directly — citation-parser has no external dependencies (no Supabase RPC)
import {
  createChunkCitations,
  getCitationStats,
  getConfidenceTier,
} from '@/lib/citation-parser';
import type { MatchedChunk, Citation } from '@/types';

describe('Citation Parser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('createChunkCitations', () => {
    const mockChunks: MatchedChunk[] = [
      { id: 1, content: 'Parking requirements text about 2.5m wide spaces...', metadata: { page: 45, startPage: 45, endPage: 46, section: '3.1', sectionTitle: 'Parking', contentType: 'text', documentName: 'building-code-2021' }, similarity: 0.9 },
      { id: 2, content: 'Fire safety text about exits...', metadata: { page: 100, startPage: 100, endPage: 102, section: '5.1', sectionTitle: 'Fire Safety', contentType: 'text', documentName: 'code-of-safety' }, similarity: 0.8 },
      { id: 3, content: 'Building heights are regulated by zone...', metadata: { page: 30, startPage: 30, endPage: 31, section: '2.1', sectionTitle: 'Heights', documentName: 'building-code-2021' }, similarity: 0.7 },
    ];

    it('should create citations from chunks with correct metadata', () => {
      const citations = createChunkCitations(mockChunks);

      expect(citations).toHaveLength(3);
      expect(citations[0].chunkId).toBe(1);
      expect(citations[0].page).toBe(45);
      expect(citations[0].section).toBe('3.1');
      expect(citations[0].sectionTitle).toBe('Parking');
      expect(citations[0].isVerified).toBe(true);
      expect(citations[0].documentName).toBe('building-code-2021');
    });

    it('should respect maxCitations parameter', () => {
      const citations = createChunkCitations(mockChunks, 2);

      expect(citations).toHaveLength(2);
      expect(citations[0].chunkId).toBe(1);
      expect(citations[1].chunkId).toBe(2);
    });

    it('should return empty array for empty chunks', () => {
      const citations = createChunkCitations([]);

      expect(citations).toHaveLength(0);
    });

    it('should deduplicate by chunk id', () => {
      const duplicateChunks: MatchedChunk[] = [
        { id: 1, content: 'Content A', metadata: { page: 45, startPage: 45, endPage: 45, section: '3.1' }, similarity: 0.9 },
        { id: 1, content: 'Content A duplicate', metadata: { page: 45, startPage: 45, endPage: 45, section: '3.1' }, similarity: 0.85 },
        { id: 2, content: 'Content B', metadata: { page: 100, startPage: 100, endPage: 100, section: '5.1' }, similarity: 0.8 },
      ];

      const citations = createChunkCitations(duplicateChunks);

      expect(citations).toHaveLength(2);
    });

    it('should always set isVerified to true', () => {
      const citations = createChunkCitations(mockChunks);

      expect(citations.every(c => c.isVerified === true)).toBe(true);
    });

    it('should set confidence from similarity', () => {
      const citations = createChunkCitations(mockChunks);

      expect(citations[0].confidence).toBe(90); // 0.9 * 100
      expect(citations[1].confidence).toBe(80); // 0.8 * 100
    });

    it('should include excerpt from chunk content', () => {
      const citations = createChunkCitations(mockChunks);

      expect(citations[0].excerpt).toContain('Parking');
    });

    it('should include startPage and endPage', () => {
      const citations = createChunkCitations(mockChunks);

      expect(citations[0].startPage).toBe(45);
      expect(citations[0].endPage).toBe(46);
    });
  });

  describe('getConfidenceTier', () => {
    it('should return high for confidence >= 70', () => {
      expect(getConfidenceTier(70)).toBe('high');
      expect(getConfidenceTier(100)).toBe('high');
    });

    it('should return medium for confidence 50-69', () => {
      expect(getConfidenceTier(50)).toBe('medium');
      expect(getConfidenceTier(69)).toBe('medium');
    });

    it('should return low for confidence < 50', () => {
      expect(getConfidenceTier(49)).toBe('low');
      expect(getConfidenceTier(0)).toBe('low');
    });
  });

  describe('getCitationStats', () => {
    it('should calculate correct statistics', () => {
      const citations: Citation[] = [
        { chunkId: 1, page: 45, section: '3.1', excerpt: 'Text', similarity: 0.9, isVerified: true },
        { chunkId: 2, page: 100, section: '5.1', excerpt: 'Text', similarity: 0.8, isVerified: true },
        { chunkId: 3, page: 45, section: '3.2', excerpt: 'Text', similarity: 0.7, isVerified: false },
      ];

      const stats = getCitationStats(citations);

      expect(stats.total).toBe(3);
      expect(stats.verified).toBe(2);
      expect(stats.unverified).toBe(1);
      expect(stats.uniquePages).toBe(2); // 45 and 100
      expect(stats.uniqueSections).toBe(3); // 3.1, 5.1, 3.2
    });

    it('should handle empty citations array', () => {
      const stats = getCitationStats([]);

      expect(stats.total).toBe(0);
      expect(stats.verified).toBe(0);
      expect(stats.unverified).toBe(0);
      expect(stats.uniquePages).toBe(0);
      expect(stats.uniqueSections).toBe(0);
    });

    it('should handle citations without sections', () => {
      const citations: Citation[] = [
        { chunkId: 1, page: 45, excerpt: 'Text', similarity: 0.9 },
        { chunkId: 2, page: 50, excerpt: 'Text', similarity: 0.8 },
      ];

      const stats = getCitationStats(citations);

      expect(stats.uniqueSections).toBe(0);
      expect(stats.uniquePages).toBe(2);
    });
  });
});
