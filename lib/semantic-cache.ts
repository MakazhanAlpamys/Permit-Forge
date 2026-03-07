// ============================================================================
// Semantic Cache — Cache RAG responses by query similarity
// Uses pgvector cosine similarity to find cached responses for similar queries
// ============================================================================

import { createAdminClient } from '@/lib/supabase-server';
import { CACHE_SIMILARITY_THRESHOLD, CACHE_TTL_SECONDS } from '@/lib/constants';
import type { Citation, SemanticCacheResult } from '@/types';

// -----------------------------------------------------------------------------
// Cache Lookup
// -----------------------------------------------------------------------------

/**
 * Search the semantic cache for a similar query.
 * Uses a pre-computed embedding to avoid extra API calls.
 * Returns cached response + citations if found (similarity > 0.95).
 */
export async function searchCache(
  queryEmbedding: number[]
): Promise<SemanticCacheResult> {
  try {
    const supabase = createAdminClient();

    const { data, error } = await supabase.rpc('search_semantic_cache', {
      query_embedding: queryEmbedding,
      similarity_threshold: CACHE_SIMILARITY_THRESHOLD,
      max_age_seconds: CACHE_TTL_SECONDS,
    });

    if (error) {
      // Cache miss on RPC error — non-fatal, just skip cache
      console.warn('Semantic cache lookup error:', error.message);
      return { hit: false };
    }

    if (data && data.length > 0) {
      const entry = data[0];
      console.log(`Cache HIT (similarity: ${entry.similarity.toFixed(3)})`);
      return {
        hit: true,
        response: entry.response,
        citations: entry.citations as Citation[],
        similarity: entry.similarity,
      };
    }

    return { hit: false };
  } catch {
    // Any failure = cache miss, pipeline continues normally
    return { hit: false };
  }
}

// -----------------------------------------------------------------------------
// Cache Store
// -----------------------------------------------------------------------------

/**
 * Store a query response in the semantic cache.
 * Fire-and-forget — failures are logged but don't block the response.
 */
export async function storeInCache(
  queryText: string,
  queryEmbedding: number[],
  response: string,
  citations: Citation[]
): Promise<void> {
  try {
    const supabase = createAdminClient();

    const { error } = await supabase.rpc('insert_semantic_cache', {
      p_query_text: queryText,
      p_query_embedding: queryEmbedding,
      p_response: response,
      p_citations: JSON.parse(JSON.stringify(citations)),
      p_ttl_seconds: CACHE_TTL_SECONDS,
    });

    if (error) {
      console.warn('Semantic cache store error:', error.message);
    }
  } catch (err) {
    console.warn('Failed to store in semantic cache:', err);
  }
}
