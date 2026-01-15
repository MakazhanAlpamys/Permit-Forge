// ============================================================================
// Centralized Chat Pipeline (Shared RAG logic for Server Action and API Route)
// ============================================================================

import { queryDubaiCode, multiQuerySearch } from '@/lib/rag';
import { 
  expandQuery, 
  rerankChunks, 
  verifyAnswer, 
  detectQueryType,
  classifyTopic
} from '@/lib/agents';
import { createSmartCitations, getCitationStats } from '@/lib/citation-parser';
import type { 
  Citation,
  MatchedChunk,
  VerifiedAnswer
} from '@/types';

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

export const CHAT_PIPELINE_CONFIG = {
  ENABLE_QUERY_EXPANSION: true,
  ENABLE_RERANKING: true,
  ENABLE_VERIFICATION: true,
  MAX_EXPANDED_QUERIES: 4,
  RERANK_TOP_K: 7,
  MIN_CITATION_CONFIDENCE: 30,
  MATCH_THRESHOLD: 0.4,
  INITIAL_MATCH_COUNT: 25,
  MULTI_QUERY_MATCH_COUNT: 15,
} as const;

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

export interface ChatPipelineResult {
  responseText: string;
  citations: Citation[];
  verificationConfidence: number;
  wasVerified: boolean;
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
// RAG Pipeline (Search → Rerank)
// -----------------------------------------------------------------------------

/**
 * Execute the RAG search pipeline:
 * 1. Query type detection
 * 2. Query expansion (optional)
 * 3. Hybrid search
 * 4. Re-ranking (optional)
 */
export async function executeRAGPipeline(query: string): Promise<MatchedChunk[]> {
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

// -----------------------------------------------------------------------------
// Complete Pipeline
// -----------------------------------------------------------------------------

/**
 * Execute complete chat pipeline:
 * 1. RAG search
 * 2. Answer verification (optional)
 * 3. Citation generation
 */
export async function executeChatPipeline(
  query: string,
  aiResponse: string
): Promise<ChatPipelineResult> {
  const { ENABLE_VERIFICATION } = CHAT_PIPELINE_CONFIG;
  
  // Execute RAG pipeline
  const chunks = await executeRAGPipeline(query);
  
  // Verify answer if enabled
  let responseText = aiResponse;
  let verificationConfidence = 50;
  let wasVerified = false;
  
  if (ENABLE_VERIFICATION && chunks.length > 0) {
    const { verifiedResponse, verificationResult } = await verifyAIResponse(
      aiResponse,
      chunks,
      query
    );
    responseText = verifiedResponse;
    verificationConfidence = verificationResult.confidence;
    wasVerified = verificationResult.isVerified;
  }
  
  // Generate citations
  const citations = await generateCitations(responseText, chunks, verificationConfidence);
  
  return {
    responseText,
    citations,
    verificationConfidence,
    wasVerified,
  };
}
