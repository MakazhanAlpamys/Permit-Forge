// ============================================================================
// Heuristic Reranker — Zero-API chunk reranking (~1ms)
// Replaces LLM reranker with deterministic scoring
// ============================================================================

import type { MatchedChunk } from '@/types';

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const WEIGHTS = {
  hybridScore: 0.4,
  keywordOverlap: 0.3,
  metadataMatch: 0.2,
  positionBonus: 0.1,
} as const;

// Diversity limits
const MAX_CHUNKS_PER_DOCUMENT = 3;
const MAX_CHUNKS_PER_PAGE_RANGE = 2;

// -----------------------------------------------------------------------------
// Heuristic Reranking
// -----------------------------------------------------------------------------

/**
 * Rerank chunks using a deterministic heuristic scoring formula.
 * No API calls, runs in ~1ms.
 *
 * Score = hybrid_score * 0.4 + keyword_overlap * 0.3
 *       + metadata_match * 0.2 + position_bonus * 0.1
 *
 * Also enforces diversity: max 3 per document, max 2 per page range.
 */
export function heuristicRerank(
  query: string,
  chunks: MatchedChunk[],
  topK: number = 7
): MatchedChunk[] {
  if (chunks.length === 0) return [];
  if (chunks.length <= topK) return chunks;

  const queryLower = query.toLowerCase();
  const queryTokens = queryLower
    .split(/\s+/)
    .filter(w => w.length > 2);

  // Extract section numbers from query
  const querySections = query.match(/\b(\d+\.\d+(?:\.\d+)?)\b/g) || [];

  // Score each chunk
  const scored = chunks.map((chunk, index) => {
    // 1. Hybrid score (already normalized from search)
    const hybridScore = Math.min(chunk.similarity, 1);

    // 2. Keyword overlap — how many query tokens appear in chunk content
    const contentLower = chunk.content.toLowerCase();
    const matchingTokens = queryTokens.filter(t => contentLower.includes(t));
    const keywordOverlap = queryTokens.length > 0
      ? matchingTokens.length / queryTokens.length
      : 0;

    // 3. Metadata match — section number match, content type relevance
    let metadataMatch = 0;
    const chunkSection = chunk.metadata.section || '';

    // Exact section match is very high signal
    for (const qs of querySections) {
      if (chunkSection === qs) {
        metadataMatch = 1.0;
        break;
      }
      if (chunkSection.startsWith(qs + '.') || qs.startsWith(chunkSection + '.')) {
        metadataMatch = Math.max(metadataMatch, 0.7);
      }
    }

    // Content type bonus (tables and lists are often more informative)
    if (chunk.metadata.contentType === 'table') {
      metadataMatch = Math.max(metadataMatch, 0.3);
    }

    // 4. Position bonus — earlier chunks from search tend to be better
    // Exponential decay: first chunk gets 1.0, 10th gets ~0.37
    const positionBonus = Math.exp(-index * 0.1);

    // Combined score
    const score =
      hybridScore * WEIGHTS.hybridScore +
      keywordOverlap * WEIGHTS.keywordOverlap +
      metadataMatch * WEIGHTS.metadataMatch +
      positionBonus * WEIGHTS.positionBonus;

    return { chunk, score };
  });

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Apply diversity filter
  const docCounts = new Map<string, number>();
  const pageRangeCounts = new Map<string, number>();
  const selected: MatchedChunk[] = [];
  const deferred: MatchedChunk[] = [];

  for (const { chunk } of scored) {
    const docName = chunk.metadata.documentName || 'unknown';
    const pageKey = `${docName}-${Math.floor((chunk.metadata.page || 0) / 10)}`;

    const docCount = docCounts.get(docName) || 0;
    const pageCount = pageRangeCounts.get(pageKey) || 0;

    if (docCount < MAX_CHUNKS_PER_DOCUMENT && pageCount < MAX_CHUNKS_PER_PAGE_RANGE) {
      selected.push(chunk);
      docCounts.set(docName, docCount + 1);
      pageRangeCounts.set(pageKey, pageCount + 1);
    } else {
      deferred.push(chunk);
    }

    if (selected.length >= topK) break;
  }

  // Fill remaining from deferred
  while (selected.length < topK && deferred.length > 0) {
    selected.push(deferred.shift()!);
  }

  return selected;
}
