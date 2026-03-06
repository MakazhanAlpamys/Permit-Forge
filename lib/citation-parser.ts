// ============================================================================
// Citation Generator — v2 Pipeline (Chunk-Based, 0 API)
// Citations come directly from chunk metadata — no LLM parsing needed
// ============================================================================

import type { Citation, MatchedChunk } from '@/types';

// -----------------------------------------------------------------------------
// Chunk-Based Citations (v2)
// -----------------------------------------------------------------------------

/**
 * Generate citations directly from the chunks used as context.
 * Each chunk's metadata (page, section, document) becomes a citation.
 *
 * v2 approach:
 *   - No parsing of LLM response text
 *   - No match_citation RPC calls
 *   - 100% accurate (data comes from ingestion, not LLM)
 *   - isVerified is always true
 *   - 0 API calls
 */
export function createChunkCitations(
  chunks: MatchedChunk[],
  maxCitations: number = 7
): Citation[] {
  if (chunks.length === 0) return [];

  const seen = new Set<number>();
  const citations: Citation[] = [];

  for (const chunk of chunks) {
    if (seen.has(chunk.id)) continue;
    seen.add(chunk.id);

    citations.push({
      chunkId: chunk.id,
      page: chunk.metadata.page || 0,
      startPage: chunk.metadata.startPage,
      endPage: chunk.metadata.endPage,
      section: chunk.metadata.section,
      sectionTitle: chunk.metadata.sectionTitle,
      excerpt: truncateExcerpt(chunk.content, 200),
      similarity: chunk.similarity,
      isVerified: true,  // Always true — from DB metadata
      confidence: Math.round(Math.min(chunk.similarity * 100, 100)),
      contentType: chunk.metadata.contentType,
      documentName: chunk.metadata.documentName,
    });

    if (citations.length >= maxCitations) break;
  }

  return citations;
}

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------

function truncateExcerpt(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const truncated = text.substring(0, maxLength);
  const lastPeriod = truncated.lastIndexOf('.');
  if (lastPeriod > maxLength * 0.7) {
    return truncated.substring(0, lastPeriod + 1);
  }
  return truncated.trim() + '...';
}

export function getCitationStats(citations: Citation[]): {
  total: number;
  verified: number;
  unverified: number;
  uniquePages: number;
  uniqueSections: number;
} {
  const verifiedCount = citations.filter(c => c.isVerified).length;
  const pages = new Set(citations.map(c => c.page));
  const sections = new Set(citations.filter(c => c.section).map(c => c.section));

  return {
    total: citations.length,
    verified: verifiedCount,
    unverified: citations.length - verifiedCount,
    uniquePages: pages.size,
    uniqueSections: sections.size,
  };
}

export function getConfidenceTier(confidence: number): 'high' | 'medium' | 'low' {
  if (confidence >= 70) return 'high';
  if (confidence >= 50) return 'medium';
  return 'low';
}
