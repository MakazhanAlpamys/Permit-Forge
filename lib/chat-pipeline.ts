// ============================================================================
// Centralized Chat Pipeline (Shared RAG logic for Server Action and API Route)
// Enhanced with Tree Reasoning for structure-aware search
// ============================================================================

import { queryDubaiCode, multiQuerySearch, queryDubaiCodeFiltered } from '@/lib/rag';
import {
  expandQuery,
  rerankChunks,
  verifyAnswer,
  detectQueryType,
  classifyTopic,
  classifyQueryStructure,
  treeReasoner,
  getPageRangesForNodes
} from '@/lib/agents';
import { createSmartCitations, getCitationStats } from '@/lib/citation-parser';
import { loadDocumentTree } from '@/lib/pdf-ingestion';
import type {
  Citation,
  MatchedChunk,
  VerifiedAnswer,
  TreeNode
} from '@/types';

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

export const CHAT_PIPELINE_CONFIG = {
  // Standard RAG settings
  ENABLE_QUERY_EXPANSION: true,
  ENABLE_RERANKING: true,
  ENABLE_VERIFICATION: true,
  MAX_EXPANDED_QUERIES: 4,
  RERANK_TOP_K: 7,
  MIN_CITATION_CONFIDENCE: 30,
  MATCH_THRESHOLD: 0.4,
  INITIAL_MATCH_COUNT: 25,
  MULTI_QUERY_MATCH_COUNT: 15,

  // Tree Reasoning settings
  ENABLE_TREE_REASONING: true,           // Enable structure-aware search
  TREE_REASONING_MIN_CONFIDENCE: 60,     // Min confidence to use tree results
  TREE_REASONING_MAX_NODES: 5,           // Max nodes to select
  TREE_REASONING_FALLBACK: true,         // Fallback to standard search on failure
} as const;

// Cache for document tree (loaded once per request)
let cachedDocumentTree: TreeNode[] | null = null;

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
  "I'm Emirate Forge, a Dubai Building Code 2021 assistant. I can help you with questions about building regulations, parking requirements, fire safety, structural requirements, and more. Feel free to ask me anything about the Dubai Building Code!";

export const GREETING_RESPONSE =
  "Hello! I'm Emirate Forge, your Dubai Building Code 2021 assistant. I can help you with:\n\n" +
  "- **Parking requirements** for different building types\n" +
  "- **Fire safety** regulations and exit requirements\n" +
  "- **Building heights** and setback rules\n" +
  "- **Structural requirements** and load specifications\n" +
  "- **Accessibility** standards\n" +
  "- **MEP systems** requirements\n\n" +
  "Just ask me any question about the Dubai Building Code!";

// -----------------------------------------------------------------------------
// Topic Classification
// -----------------------------------------------------------------------------

/**
 * Classify whether a query is on-topic and whether to use RAG
 */
export async function classifyUserTopic(query: string): Promise<TopicClassificationResult> {
  return classifyTopic(query);
}

// -----------------------------------------------------------------------------
// RAG Pipeline (Search → Rerank) with Tree Reasoning
// -----------------------------------------------------------------------------

/**
 * Execute the RAG search pipeline with optional Tree Reasoning:
 * 
 * For STRUCTURAL queries (detected by classifyQueryStructure):
 *   1. Load document tree
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
        console.log(`🌳 Tree Reasoning: Found ${treeResult.chunks.length} chunks with ${treeResult.confidence}% confidence`);
        return treeResult.chunks;
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
 * Tree Reasoning Pipeline
 * Uses document structure to narrow down search scope
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

  // Load document tree (cached)
  const tree = await getDocumentTree();

  if (tree.length === 0) {
    console.warn('No document tree available, cannot use Tree Reasoning');
    return { chunks: [], confidence: 0, reasoning: 'No tree available' };
  }

  // Step 1: Tree Reasoner selects relevant sections
  const treeResult = await treeReasoner(query, tree);

  console.log(`🌳 Tree Reasoner selected ${treeResult.selectedNodes.length} nodes:`,
    treeResult.selectedNodes.join(', '));
  console.log(`   Reasoning: ${treeResult.reasoning}`);
  console.log(`   Confidence: ${treeResult.confidence}%, Scope: ${treeResult.searchScope}`);

  if (treeResult.selectedNodes.length === 0) {
    return { chunks: [], confidence: 0, reasoning: treeResult.reasoning };
  }

  // Limit nodes
  const selectedNodes = treeResult.selectedNodes.slice(0, TREE_REASONING_MAX_NODES);

  // Step 2: Get page ranges for selected nodes
  const pageRanges = getPageRangesForNodes(selectedNodes, tree);

  if (pageRanges.length === 0) {
    return { chunks: [], confidence: 0, reasoning: 'No valid page ranges' };
  }

  console.log(`📄 Searching in page ranges:`,
    pageRanges.map(r => `${r.startPage}-${r.endPage}`).join(', '));

  // Step 3: Filtered search within page ranges
  const filteredResult = await queryDubaiCodeFiltered({
    query,
    pageRanges,
    matchCount: 25,
  });

  let chunks = filteredResult.chunks;

  // Step 4: Re-ranking
  if (ENABLE_RERANKING && chunks.length > RERANK_TOP_K) {
    chunks = await rerankChunks(query, chunks, RERANK_TOP_K);
  }

  return {
    chunks,
    confidence: treeResult.confidence,
    reasoning: treeResult.reasoning,
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

  return chunks;
}

/**
 * Get document tree (with caching)
 */
async function getDocumentTree(): Promise<TreeNode[]> {
  if (cachedDocumentTree !== null) {
    return cachedDocumentTree;
  }

  try {
    cachedDocumentTree = await loadDocumentTree();
    return cachedDocumentTree;
  } catch (error) {
    console.error('Failed to load document tree:', error);
    return [];
  }
}

/**
 * Clear document tree cache (call after re-ingestion)
 */
export function clearDocumentTreeCache(): void {
  cachedDocumentTree = null;
}

// -----------------------------------------------------------------------------
// Build Context for LLM
// -----------------------------------------------------------------------------

/**
 * Build context string from chunks for LLM consumption
 */
export function buildContextFromChunks(chunks: MatchedChunk[]): string {
  return chunks.map((chunk, idx) =>
    `[SOURCE ${idx + 1}] Page ${chunk.metadata.page}, Section: ${chunk.metadata.section || 'N/A'}, Chapter: ${chunk.metadata.chapter || 'N/A'}:\n"${chunk.content}"`
  ).join('\n\n');
}

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
  console.log(`📊 Citation stats: ${stats.verified} verified / ${stats.total} total, ${stats.uniquePages} pages, ${stats.uniqueSections} sections, verification confidence: ${verificationConfidence}`);

  return citations;
}

