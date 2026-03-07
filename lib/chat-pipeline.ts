// ============================================================================
// Chat Pipeline v2 — Optimized RAG with Semantic Cache, CRAG, Heuristic Rerank
// 1-2 API calls per question (~1.5 average with cache hits)
// ============================================================================

import { queryBuildingCode, queryBuildingCodeFiltered, passesCRAGCheck, expandToParentChunks } from '@/lib/rag';
import { classifyQueryStructure, treeReasoner, getPageRangesForNodes } from '@/lib/agents';
import { createChunkCitations, getCitationStats } from '@/lib/citation-parser';
import { heuristicRerank } from '@/lib/heuristic-reranker';
import { selectDocuments, getSelectedDocumentNames, loadSearchProfiles } from '@/lib/document-selector';
import { detectScope } from '@/lib/scope-detector';
import { searchCache, storeInCache } from '@/lib/semantic-cache';
import { getAllCachedDocumentTrees } from '@/lib/tree-cache';
import { generateEmbedding } from '@/lib/gemini';
import { getAllDocuments } from '@/lib/document-registry';
import type { Citation, MatchedChunk } from '@/types';

// Re-export classifyTopic for backward compatibility
export { classifyTopic as classifyUserTopic } from '@/lib/agents';
// Re-export buildContext for stream route
export { buildContext } from '@/lib/rag';

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

export const CHAT_PIPELINE_CONFIG = {
  // Semantic cache
  ENABLE_CACHE: true,

  // Search settings
  RERANK_TOP_K: 7,
  INITIAL_MATCH_COUNT: 25,

  // Tree Reasoning
  ENABLE_TREE_REASONING: true,
  TREE_REASONING_MIN_CONFIDENCE: 45,
  TREE_REASONING_MAX_NODES: 5,
  TREE_REASONING_FALLBACK: true,

  // Parent chunk expansion
  ENABLE_PARENT_EXPANSION: true,
} as const;

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface TopicClassificationResult {
  isOnTopic: boolean;
  shouldUseRAG: boolean;
}

export interface PipelineResult {
  chunks: MatchedChunk[];
  queryEmbedding: number[];
  fromCache: boolean;
  cachedResponse?: string;
  cachedCitations?: Citation[];
}

// -----------------------------------------------------------------------------
// Response Templates
// -----------------------------------------------------------------------------

export const CRAG_FAIL_RESPONSE =
  "I could not find relevant information about this topic in the available documents. " +
  "Please try rephrasing your question or ask about a specific aspect of building regulations.";

/** Build off-topic response dynamically from registered documents */
export async function getOffTopicResponse(): Promise<string> {
  const docs = await getAllDocuments();
  if (docs.length === 0) {
    return "I'm PermitForge, your building code compliance assistant. No documents are currently loaded. Please ask an admin to add and ingest documents.";
  }
  const docNames = docs.map(d => d.displayName).join(', ');
  return `I'm PermitForge, your building code compliance assistant. I can help with questions about ${docNames}. Ask me anything about building regulations!`;
}

/** Build greeting response dynamically from registered documents */
export async function getGreetingResponse(): Promise<string> {
  const docs = await getAllDocuments();
  if (docs.length === 0) {
    return "Hello! I'm PermitForge, your building code compliance assistant. No documents are currently loaded. Please ask an admin to add and ingest documents.";
  }
  const docList = docs.map(d => `- **${d.displayName}** — ${d.description || d.shortName}`).join('\n');
  return `Hello! I'm PermitForge, your building code compliance assistant. I have access to official documents:\n\n${docList}\n\nI search across all documents to give you comprehensive answers with precise source citations!`;
}

// -----------------------------------------------------------------------------
// v2 RAG Pipeline
// -----------------------------------------------------------------------------

/**
 * Execute the v2 RAG pipeline:
 *
 *   [1] Generate embedding (reused for cache + search)
 *   [2] Semantic Cache check
 *   [3] Document Selector (0 API)
 *   [4] Scope Detector (0 API)
 *   [5] Hybrid Search (reuses embedding)
 *   [6] CRAG Check (0 API)
 *   [7] Heuristic Rerank (0 API, ~1ms)
 *   [8] Parent Chunk Expansion (DB lookup, 0 API)
 *
 * Total: 1 embedding call. Cache hit = 0 more calls.
 */
