// ============================================================================
// Centralized Chat Pipeline (Shared RAG logic for Server Action and API Route)
// Enhanced with Tree Reasoning for structure-aware search
// ============================================================================

import { queryDubaiCode, multiQuerySearch, queryDubaiCodeFiltered, diversifyChunks } from '@/lib/rag';
import {
  expandQuery,
  rerankChunks,
  verifyAnswer,
  detectQueryType,
  classifyQueryStructure,
  treeReasoner,
  getPageRangesForNodes
} from '@/lib/agents';
import { createSmartCitations, getCitationStats, getConfidenceTier } from '@/lib/citation-parser';
import { getAllCachedDocumentTrees } from '@/lib/tree-cache';
import type {
  Citation,
  MatchedChunk,
  VerifiedAnswer,
} from '@/types';

// Re-export classifyTopic for backward compatibility
export { classifyTopic as classifyUserTopic } from '@/lib/agents';

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

export const CHAT_PIPELINE_CONFIG = {
  // Standard RAG settings
  ENABLE_QUERY_EXPANSION: true,
  ENABLE_RERANKING: true,
  ENABLE_VERIFICATION: true,
  MAX_EXPANDED_QUERIES: 4,
  RERANK_TOP_K: 10,
  MIN_CITATION_CONFIDENCE: 50,
  MATCH_THRESHOLD: 0.4,
  INITIAL_MATCH_COUNT: 30,
  MULTI_QUERY_MATCH_COUNT: 20,

  // Tree Reasoning settings
  ENABLE_TREE_REASONING: true,           // Enable structure-aware search
  TREE_REASONING_MIN_CONFIDENCE: 45,     // Min confidence to use tree results
  TREE_REASONING_MAX_NODES: 5,           // Max nodes to select
  TREE_REASONING_FALLBACK: true,         // Fallback to standard search on failure
} as const;

// Document tree cache is managed by lib/tree-cache.ts (TTL + Supabase-backed)

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface TopicClassificationResult {
  isOnTopic: boolean;
  shouldUseRAG: boolean;
}

export interface RAGPipelineResult {
  chunks: MatchedChunk[];
  context: string;
  verificationResult?: VerifiedAnswer;
}

// -----------------------------------------------------------------------------
// Off-Topic Response Templates
// -----------------------------------------------------------------------------

export const OFF_TOPIC_RESPONSE =
  "I'm Emirate Forge, your Dubai construction compliance assistant. I can help with questions about the Dubai Building Code 2021, Code of Safety, Al Sa'fat Green Building System, Universal Design Code, and Sewerage & Stormwater Guidelines. Ask me anything about building regulations in Dubai!";

export const GREETING_RESPONSE =
  "Hello! I'm Emirate Forge, your Dubai construction compliance assistant. I have access to multiple official documents:\n\n" +
  "- **Dubai Building Code 2021** — building regulations, parking, heights, structural\n" +
  "- **Code of Safety** — safety regulations for buildings\n" +
  "- **Al Sa'fat Green Building System** — energy efficiency, green building ratings\n" +
  "- **Universal Design Code** — accessibility, people of determination\n" +
  "- **Sewerage & Stormwater Guidelines** — drainage, plumbing design\n\n" +
  "I search across all documents to give you comprehensive answers with precise source citations!";

// -----------------------------------------------------------------------------
// RAG Pipeline (Search  Rerank) with Tree Reasoning
// -----------------------------------------------------------------------------

/**
 * Execute the RAG search pipeline with optional Tree Reasoning:
 *   2. Tree Reasoner selects relevant sections
 *   3. Filtered search within sections
 *   4. Re-ranking
 * 
 * For STANDARD queries:
 *   1. Query type detection
 *   2. Query expansion (optional)
 *   3. Hybrid search (full document)
 *   4. Re-ranking
 * 
 * Fallback: If Tree Reasoning fails, use standard pipeline
 */
