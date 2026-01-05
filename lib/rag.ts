// ============================================================================
// RAG (Retrieval-Augmented Generation) Query Engine (LangChain Integration)
// ============================================================================

import { SupabaseVectorStore } from '@langchain/community/vectorstores/supabase';
import { createServerClient } from '@/lib/supabase';
import { embeddingsModel } from '@/lib/gemini';
import { encode } from '@toon-format/toon';
import type { MatchedChunk, RAGQuery, RAGResult, ChunkMetadata } from '@/types';

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const DEFAULT_MATCH_THRESHOLD = 0.7;
const DEFAULT_MATCH_COUNT = 5;

// -----------------------------------------------------------------------------
// Vector Store Factory
// -----------------------------------------------------------------------------

/**
 * Create a LangChain SupabaseVectorStore instance
 */
function createVectorStore() {
  const supabase = createServerClient();
  
  return new SupabaseVectorStore(embeddingsModel, {
    client: supabase,
    tableName: 'dubai_code_chunks',
    queryName: 'match_dubai_code',
  });
}

// -----------------------------------------------------------------------------
// RAG Query Function (LangChain-powered)
// -----------------------------------------------------------------------------

/**
 * Query the Dubai Building Code using semantic search
 * Uses LangChain SupabaseVectorStore for simplified retrieval
 */
export async function queryDubaiCode(params: RAGQuery): Promise<RAGResult> {
  const { 
    query, 
    matchThreshold = DEFAULT_MATCH_THRESHOLD, 
    matchCount = DEFAULT_MATCH_COUNT 
  } = params;

  const vectorStore = createVectorStore();
  
  // Use LangChain similarity search with score
  const results = await vectorStore.similaritySearchWithScore(query, matchCount);
  
  // Transform LangChain results to our format, filtering by threshold
  const chunks: MatchedChunk[] = results
    .filter(([, score]) => score >= matchThreshold)
    .map(([doc, score], index) => ({
      id: index + 1, // LangChain doesn't return IDs, use index
      content: doc.pageContent,
      metadata: {
        page: (doc.metadata?.page as number) || 0,
        chapter: doc.metadata?.chapter as string | undefined,
        section: doc.metadata?.section as string | undefined,
        tableId: doc.metadata?.tableId as string | undefined,
        tableName: doc.metadata?.tableName as string | undefined,
      } as ChunkMetadata,
      similarity: score,
    }));

  // Build context string from chunks (TOON format for token efficiency)
  const context = buildContextTOON(chunks);

  return {
    chunks,
    context,
  };
}

// -----------------------------------------------------------------------------
// Context Building (TOON Format - Token Optimized)
// -----------------------------------------------------------------------------

const MAX_CHUNK_LENGTH = 1200; // Increased for TOON efficiency

/**
 * Build context in TOON format for maximum token efficiency
 * Converts chunks array to compact tabular representation
 */
function buildContextTOON(chunks: MatchedChunk[]): string {
  if (chunks.length === 0) {
    return '';
  }

  // Convert chunks to structured data for TOON
  const chunksData = chunks.map((chunk, index) => ({
    id: index + 1,
    page: chunk.metadata.page || 0,
    section: chunk.metadata.section || '',
    similarity: Math.round(chunk.similarity * 100) / 100,
    content: chunk.content.length > MAX_CHUNK_LENGTH 
      ? chunk.content.slice(0, MAX_CHUNK_LENGTH) + '...' 
      : chunk.content,
  }));

  // Encode to TOON format (saves ~40% tokens vs JSON)
  const toonEncoded = encode({
    source: 'Dubai Building Code 2021',
    chunks: chunksData,
  }, {
    indent: 2,
    delimiter: ',', // Use comma for compatibility
  });

  return `CONTEXT (TOON format - Dubai Building Code 2021):\n${toonEncoded}`;
}

