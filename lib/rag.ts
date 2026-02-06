// ============================================================================
// RAG (Retrieval-Augmented Generation) Query Engine - Advanced Hybrid Search
// ============================================================================

import { createServerClient } from '@/lib/supabase-server';
import { embeddingsModel } from '@/lib/gemini';
import type { MatchedChunk, RAGQuery, RAGResult, ChunkMetadata, HybridSearchResult } from '@/types';

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const DEFAULT_MATCH_COUNT = 25;        // Get more chunks for reranking
const FINAL_CHUNK_COUNT = 7;           // Return top 7 after processing

// -----------------------------------------------------------------------------
// Hybrid Search Function (Vector + Keyword with RRF)
// -----------------------------------------------------------------------------

/**
 * Perform hybrid search combining vector similarity and keyword matching
 * Uses Reciprocal Rank Fusion (RRF) to merge results
 */
export async function hybridSearch(
  query: string,
  matchCount: number = DEFAULT_MATCH_COUNT
): Promise<HybridSearchResult[]> {
  const supabase = createServerClient();

  // Generate embedding for the query
  const queryEmbedding = await embeddingsModel.embedQuery(query);

  // Call hybrid search RPC
  const { data, error } = await supabase.rpc('match_dubai_code_hybrid', {
    query_text: query,
    query_embedding: queryEmbedding,
    match_count: matchCount,
    keyword_weight: 0.3,
    vector_weight: 0.7,
    rrf_k: 60,
  });

  if (error) {
    console.error('Hybrid search error:', error);
    throw new Error(`Hybrid search failed: ${error.message}. Check if the match_dubai_code_hybrid RPC function exists in your database.`);
  }

  // Transform to our type
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

// -----------------------------------------------------------------------------
// Exact Search Function (For specific section/table lookups)
// -----------------------------------------------------------------------------

/**
 * Search for exact matches (section numbers, table references, etc.)
 */
async function exactSearch(
  pattern: string,
  matchCount: number = 10
): Promise<MatchedChunk[]> {
  const supabase = createServerClient();

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
    similarity: 1.0, // Exact match
  }));
}

// -----------------------------------------------------------------------------
// Main RAG Query Function (Enhanced with Hybrid Search)
// -----------------------------------------------------------------------------

/**
 * Query the Dubai Building Code using hybrid search
 * Combines vector similarity and keyword matching for best results
 */
export async function queryDubaiCode(params: RAGQuery): Promise<RAGResult> {
  const {
    query,
    matchCount = DEFAULT_MATCH_COUNT
  } = params;

  // Detect if query needs exact search (section numbers, etc.)
  const needsExactSearch = /\b\d+\.\d+(\.\d+)?\b|section\s+\d+|table\s+\d+/i.test(query);

  let chunks: MatchedChunk[] = [];

  if (needsExactSearch) {
    // Extract the pattern and do exact search first
    const patternMatch = query.match(/\b(\d+\.\d+(?:\.\d+)?)\b|section\s+(\d+[\.\d]*)|table\s+(\d+[-\d]*)/i);
    if (patternMatch) {
      const pattern = patternMatch[1] || patternMatch[2] || patternMatch[3];
      const exactResults = await exactSearch(pattern, 5);
      chunks.push(...exactResults);
    }
  }

  // Always do hybrid search
  const hybridResults = await hybridSearch(query, matchCount);

  // Convert hybrid results to MatchedChunk format
  const hybridChunks: MatchedChunk[] = hybridResults.map(result => ({
    id: result.id,
    content: result.content,
    metadata: result.metadata,
    similarity: result.hybridScore * 10, // Normalize score
  }));

  // Merge results, avoiding duplicates
  const seenIds = new Set(chunks.map(c => c.id));
  for (const chunk of hybridChunks) {
    if (!seenIds.has(chunk.id)) {
      chunks.push(chunk);
      seenIds.add(chunk.id);
    }
  }

  // Sort by similarity and take top results
  chunks.sort((a, b) => b.similarity - a.similarity);
  chunks = chunks.slice(0, FINAL_CHUNK_COUNT);

  // Build context string from chunks
  const context = buildContext(chunks);

  return {
    chunks,
    context,
  };
}

// -----------------------------------------------------------------------------
// Multi-Query Search (For Query Expansion)
// -----------------------------------------------------------------------------

/**
 * Search with multiple queries and merge results using RRF
 */
export async function multiQuerySearch(
  queries: string[],
  matchCountPerQuery: number = 10
): Promise<MatchedChunk[]> {
  const allResults: Map<number, { chunk: MatchedChunk; ranks: number[] }> = new Map();

  // Search for each query
  for (let queryIdx = 0; queryIdx < queries.length; queryIdx++) {
    const query = queries[queryIdx];

    try {
      const results = await hybridSearch(query, matchCountPerQuery);

      // Track rank for each result
      results.forEach((result, rank) => {
        const existing = allResults.get(result.id);

        if (existing) {
          existing.ranks.push(rank + 1); // 1-indexed rank
        } else {
          allResults.set(result.id, {
            chunk: {
              id: result.id,
              content: result.content,
              metadata: result.metadata,
              similarity: result.hybridScore,
            },
            ranks: [rank + 1],
          });
        }
      });
    } catch (error) {
      console.error(`Search failed for query "${query}":`, error instanceof Error ? error.message : error);
    }
  }

  // Calculate RRF score across all queries
  const K = 60; // RRF constant
  const scoredChunks = Array.from(allResults.values()).map(item => {
    // RRF score = sum of 1/(k + rank) for each query
    const rrfScore = item.ranks.reduce((sum, rank) => sum + 1 / (K + rank), 0);

    return {
      ...item.chunk,
      similarity: rrfScore,
    };
  });

  // Sort by RRF score
  scoredChunks.sort((a, b) => b.similarity - a.similarity);

  return scoredChunks.slice(0, FINAL_CHUNK_COUNT);
}

