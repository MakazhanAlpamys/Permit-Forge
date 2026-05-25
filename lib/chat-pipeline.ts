// ============================================================================
// Chat Pipeline — Optimized RAG with Semantic Cache, CRAG, Heuristic Rerank
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

  // v1.3.0 Part A (A-C-1) — Hard ceiling on a single pipeline run. If Gemini
  // wedges (429 retry-after of 7 minutes, socket hang, etc.) the singleflight
  // would otherwise stall every concurrent waiter on the same key indefinitely.
  PIPELINE_TIMEOUT_MS: 30_000,

  // v1.3.0 Part A (A-M-5) — Bound the singleflight map. Past this many
  // concurrent distinct queries we bypass the dedup so the map can't grow
  // unbounded under adversarial fan-out. New callers still run their own
  // pipeline (with its own AbortController + timeout), they just aren't tracked.
  INFLIGHT_MAX: 100,
} as const;

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface PipelineResult {
  chunks: MatchedChunk[];
  queryEmbedding: number[];
  fromCache: boolean;
  cachedResponse?: string;
  cachedCitations?: Citation[];
}

// -----------------------------------------------------------------------------
// Singleflight (X18 / P2-A7)
// -----------------------------------------------------------------------------
// Per-process Map keyed by normalised query string. While a pipeline call for
// the same query is in flight, subsequent callers wait on its Promise instead
// of running their own embedding + LLM + DB roundtrips. This is the standard
// fix for the cache-stampede problem where N concurrent requests for the
// same cold query each pay the full pipeline cost before any of them
// populates the semantic cache.
//
// Scoped to the Node process — if you scale to N replicas, each replica gets
// its own in-flight map. That's still an N× speedup vs unbounded fan-out.
//
// Map entries are removed in the pipeline's `finally`, so a thrown pipeline
// failure does NOT leak a rejected promise to future callers.

const inflightPipelines = new Map<string, Promise<PipelineResult>>();

/** Visible for tests — number of in-flight singleflight entries right now. */
export function _inflightPipelineCount(): number {
  return inflightPipelines.size;
}

/**
 * Visible for tests — drop all tracked inflight entries. Used by chat-pipeline
 * tests that intentionally leave pipelines pending to assert the cap, then
 * need to clear state before the next test runs.
 */
export function _clearInflightPipelines(): void {
  inflightPipelines.clear();
}

function singleflightKey(query: string): string {
  // Same normalisation as semantic cache lookup so the dedup window covers
  // whitespace + casing variations that already collapse to the same cache hit.
  return query.trim().toLowerCase().replace(/\s+/g, ' ');
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
// RAG Pipeline
// -----------------------------------------------------------------------------

/**
 * Public entry point — wraps the pipeline worker with a per-query singleflight
 * (X18). N concurrent requests for the same query collapse to one pipeline run.
 *
 * v1.3.0 Part A (A-C-1 / A-M-5): every run is wrapped in a Promise.race against
 * PIPELINE_TIMEOUT_MS and given its own AbortController so a wedged Gemini
 * call doesn't stall every concurrent waiter. The singleflight map is capped
 * at INFLIGHT_MAX — past that, callers run independently rather than being
 * collapsed (or, worse, refused).
 */
export async function executeRAGPipeline(query: string): Promise<PipelineResult> {
  const key = singleflightKey(query);
  const inflight = inflightPipelines.get(key);
  if (inflight) {
    return inflight;
  }

  if (inflightPipelines.size >= CHAT_PIPELINE_CONFIG.INFLIGHT_MAX) {
    console.warn(
      `Singleflight at cap (${CHAT_PIPELINE_CONFIG.INFLIGHT_MAX}); bypassing dedup for "${key.slice(0, 40)}"`,
    );
    return runRAGPipelineWithTimeout(query);
  }

  const promise = runRAGPipelineWithTimeout(query).finally(() => {
    // Always clean up — both on success and on rejection — so a transient
    // failure doesn't poison the slot for the next caller.
    inflightPipelines.delete(key);
  });
  inflightPipelines.set(key, promise);
  return promise;
}

/**
 * v1.3.0 Part A — race the worker against PIPELINE_TIMEOUT_MS. On timeout we
 * abort the worker's signal (so the embedding retry loop can wake up early)
 * and surface an empty result to the caller. Empty result + zero embedding
 * sends the stream route down its no-citation path the same way a CRAG miss
 * does, which is the safest visible degradation.
 */
async function runRAGPipelineWithTimeout(query: string): Promise<PipelineResult> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race<PipelineResult>([
      runRAGPipeline(query, controller.signal),
      new Promise<PipelineResult>((_, reject) => {
        timeoutId = setTimeout(() => {
          controller.abort();
          reject(new Error('pipeline_timeout'));
        }, CHAT_PIPELINE_CONFIG.PIPELINE_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    if (err instanceof Error && err.message === 'pipeline_timeout') {
      console.warn(
        `RAG pipeline timed out after ${CHAT_PIPELINE_CONFIG.PIPELINE_TIMEOUT_MS}ms`,
      );
      return { chunks: [], queryEmbedding: [], fromCache: false };
    }
    throw err;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/**
 * Internal pipeline worker — kept as a private function so the singleflight
 * is the only public path. Steps:
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
async function runRAGPipeline(query: string, signal?: AbortSignal): Promise<PipelineResult> {
  // Step 0: Ensure registry cache and search profiles are loaded
  await getAllDocuments(); // populates registry cache for sync lookups
  await loadSearchProfiles(); // populates document selector profiles

  // Step 1: Generate embedding (reused for cache lookup AND search). The
  // signal lets the retry loop bail early if the singleflight timeout fired.
  let queryEmbedding: number[];
  try {
    queryEmbedding = await generateEmbedding(query, 7, signal);
  } catch (error) {
    console.error('Embedding generation failed:', error);
    return { chunks: [], queryEmbedding: [], fromCache: false };
  }

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
// Citation Generation (chunk-based, 0 API)
// -----------------------------------------------------------------------------

/**
 * Generate citations from chunks used as context.
 * No LLM parsing, no RPC calls, 100% accurate from DB metadata.
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