export async function executeRAGPipeline(query: string): Promise<MatchedChunk[]> {
  const {
    ENABLE_TREE_REASONING,
    TREE_REASONING_MIN_CONFIDENCE,
    TREE_REASONING_FALLBACK,
  } = CHAT_PIPELINE_CONFIG;

  // Classify query to determine routing
  const queryClassification = classifyQueryStructure(query);

  console.log(`🔍 Query classification: ${queryClassification.suggestedPath}`,
    queryClassification.structuralHints.length > 0
      ? `(hints: ${queryClassification.structuralHints.join(', ')})`
      : '');

  // Route to Tree Reasoning path for structural queries
  if (
    ENABLE_TREE_REASONING &&
    queryClassification.isStructural &&
    queryClassification.suggestedPath === 'tree'
  ) {
    try {
      const treeResult = await executeTreeReasoningPipeline(query);

      if (treeResult.chunks.length > 0 && treeResult.confidence >= TREE_REASONING_MIN_CONFIDENCE) {
        const diverseChunks = diversifyChunks(treeResult.chunks, CHAT_PIPELINE_CONFIG.RERANK_TOP_K);
        console.log(`🌳 Tree Reasoning: Found ${treeResult.chunks.length} chunks (${diverseChunks.length} after diversity) with ${treeResult.confidence}% confidence`);
        return diverseChunks;
      }

      // Low confidence - fallback
      if (TREE_REASONING_FALLBACK) {
        console.log(`⚠️ Tree Reasoning low confidence (${treeResult.confidence}%), falling back to standard`);
      }
    } catch (error) {
      console.error('Tree Reasoning error, falling back:', error);
    }
  }

  // Standard RAG pipeline
  return executeStandardRAGPipeline(query);
}

/**
 * Tree Reasoning Pipeline — Multi-Document
 * Searches across all document trees to find relevant sections
 */
async function executeTreeReasoningPipeline(query: string): Promise<{
  chunks: MatchedChunk[];
  confidence: number;
  reasoning: string;
}> {
  const {
    ENABLE_RERANKING,
    RERANK_TOP_K,
    TREE_REASONING_MAX_NODES,
  } = CHAT_PIPELINE_CONFIG;

  // Load ALL document trees (TTL-cached via Supabase)
  const allTrees = await getAllCachedDocumentTrees();

  if (allTrees.size === 0) {
    console.warn('No document trees available, cannot use Tree Reasoning');
    return { chunks: [], confidence: 0, reasoning: 'No trees available' };
  }

  // Run tree reasoner on each document and collect best results
  let bestConfidence = 0;
  const allPageRanges: { startPage: number; endPage: number; section?: string }[] = [];
  const allReasonings: string[] = [];

  for (const [docName, tree] of allTrees) {
    if (tree.length === 0) continue;

    const treeResult = treeReasoner(query, tree);

    console.log(`🌳 Tree Reasoner [${docName}]: ${treeResult.selectedNodes.length} nodes, ${treeResult.confidence}% confidence`);

    if (treeResult.selectedNodes.length > 0 && treeResult.confidence >= CHAT_PIPELINE_CONFIG.TREE_REASONING_MIN_CONFIDENCE) {
      const selectedNodes = treeResult.selectedNodes.slice(0, TREE_REASONING_MAX_NODES);
      const pageRanges = getPageRangesForNodes(selectedNodes, tree);
      allPageRanges.push(...pageRanges);
      allReasonings.push(`[${docName}] ${treeResult.reasoning}`);
      bestConfidence = Math.max(bestConfidence, treeResult.confidence);
    }
  }

  if (allPageRanges.length === 0) {
    return { chunks: [], confidence: 0, reasoning: 'No matching sections found across documents' };
  }

  console.log(`📄 Searching in ${allPageRanges.length} page ranges across documents`);

  // Filtered search within page ranges (across ALL documents)
  const filteredResult = await queryDubaiCodeFiltered({
    query,
    pageRanges: allPageRanges,
    matchCount: 25,
  });

  let chunks = filteredResult.chunks;

  // Re-ranking
  if (ENABLE_RERANKING && chunks.length > RERANK_TOP_K) {
    chunks = await rerankChunks(query, chunks, RERANK_TOP_K);
  }
  chunks = diversifyChunks(chunks, RERANK_TOP_K);

  return {
    chunks,
    confidence: bestConfidence,
    reasoning: allReasonings.join('; '),
  };
}