// -----------------------------------------------------------------------------
// Context Building (Clean Format for LLM)
// -----------------------------------------------------------------------------

const MAX_CHUNK_LENGTH = 1000;

/**
 * Build context string for LLM consumption
 * Uses a clean, structured format with source attribution
 */
export function buildContext(chunks: MatchedChunk[]): string {
  if (chunks.length === 0) {
    return '';
  }

  // Build structured context with clear source attribution
  const contextParts = chunks.map((chunk, index) => {
    const page = chunk.metadata.page || 'N/A';
    const section = chunk.metadata.section || '';
    const chapter = chunk.metadata.chapter || '';

    const content = chunk.content.length > MAX_CHUNK_LENGTH
      ? chunk.content.slice(0, MAX_CHUNK_LENGTH) + '...'
      : chunk.content;

    const header = `[SOURCE ${index + 1}] Page ${page}${section ? `, Section ${section}` : ''}${chapter ? `, ${chapter}` : ''}`;

    return `${header}\n${content}`;
  });

  return `CONTEXT FROM DUBAI BUILDING CODE 2021:\n\n${contextParts.join('\n\n---\n\n')}`;
}

// -----------------------------------------------------------------------------
// Filtered Search (For Tree Reasoning)
// -----------------------------------------------------------------------------

export interface PageRange {
  startPage: number;
  endPage: number;
  section?: string;
}

/**
 * Perform hybrid search filtered by page ranges (Tree Reasoning)
 * Only searches within specified page ranges for more precise results
 */
export async function filteredHybridSearch(
  query: string,
  pageRanges: PageRange[],
  matchCount: number = DEFAULT_MATCH_COUNT
): Promise<HybridSearchResult[]> {
  const supabase = createServerClient();

  // Generate embedding for the query
  const queryEmbedding = await embeddingsModel.embedQuery(query);

  // Call filtered hybrid search RPC
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
  });

  if (error) {
    // Fallback to regular hybrid search if filtered RPC doesn't exist
    if (error.message.includes('does not exist') || error.message.includes('not found')) {
      console.warn('Filtered search RPC not found, falling back to regular search with post-filter');
      return await hybridSearchWithPostFilter(query, pageRanges, matchCount);
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

/**
 * Fallback: Regular hybrid search with post-filtering by page ranges
 * Used when filtered RPC is not available
 */
async function hybridSearchWithPostFilter(
  query: string,
  pageRanges: PageRange[],
  matchCount: number
): Promise<HybridSearchResult[]> {
  // Get more results to filter
  const expandedCount = matchCount * 3;
  const results = await hybridSearch(query, expandedCount);

  // Filter by page ranges
  const filtered = results.filter(result => {
    const chunkStart = result.metadata.startPage || result.metadata.page || 0;
    const chunkEnd = result.metadata.endPage || result.metadata.page || 0;

    return pageRanges.some(range => {
      // Check if chunk overlaps with any page range
      return chunkStart <= range.endPage && chunkEnd >= range.startPage;
    });
  });

  return filtered.slice(0, matchCount);
}

/**
 * Query Dubai Code with Tree Reasoning filter
 * Searches only within specified page ranges
 */
export async function queryDubaiCodeFiltered(
  params: RAGQuery & { pageRanges: PageRange[] }
): Promise<RAGResult> {
  const {
    query,
    pageRanges,
    matchCount = DEFAULT_MATCH_COUNT
  } = params;

  // Check if we need exact search
  const needsExactSearch = /\b\d+\.\d+(\.\d+)?\b|section\s+\d+|table\s+\d+/i.test(query);

  let chunks: MatchedChunk[] = [];

  if (needsExactSearch) {
    const patternMatch = query.match(/\b(\d+\.\d+(?:\.\d+)?)\b|section\s+(\d+[\.\d]*)|table\s+(\d+[-\d]*)/i);
    if (patternMatch) {
      const pattern = patternMatch[1] || patternMatch[2] || patternMatch[3];
      const exactResults = await exactSearch(pattern, 5);
      
      // Filter exact results by page ranges too
      const filteredExact = exactResults.filter(chunk => {
        const chunkPage = chunk.metadata.page || 0;
        return pageRanges.some(range => 
          chunkPage >= range.startPage && chunkPage <= range.endPage
        );
      });
      
      chunks.push(...filteredExact);
    }
  }

  // Filtered hybrid search
  const filteredResults = await filteredHybridSearch(query, pageRanges, matchCount);

  // Convert to MatchedChunk format
  const filteredChunks: MatchedChunk[] = filteredResults.map(result => ({
    id: result.id,
    content: result.content,
    metadata: result.metadata,
    similarity: result.hybridScore * 10,
  }));

  // Merge results, avoiding duplicates
  const seenIds = new Set(chunks.map(c => c.id));
  for (const chunk of filteredChunks) {
    if (!seenIds.has(chunk.id)) {
      chunks.push(chunk);
      seenIds.add(chunk.id);
    }
  }

  // Sort by similarity
  chunks.sort((a, b) => b.similarity - a.similarity);
  chunks = chunks.slice(0, FINAL_CHUNK_COUNT);

  const context = buildContext(chunks);

  return {
    chunks,
    context,
  };
}
