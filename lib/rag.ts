// ============================================================================
// RAG (Retrieval-Augmented Generation) Query Engine
// Hybrid Search with pre-computed embeddings, document filtering, CRAG check
// ============================================================================

import { createAdminClient } from '@/lib/supabase-server';
import { embeddingsModel } from '@/lib/gemini';
import { getDocumentByIdSync } from '@/lib/document-registry';
import type { MatchedChunk, RAGQuery, RAGResult, ChunkMetadata, HybridSearchResult } from '@/types';

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const DEFAULT_MATCH_COUNT = 25;
const FINAL_CHUNK_COUNT = 10;
const MAX_CHUNK_LENGTH = 1500;

// CRAG threshold — if top chunk score is below this, search quality is too low
export const CRAG_THRESHOLD = 0.3;

// -----------------------------------------------------------------------------
// Hybrid Search (accepts pre-computed embedding)
// -----------------------------------------------------------------------------

/**
 * Perform hybrid search combining vector similarity and keyword matching.
 * Accepts an optional pre-computed embedding to avoid redundant API calls
 * (the same embedding is used for semantic cache lookup).
 */
export async function hybridSearch(
  query: string,
  matchCount: number = DEFAULT_MATCH_COUNT,
  options: {
    precomputedEmbedding?: number[];
    documentFilter?: string[];
  } = {}
): Promise<HybridSearchResult[]> {
  const supabase = createAdminClient();

  // Use pre-computed embedding or generate new one
  const queryEmbedding = options.precomputedEmbedding
    ?? await embeddingsModel.embedQuery(query);

  // If filtering to specific documents, search each and merge
  // Otherwise search all documents at once
  const filterDocument = options.documentFilter?.length === 1
    ? options.documentFilter[0]
    : null;

  const { data, error } = await supabase.rpc('match_dubai_code_hybrid', {
    query_text: query,
    query_embedding: queryEmbedding,
    match_count: matchCount,
    keyword_weight: 0.3,
    vector_weight: 0.7,
    rrf_k: 60,
    filter_document: filterDocument,
  });

  if (error) {
    console.error('Hybrid search error:', error);
    throw new Error(`Hybrid search failed: ${error.message}`);
  }

  let results = (data || []).map((item: {
    id: number;
    content: string;
    metadata: ChunkMetadata;
    vector_similarity: number;
    keyword_rank: number;
    hybrid_score: number;
  }) => ({
    id: item.id,
    content: item.content,
    metadata: item.metadata || {},
    vectorSimilarity: item.vector_similarity || 0,
    keywordRank: item.keyword_rank || 0,
    hybridScore: item.hybrid_score || 0,
  }));

  // Post-filter by multiple documents if needed
  if (options.documentFilter && options.documentFilter.length > 1) {
    const allowedDocs = new Set(options.documentFilter);
    results = results.filter((r: HybridSearchResult) =>
      !r.metadata.documentName || allowedDocs.has(r.metadata.documentName)
    );
  }

  return results;
}

// -----------------------------------------------------------------------------
// Exact Search
// -----------------------------------------------------------------------------

async function exactSearch(
  pattern: string,
  matchCount: number = 10
): Promise<MatchedChunk[]> {
  const supabase = createAdminClient();

  const { data, error } = await supabase.rpc('search_dubai_code_exact', {
    search_pattern: pattern,
    match_count: matchCount,
  });

  if (error) {
    console.error('Exact search RPC error:', error.message || error);
    return [];
  }

  return (data || []).map((item: {
    id: number;
    content: string;
    metadata: ChunkMetadata;
    match_position: number;
  }) => ({
    id: item.id,
    content: item.content,
    metadata: item.metadata || {},
    similarity: 1.0,
  }));
}

// -----------------------------------------------------------------------------
// Main RAG Query (with pre-computed embedding + document filter)
// -----------------------------------------------------------------------------

/**
 * Query building code using hybrid search.
 * Accepts pre-computed embedding (reused from semantic cache check)
 * and document filter (from document selector).
 */