export async function executeRAGPipeline(query: string): Promise<PipelineResult> {
  // Step 0: Ensure registry cache and search profiles are loaded
  await getAllDocuments(); // populates registry cache for sync lookups
  await loadSearchProfiles(); // populates document selector profiles

  // Step 1: Generate embedding (reused for cache lookup AND search)
  const queryEmbedding = await generateEmbedding(query);

  // Step 2: Semantic Cache check
  if (CHAT_PIPELINE_CONFIG.ENABLE_CACHE) {
    const cacheResult = await searchCache(queryEmbedding);
    if (cacheResult.hit && cacheResult.response && cacheResult.citations) {
      return {
        chunks: [],
        queryEmbedding,
        fromCache: true,
        cachedResponse: cacheResult.response,
        cachedCitations: cacheResult.citations,
      };
    }
  }

  // Step 3: Document Selector (0 API)
  const selectedDocs = selectDocuments(query);
  console.log(`Document selector: [${getSelectedDocumentNames(selectedDocs).join(', ')}]`);

  // Step 4: Scope Detector (0 API)
  const scope = detectScope(query);

  // Step 5: Search — route based on scope and structure
  let chunks: MatchedChunk[];

  if (scope.hasScope && scope.pageRanges.length > 0) {
    // Direct page range filter
    const result = await queryBuildingCodeFiltered({
      query,
      pageRanges: scope.pageRanges,
      matchCount: CHAT_PIPELINE_CONFIG.INITIAL_MATCH_COUNT,
      precomputedEmbedding: queryEmbedding,
    });
    chunks = result.chunks;
  } else if (CHAT_PIPELINE_CONFIG.ENABLE_TREE_REASONING) {
    // Try tree reasoning for structural queries
    const queryClassification = classifyQueryStructure(query);

    if (queryClassification.isStructural && queryClassification.suggestedPath === 'tree') {
      const treeResult = await executeTreePath(query, queryEmbedding);
      if (treeResult) {
        chunks = treeResult;
      } else {
        chunks = await executeStandardSearch(query, queryEmbedding, selectedDocs);
      }
    } else {
      chunks = await executeStandardSearch(query, queryEmbedding, selectedDocs);
    }
  } else {
    chunks = await executeStandardSearch(query, queryEmbedding, selectedDocs);
  }

  // Step 6: CRAG Check (0 API)
  if (!passesCRAGCheck(chunks)) {
    console.log('CRAG check failed — search quality too low');
    return { chunks: [], queryEmbedding, fromCache: false };
  }

  // Step 7: Heuristic Rerank (0 API, ~1ms)
  chunks = heuristicRerank(query, chunks, CHAT_PIPELINE_CONFIG.RERANK_TOP_K);

  // Step 8: Parent Chunk Expansion (DB lookup, 0 API)
  if (CHAT_PIPELINE_CONFIG.ENABLE_PARENT_EXPANSION) {
    chunks = await expandToParentChunks(chunks);
  }

  return { chunks, queryEmbedding, fromCache: false };
}

// -----------------------------------------------------------------------------
// Tree Reasoning Path
// -----------------------------------------------------------------------------

async function executeTreePath(
  query: string,
  queryEmbedding: number[]
): Promise<MatchedChunk[] | null> {
  const { TREE_REASONING_MIN_CONFIDENCE, TREE_REASONING_MAX_NODES } = CHAT_PIPELINE_CONFIG;

  try {
    const allTrees = await getAllCachedDocumentTrees();
    if (allTrees.size === 0) return null;

    const allPageRanges: { startPage: number; endPage: number; section?: string }[] = [];
    let bestConfidence = 0;

    for (const [docName, tree] of allTrees) {
      if (tree.length === 0) continue;

      const treeResult = treeReasoner(query, tree);

      if (treeResult.selectedNodes.length > 0 && treeResult.confidence >= TREE_REASONING_MIN_CONFIDENCE) {
        const selectedNodes = treeResult.selectedNodes.slice(0, TREE_REASONING_MAX_NODES);
        const pageRanges = getPageRangesForNodes(selectedNodes, tree);
        allPageRanges.push(...pageRanges);
        bestConfidence = Math.max(bestConfidence, treeResult.confidence);
        console.log(`Tree [${docName}]: ${selectedNodes.length} nodes, ${treeResult.confidence}% conf`);
      }
    }

    if (allPageRanges.length === 0 || bestConfidence < TREE_REASONING_MIN_CONFIDENCE) {
      return null;
    }

    const result = await queryBuildingCodeFiltered({
      query,
      pageRanges: allPageRanges,
      matchCount: CHAT_PIPELINE_CONFIG.INITIAL_MATCH_COUNT,
      precomputedEmbedding: queryEmbedding,
    });

    return result.chunks;
  } catch (error) {
    console.error('Tree reasoning error, falling back:', error);
    return null;
  }
}

// -----------------------------------------------------------------------------
// Standard Search Path
// -----------------------------------------------------------------------------

async function executeStandardSearch(
  query: string,
  queryEmbedding: number[],
  documentFilter: string[]
): Promise<MatchedChunk[]> {
  const result = await queryBuildingCode({
    query,
    matchCount: CHAT_PIPELINE_CONFIG.INITIAL_MATCH_COUNT,
    precomputedEmbedding: queryEmbedding,
    documentFilter,
  });

  return result.chunks;
}

// -----------------------------------------------------------------------------
// Citation Generation (v2 — chunk-based, 0 API)
// -----------------------------------------------------------------------------

/**
 * Generate citations from chunks used as context.
 * v2: No LLM parsing, no RPC calls, 100% accurate from DB metadata.
 */
export function generateCitations(chunks: MatchedChunk[]): Citation[] {
  const citations = createChunkCitations(chunks);

  const stats = getCitationStats(citations);
  console.log(`Citations: ${stats.total} total, ${stats.uniquePages} pages, ${stats.uniqueSections} sections`);

  return citations;
}

/**
 * Store response + citations in semantic cache (fire-and-forget).
 */
export async function cacheResponse(
  queryText: string,
  queryEmbedding: number[],
  response: string,
  citations: Citation[]
): Promise<void> {
  if (CHAT_PIPELINE_CONFIG.ENABLE_CACHE) {
    await storeInCache(queryText, queryEmbedding, response, citations);
  }
}
