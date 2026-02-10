// ============================================================================
// Citation Parser Tests - Citation Extraction and Matching
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock Supabase client - must mock the actual import path used in citation-parser.ts
const mockRpc = vi.fn();
vi.mock('@/lib/supabase-server', () => ({
  createServerClient: () => ({
    rpc: mockRpc,
  }),
  createAdminClient: () => ({
    rpc: mockRpc,
  }),
}));

// Import after mocks
import { 
  parseCitationsFromResponse, 
  matchCitationsToChunks, 
  createSmartCitations,
  getCitationStats 
} from '@/lib/citation-parser';
import type { MatchedChunk, Citation } from '@/types';

describe('Citation Parser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('parseCitationsFromResponse', () => {
    it('should parse [Page X, Section Y] format', () => {
      const response = 'According to [Page 45, Section 3.2.1] info.';
      const citations = parseCitationsFromResponse(response);

      expect(citations.some(c => c.page === 45 && c.section === '3.2.1')).toBe(true);
    });

    it('should parse [Page X-Y] range format', () => {
      const response = 'Fire safety requirements are detailed in [Page 100-102]';
      const citations = parseCitationsFromResponse(response);

      expect(citations).toHaveLength(1);
      expect(citations[0].page).toBe(100);
    });

    it('should parse (Page X, Section Y) format', () => {
      const response = 'Details (Page 30, Section 2.1) end.';
      const citations = parseCitationsFromResponse(response);

      expect(citations.some(c => c.page === 30 && c.section === '2.1')).toBe(true);
    });

    it('should parse simple [Page X] format', () => {
      const response = 'See [Page 50] for more details.';
      const citations = parseCitationsFromResponse(response);

      expect(citations).toHaveLength(1);
      expect(citations[0].page).toBe(50);
      expect(citations[0].section).toBeUndefined();
    });

    it('should parse multiple citations with brackets', () => {
      const response = 'See [Page 45] and [Page 100] for info.';
      const citations = parseCitationsFromResponse(response);

      expect(citations).toHaveLength(2);
      expect(citations[0].page).toBe(45);
      expect(citations[1].page).toBe(100);
    });

    it('should avoid duplicate citations', () => {
      const response = 'See [Page 45] and again [Page 45] for the same info.';
      const citations = parseCitationsFromResponse(response);

      expect(citations).toHaveLength(1);
    });

    it('should handle response with no citations', () => {
      const response = 'General information about parking without specific citations.';
      const citations = parseCitationsFromResponse(response);

      expect(citations).toHaveLength(0);
    });

    it('should parse reversed Section X, Page Y format', () => {
      const response = 'According to Section 5.1, Page 200, fire exits must...';
      const citations = parseCitationsFromResponse(response);

      expect(citations).toHaveLength(1);
      expect(citations[0].page).toBe(200);
      expect(citations[0].section).toBe('5.1');
    });

    it('should preserve citation order by position', () => {
      const response = '[Page 100] comes first, then [Page 50], finally [Page 200].';
      const citations = parseCitationsFromResponse(response);

      expect(citations[0].page).toBe(100);
      expect(citations[1].page).toBe(50);
      expect(citations[2].page).toBe(200);
    });
  });

  describe('matchCitationsToChunks', () => {
    const mockChunks: MatchedChunk[] = [
      { id: 1, content: 'Parking requirements text...', metadata: { page: 45, startPage: 45, endPage: 45, section: '3.1' }, similarity: 0.9 },
      { id: 2, content: 'Fire safety text...', metadata: { page: 100, startPage: 100, endPage: 100, section: '5.1' }, similarity: 0.8 },
    ];

    it('should return fallback chunks when no parsed citations', async () => {
      const matched = await matchCitationsToChunks([], mockChunks, 50);

      expect(matched).toHaveLength(2);
      expect(matched[0].isVerified).toBe(false);
    });

    it('should match parsed citations to database chunks', async () => {
      const parsedCitations = [
        { page: 45, section: '3.1', originalText: '[Page 45, Section 3.1]', position: 0 },
      ];

      mockRpc.mockResolvedValueOnce({
        data: [{
          id: 1,
          content: 'Parking requirements text...',
          metadata: { page: 45, section: '3.1' },
          match_score: 90,
        }],
        error: null,
      });

      const matched = await matchCitationsToChunks(parsedCitations, mockChunks, 70);

      expect(matched).toHaveLength(1);
      expect(matched[0].isVerified).toBe(true);
      expect(matched[0].matchScore).toBe(90);
    });

    it('should handle RPC errors gracefully', async () => {
      const parsedCitations = [
        { page: 45, section: '3.1', originalText: '[Page 45]', position: 0 },
      ];

      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { message: 'RPC error' },
      });

      // Should not throw, should return fallback
      const matched = await matchCitationsToChunks(parsedCitations, mockChunks, 50);
      
      expect(matched.length).toBeGreaterThan(0);
    });

    it('should avoid duplicate chunk IDs', async () => {
      const parsedCitations = [
        { page: 45, section: '3.1', originalText: '[Page 45]', position: 0 },
        { page: 45, section: '3.1', originalText: '[Page 45, Section 3.1]', position: 50 },
      ];

      mockRpc
        .mockResolvedValueOnce({
          data: [{ id: 1, content: 'Content', metadata: { page: 45, section: '3.1' }, match_score: 90 }],
          error: null,
        })
        .mockResolvedValueOnce({
          data: [{ id: 1, content: 'Content', metadata: { page: 45, section: '3.1' }, match_score: 90 }],
          error: null,
        });

      const matched = await matchCitationsToChunks(parsedCitations, mockChunks, 50);

      expect(matched).toHaveLength(1); // Should dedupe
    });
  });

  describe('createSmartCitations', () => {
    const mockChunks: MatchedChunk[] = [
      { id: 1, content: 'Relevant content about parking...', metadata: { page: 45, startPage: 45, endPage: 45, section: '3.1' }, similarity: 0.9 },
      { id: 2, content: 'Another chunk about fire safety...', metadata: { page: 100, startPage: 100, endPage: 100, section: '5.1' }, similarity: 0.8 },
    ];

    it('should create citations from AI response with chunks', async () => {
      const aiResponse = 'Parking spaces must be 2.5m wide [Page 45, Section 3.1].';
      
      mockRpc.mockResolvedValueOnce({
        data: [{
          id: 1,
          content: 'Relevant content...',
          metadata: { page: 45, section: '3.1' },
          match_score: 85,
        }],
        error: null,
      });

      const citations = await createSmartCitations(aiResponse, mockChunks, 70, 30);

      expect(citations.length).toBeGreaterThan(0);
    });

    it('should filter out low confidence citations', async () => {
      const aiResponse = 'Some content without explicit citations.';

      const citations = await createSmartCitations(aiResponse, mockChunks, 20, 50);

      // With minConfidence of 50 and verificationConfidence of 20, 
      // fallback citations may be filtered
      expect(citations.every(c => (c.confidence ?? 0) >= 50 || c.isVerified)).toBe(true);
    });

    it('should limit to 10 citations max', async () => {
      const largeChunks: MatchedChunk[] = Array.from({ length: 15 }, (_, i) => ({
        id: i + 1,
        content: `Content ${i}`,
        metadata: { page: i + 1, startPage: i + 1, endPage: i + 1, section: `${i}.1` },
        similarity: 0.9 - i * 0.01,
      }));

      const citations = await createSmartCitations('response', largeChunks, 80, 10);

      expect(citations.length).toBeLessThanOrEqual(10);
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