export async function queryBuildingCode(
  params: RAGQuery & {
    precomputedEmbedding?: number[];
    documentFilter?: string[];
  }
): Promise<RAGResult> {
  const { query, matchCount = DEFAULT_MATCH_COUNT } = params;

  // Detect if query needs exact search
  const needsExactSearch = /\b\d+\.\d+(\.\d+)?\b|section\s+\d+|table\s+\d+/i.test(query);

  let chunks: MatchedChunk[] = [];

  if (needsExactSearch) {
    const patternMatch = query.match(/\b(\d+\.\d+(?:\.\d+)?)\b|section\s+(\d+[\.\d]*)|table\s+(\d+[-\d]*)/i);
    if (patternMatch) {
      const pattern = patternMatch[1] || patternMatch[2] || patternMatch[3];
      const exactResults = await exactSearch(pattern, 5);
      chunks.push(...exactResults);
    }
  }

  // Hybrid search with pre-computed embedding
  const hybridResults = await hybridSearch(query, matchCount, {
    precomputedEmbedding: params.precomputedEmbedding,
    documentFilter: params.documentFilter,
  });

  const hybridChunks: MatchedChunk[] = hybridResults.map(result => ({
    id: result.id,
    content: result.content,
    metadata: result.metadata,
    similarity: result.hybridScore * 10,
  }));

  // Merge, deduplicate
  const seenIds = new Set(chunks.map(c => c.id));
  for (const chunk of hybridChunks) {
    if (!seenIds.has(chunk.id)) {
      chunks.push(chunk);
      seenIds.add(chunk.id);
    }
  }

  chunks.sort((a, b) => b.similarity - a.similarity);
  chunks = chunks.slice(0, FINAL_CHUNK_COUNT);

  const context = buildContext(chunks);
  return { chunks, context };
}

// -----------------------------------------------------------------------------
// CRAG Check (Corrective RAG)
// -----------------------------------------------------------------------------

/**
 * Check if search results are good enough to generate an answer.
 * If the top chunk score is below CRAG_THRESHOLD, the search quality
 * is too low and we should return "information not found" instead
 * of letting the LLM hallucinate.
 *
 * 0 API calls.
 */
export function passesCRAGCheck(chunks: MatchedChunk[]): boolean {
  if (chunks.length === 0) return false;
  return chunks[0].similarity >= CRAG_THRESHOLD;
}

// -----------------------------------------------------------------------------
// Context Building
// -----------------------------------------------------------------------------

export function buildContext(chunks: MatchedChunk[]): string {
  if (chunks.length === 0) return '';

  const contextParts = chunks.map((chunk, index) => {
    const page = chunk.metadata.page || 'N/A';
    const section = chunk.metadata.section || '';
    const chapter = chunk.metadata.chapter || '';
    const docId = chunk.metadata.documentName;
    const docInfo = docId ? getDocumentByIdSync(docId) : undefined;
    const docLabel = docInfo ? docInfo.displayName : 'Building Code';

    const content = chunk.content.length > MAX_CHUNK_LENGTH
      ? chunk.content.slice(0, MAX_CHUNK_LENGTH) + '...'
      : chunk.content;

    const header = `[SOURCE ${index + 1}] Document: ${docLabel}, Page ${page}${section ? `, Section ${section}` : ''}${chapter ? `, ${chapter}` : ''}`;

    return `${header}\n${content}`;
  });

  const docNames = new Set(chunks.map(c => {
    const docId = c.metadata.documentName;
    const info = docId ? getDocumentByIdSync(docId) : undefined;
    return info?.displayName || 'Building Code';
  }));
  const docsHeader = `CONTEXT FROM: ${Array.from(docNames).join(', ')}`;

  return `${docsHeader}:\n\n${contextParts.join('\n\n---\n\n')}`;
}

// -----------------------------------------------------------------------------
// Filtered Search (For scope-limited queries)
// -----------------------------------------------------------------------------

export interface PageRange {
  startPage: number;
  endPage: number;
  section?: string;
}

export async function filteredHybridSearch(
  query: string,
  pageRanges: PageRange[],
  matchCount: number = DEFAULT_MATCH_COUNT,
  precomputedEmbedding?: number[]
): Promise<HybridSearchResult[]> {
  const supabase = createAdminClient();

  const queryEmbedding = precomputedEmbedding
    ?? await embeddingsModel.embedQuery(query);

  const { data, error } = await supabase.rpc('match_dubai_code_hybrid_filtered', {
    query_text: query,
    query_embedding: queryEmbedding,
    page_ranges: pageRanges.map(r => ({
      start_page: r.startPage,
      end_page: r.endPage,
    })),
    match_count: matchCount,
    keyword_weight: 0.3,
    vector_weight: 0.7,
    rrf_k: 60,
    filter_document: null,
  });

  if (error) {
    if (error.message.includes('does not exist') || error.message.includes('not found')) {
      console.warn('Filtered search RPC not found, falling back to post-filter');
      return await hybridSearchWithPostFilter(query, pageRanges, matchCount, queryEmbedding);
    }
    console.error('Filtered hybrid search error:', error);
    throw new Error(`Filtered hybrid search failed: ${error.message}`);
  }

  return (data || []).map((item: {
    id: number;
    content: string;
    metadata: ChunkMetadata;
    vector_similarity: number;
    keyword_rank: number;
    hybrid_score: number;
  }) => ({
    id: item.id,
    content: item.content,
    metadata: item.metadata || {},
    vectorSimilarity: item.vector_similarity || 0,
    keywordRank: item.keyword_rank || 0,
    hybridScore: item.hybrid_score || 0,
  }));
}