/**
 * Standard RAG Pipeline (no Tree Reasoning)
 * Used for non-structural queries or as fallback
 */
async function executeStandardRAGPipeline(query: string): Promise<MatchedChunk[]> {
  const {
    ENABLE_QUERY_EXPANSION,
    ENABLE_RERANKING,
    MAX_EXPANDED_QUERIES,
    RERANK_TOP_K,
    MATCH_THRESHOLD,
    INITIAL_MATCH_COUNT,
    MULTI_QUERY_MATCH_COUNT,
  } = CHAT_PIPELINE_CONFIG;

  // Step 1: Query Type Detection
  const queryType = detectQueryType(query);

  // Step 2: Query Expansion
  let searchQueries = [query];
  if (ENABLE_QUERY_EXPANSION && queryType !== 'exact') {
    const expandedQueries = await expandQuery(query);
    searchQueries = expandedQueries.slice(0, MAX_EXPANDED_QUERIES);
  }

  // Step 3: Hybrid Search
  let chunks: MatchedChunk[];
  if (searchQueries.length > 1) {
    chunks = await multiQuerySearch(searchQueries, MULTI_QUERY_MATCH_COUNT);
  } else {
    const ragResult = await queryDubaiCode({
      query,
      matchThreshold: MATCH_THRESHOLD,
      matchCount: INITIAL_MATCH_COUNT,
    });
    chunks = ragResult.chunks;
  }

  // Step 4: Re-ranking
  if (ENABLE_RERANKING && chunks.length > RERANK_TOP_K) {
    chunks = await rerankChunks(query, chunks, RERANK_TOP_K);
  }

  // Step 5: Diversity filter for cross-document coverage
  chunks = diversifyChunks(chunks, RERANK_TOP_K);

  return chunks;
}

// -----------------------------------------------------------------------------
// -----------------------------------------------------------------------------
// Answer Verification
// -----------------------------------------------------------------------------

/**
 * Verify an AI response against source chunks
 * Returns verification result with confidence score
 */
export async function verifyAIResponse(
  response: string,
  chunks: MatchedChunk[],
  originalQuery: string
): Promise<{ verifiedResponse: string; verificationResult: VerifiedAnswer }> {
  const verificationResult = await verifyAnswer(response, chunks, originalQuery);

  let verifiedResponse = response;
  if (!verificationResult.isVerified && verificationResult.confidence < 50) {
    verifiedResponse = response +
      '\n\n⚠️ Note: I could not fully verify all details in this response against the source documents. Please cross-reference with the official Dubai Building Code.';
  }

  return { verifiedResponse, verificationResult };
}

// -----------------------------------------------------------------------------
// Citation Generation
// -----------------------------------------------------------------------------

/**
 * Generate smart citations from AI response and chunks
 */
export async function generateCitations(
  aiResponse: string,
  chunks: MatchedChunk[],
  verificationConfidence: number
): Promise<Citation[]> {
  const { MIN_CITATION_CONFIDENCE } = CHAT_PIPELINE_CONFIG;

  const citations = await createSmartCitations(
    aiResponse,
    chunks,
    verificationConfidence,
    MIN_CITATION_CONFIDENCE
  );

  // Log citation statistics
  const stats = getCitationStats(citations);
  console.log(`📊 Citation stats: ${stats.verified} verified / ${stats.total} total, ${stats.uniquePages} pages, ${stats.uniqueSections} sections, verification confidence: ${verificationConfidence} (${getConfidenceTier(verificationConfidence)})`);

  return citations;
}