async function hybridSearchWithPostFilter(
  query: string,
  pageRanges: PageRange[],
  matchCount: number,
  precomputedEmbedding?: number[]
): Promise<HybridSearchResult[]> {
  const expandedCount = matchCount * 3;
  const results = await hybridSearch(query, expandedCount, {
    precomputedEmbedding: precomputedEmbedding,
  });

  const filtered = results.filter(result => {
    const chunkStart = result.metadata.startPage || result.metadata.page || 0;
    const chunkEnd = result.metadata.endPage || result.metadata.page || 0;

    return pageRanges.some(range =>
      chunkStart <= range.endPage && chunkEnd >= range.startPage
    );
  });

  return filtered.slice(0, matchCount);
}

export async function queryBuildingCodeFiltered(
  params: RAGQuery & {
    pageRanges: PageRange[];
    precomputedEmbedding?: number[];
  }
): Promise<RAGResult> {
  const { query, pageRanges, matchCount = DEFAULT_MATCH_COUNT } = params;

  const needsExactSearch = /\b\d+\.\d+(\.\d+)?\b|section\s+\d+|table\s+\d+/i.test(query);

  let chunks: MatchedChunk[] = [];

  if (needsExactSearch) {
    const patternMatch = query.match(/\b(\d+\.\d+(?:\.\d+)?)\b|section\s+(\d+[\.\d]*)|table\s+(\d+[-\d]*)/i);
    if (patternMatch) {
      const pattern = patternMatch[1] || patternMatch[2] || patternMatch[3];
      const exactResults = await exactSearch(pattern, 5);

      const filteredExact = exactResults.filter(chunk => {
        const chunkPage = chunk.metadata.page || 0;
        return pageRanges.some(range =>
          chunkPage >= range.startPage && chunkPage <= range.endPage
        );
      });

      chunks.push(...filteredExact);
    }
  }

  const filteredResults = await filteredHybridSearch(
    query, pageRanges, matchCount, params.precomputedEmbedding
  );

  const filteredChunks: MatchedChunk[] = filteredResults.map(result => ({
    id: result.id,
    content: result.content,
    metadata: result.metadata,
    similarity: result.hybridScore * 10,
  }));

  const seenIds = new Set(chunks.map(c => c.id));
  for (const chunk of filteredChunks) {
    if (!seenIds.has(chunk.id)) {
      chunks.push(chunk);
      seenIds.add(chunk.id);
    }
  }

  chunks.sort((a, b) => b.similarity - a.similarity);
  chunks = chunks.slice(0, FINAL_CHUNK_COUNT);

  const context = buildContext(chunks);
  return { chunks, context };
}

// -----------------------------------------------------------------------------
// Parent Chunk Expansion (replace child chunks with parent for richer context)
// -----------------------------------------------------------------------------

/**
 * For chunks that have parent_id, fetch parent content from DB
 * and replace chunk content with the richer parent content.
 * This gives the LLM more context without additional API calls.
 */
export async function expandToParentChunks(
  chunks: MatchedChunk[]
): Promise<MatchedChunk[]> {
  const childIds = chunks
    .map(c => c.id)
    .filter(id => id > 0);

  if (childIds.length === 0) return chunks;

  try {
    const supabase = createAdminClient();

    const { data, error } = await supabase.rpc('get_parent_chunks', {
      child_ids: childIds,
    });

    if (error || !data || data.length === 0) {
      return chunks; // No parents found, return original
    }

    // Build parent lookup
    const parentMap = new Map<number, { content: string; metadata: ChunkMetadata }>();
    for (const row of data) {
      parentMap.set(row.child_id, {
        content: row.parent_content,
        metadata: row.parent_metadata,
      });
    }

    // Replace child content with parent content (keep child metadata for citations)
    return chunks.map(chunk => {
      const parent = parentMap.get(chunk.id);
      if (parent) {
        return {
          ...chunk,
          content: parent.content, // Richer parent content for LLM
          // Keep original chunk metadata for accurate citations
        };
      }
      return chunk;
    });
  } catch {
    return chunks; // Graceful fallback
  }
}
