// ============================================================================
// RAG (Retrieval-Augmented Generation) Query Engine
// Hybrid Search with pre-computed embeddings, document filtering, CRAG check
// ============================================================================

import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase-server';
import { embeddingsModel } from '@/lib/gemini';
import { getDocumentByIdSync } from '@/lib/document-registry';
import { KEYWORD_WEIGHT, VECTOR_WEIGHT, HYBRID_SEARCH_RRF_K } from '@/lib/constants';
import { EXACT_REFERENCE_REGEX } from '@/lib/agents';
import { CHAT_PIPELINE_CONFIG } from '@/lib/chat-pipeline-config';
import type { MatchedChunk, RAGQuery, RAGResult, ChunkMetadata, HybridSearchResult } from '@/types';

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const DEFAULT_MATCH_COUNT = 25;
const FINAL_CHUNK_COUNT = 10;
const MAX_CHUNK_LENGTH = 1500;

// CRAG threshold — if top chunk score is below this, search quality is too
// low and we short-circuit to a "no info found" reply.
//
// DB-H-4 / v1.5.0 Part E: re-derived against the actual post-RRF range.
// The hybrid path maps each result via Math.min(hybridScore * 10, 1.0)
// where hybridScore = vector_weight*(1/(rrf_k+rank)) + keyword_weight*(1/(rrf_k+rank)).
// With defaults (rrf_k=60, vw=0.7, kw=0.3): best possible hybridScore ≈ 0.0164,
// so the mapped similarity tops out at ~0.164. A threshold of 0.3 (as set in
// v0) was UNREACHABLE — every hybrid query CRAG-failed, defeating the gate.
// 0.08 is calibrated against the empirical hybrid score range: rank-1 hits
// in both vector + keyword pass; weak (no-vector-match + rank-20+ keyword)
// hits fail. The exact-search path returns similarity=1.0 so it always passes.
//
// v1.7.0 Part G (A-M-4): value lives in CHAT_PIPELINE_CONFIG so operators
// can tune it together with the reranker weights.
const CRAG_THRESHOLD = CHAT_PIPELINE_CONFIG.CRAG_THRESHOLD;

// -----------------------------------------------------------------------------
// Row mappers (F11 / Simplify #11)
// -----------------------------------------------------------------------------
// The hybrid + exact-search RPCs return slightly different row shapes but
// share the same metadata-normalization rule: page / startPage / endPage
// must be numbers, never undefined. These helpers centralize that rule and
// the row → MatchedChunk / HybridSearchResult mapping.

/**
 * A-H-9 / v1.7.0 Part C — Zod schema for the JSONB `metadata` column on
 * dubai_code_chunks. Permissive on purpose: missing fields default to safe
 * values (page=0, content='text') rather than throwing, because chunks
 * ingested before later schema fields existed must still be searchable. A
 * parse failure logs a warning and we fall back to a minimal stub metadata
 * so the row still flows through the pipeline — losing one chunk's
 * citations is strictly better than crashing the request.
 */
const ChunkMetadataSchema = z.object({
  page: z.number().optional(),
  startPage: z.number().optional(),
  endPage: z.number().optional(),
  chapter: z.string().optional(),
  section: z.string().optional(),
  sectionTitle: z.string().optional(),
  sectionPath: z.array(z.string()).optional(),
  tableId: z.string().optional(),
  tableName: z.string().optional(),
  isTable: z.boolean().optional(),
  contentType: z.enum(['text', 'table', 'list', 'heading']).optional(),
  documentName: z.string().optional(),
});

/**
 * v1.7.0 re-audit (M-1): bounded dedup so a wholesale-corrupt batch (25
 * chunks × hybrid + reranker pass-throughs ≈ 75 emits/request) cannot
 * flood Vercel log volume. We key on the JOINED issue signature so two
 * distinct schemas still both emit, but the same shape only emits once.
 * Bounded at 100 entries — past that we evict the oldest, on the
 * assumption a long-running process won't see more than a handful of
 * distinct corruption shapes in its lifetime.
 */
const MAX_WARNED_ISSUE_SIGNATURES = 100;
const warnedIssueSignatures = new Set<string>();

/** Ensure page-tracking fields on chunk metadata are numbers (default 0). */
function normalizeChunkMetadata(metadata: unknown): ChunkMetadata {
  const parsed = ChunkMetadataSchema.safeParse(metadata ?? {});
  let base: z.infer<typeof ChunkMetadataSchema>;
  if (parsed.success) {
    base = parsed.data;
  } else {
    // Don't crash the pipeline on one malformed metadata blob — log + degrade.
    const signature = parsed.error.issues
      .map((i) => `${i.path.join('.')}:${i.code}`)
      .join('|');
    if (!warnedIssueSignatures.has(signature)) {
      if (warnedIssueSignatures.size >= MAX_WARNED_ISSUE_SIGNATURES) {
        // Evict oldest (insertion-order Set iteration); keeps the set bounded.
        const oldest = warnedIssueSignatures.values().next().value;
        if (oldest !== undefined) warnedIssueSignatures.delete(oldest);
      }
      warnedIssueSignatures.add(signature);
      console.warn(
        '[rag] dropped malformed chunk metadata:',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    }
    base = {};
  }
  return {
    ...base,
    page: base.page ?? 0,
    startPage: base.startPage ?? 0,
    endPage: base.endPage ?? 0,
  } as ChunkMetadata;
}

interface HybridRpcRow {
  id: number;
  content: string;
  metadata: unknown;
  vector_similarity: number;
  keyword_rank: number;
  hybrid_score: number;
}

function mapHybridRow(row: HybridRpcRow): HybridSearchResult {
  return {
    id: row.id,
    content: row.content,
    metadata: normalizeChunkMetadata(row.metadata),
    vectorSimilarity: row.vector_similarity || 0,
    keywordRank: row.keyword_rank || 0,
    hybridScore: row.hybrid_score || 0,
  };
}

interface ExactRpcRow {
  id: number;
  content: string;
  metadata: unknown;
  match_position: number;
}

function mapExactRow(row: ExactRpcRow): MatchedChunk {
  return {
    id: row.id,
    content: row.content,
    metadata: normalizeChunkMetadata(row.metadata),
    similarity: 1.0,
  };
}

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
    keyword_weight: KEYWORD_WEIGHT,
    vector_weight: VECTOR_WEIGHT,
    rrf_k: HYBRID_SEARCH_RRF_K,
    filter_document: filterDocument,
  });

  if (error) {
    console.error('Hybrid search error:', error);
    throw new Error(`Hybrid search failed: ${error.message}`);
  }

  let results = ((data || []) as HybridRpcRow[]).map(mapHybridRow);

  // Post-filter by multiple documents if needed
  if (options.documentFilter && options.documentFilter.length > 1) {
    const allowedDocs = new Set(options.documentFilter);
    results = results.filter((r: HybridSearchResult) =>
      typeof r.metadata.documentName === 'string' &&
      r.metadata.documentName.length > 0 &&
      allowedDocs.has(r.metadata.documentName)
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

  return ((data || []) as ExactRpcRow[]).map(mapExactRow);
}

/**
 * Run exact search if the query names a specific code reference; otherwise
 * return []. Optionally filter to one or more page ranges (used by the
 * tree-reasoning / scope-detected path).
 *
 * Collapses the two near-identical "needsExactSearch + .match + exactSearch +
 * optional page filter" blocks that lived in queryBuildingCode and
 * queryBuildingCodeFiltered. (F16 / Simplify #16)
 */
const EXACT_REFERENCE_CAPTURE_REGEX =
  /\b(\d+\.\d+(?:\.\d+)?)\b|section\s+(\d+[\.\d]*)|table\s+(\d+[-\d]*)/i;

async function runExactSearchIfApplicable(
  query: string,
  pageRanges?: PageRange[],
): Promise<MatchedChunk[]> {
  if (!EXACT_REFERENCE_REGEX.test(query)) return [];

  const m = query.match(EXACT_REFERENCE_CAPTURE_REGEX);
  if (!m) return [];

  const pattern = m[1] || m[2] || m[3];
  const exactResults = await exactSearch(pattern, 5);

  if (!pageRanges || pageRanges.length === 0) return exactResults;

  return exactResults.filter((chunk) => {
    const chunkPage = chunk.metadata.page || 0;
    return pageRanges.some(
      (range) => chunkPage >= range.startPage && chunkPage <= range.endPage,
    );
  });
}

// -----------------------------------------------------------------------------
// Main RAG Query (with pre-computed embedding + document filter)
// -----------------------------------------------------------------------------

/**
 * Internal worker: convert hybrid search results into MatchedChunks, merge
 * with any exact-search hits, sort by similarity, truncate to FINAL_CHUNK_COUNT,
 * and build the LLM context. (F10 / Simplify #10 — single body shared between
 * queryBuildingCode and queryBuildingCodeFiltered.)
 */
function assembleRAGResult(
  exactChunks: MatchedChunk[],
  hybridResults: HybridSearchResult[],
): RAGResult {
  const hybridChunks: MatchedChunk[] = hybridResults.map((result) => ({
    id: result.id,
    content: result.content,
    metadata: result.metadata,
    similarity: Math.min(result.hybridScore * 10, 1.0),
  }));

  let chunks: MatchedChunk[] = [...exactChunks];
  const seenIds = new Set(chunks.map((c) => c.id));
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

  const exactChunks = await runExactSearchIfApplicable(query);
  const hybridResults = await hybridSearch(query, matchCount, {
    precomputedEmbedding: params.precomputedEmbedding,
    documentFilter: params.documentFilter,
  });

  return assembleRAGResult(exactChunks, hybridResults);
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

/**
 * Strip the most common prompt-injection vectors from chunk content. We treat
 * retrieved chunks as untrusted data because they were ingested from PDFs that
 * an admin uploaded (and in a CTF-like adversarial scenario, anyone with
 * upload rights could plant instructions). The model is also told to treat
 * everything inside <context> as data — sanitization + the system-prompt
 * clause + the wrapping tags together harden against prompt injection.
 * (B1 / C6)
 */
export function sanitizeChunkContent(content: string): string {
  return content
    // Imperative override phrases (case-insensitive). Replace with [redacted]
    // so the chunk still flows naturally without the injection.
    .replace(
      /\b(?:ignore|disregard|forget|override)\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|earlier|system|user|admin)\s+(?:instructions?|prompts?|rules?|directions?|context)/gi,
      '[redacted]',
    )
    // Pseudo-role separators that LLM tokenizers can interpret as messages.
    .replace(/\b(system|assistant|user|human|developer)\s*:\s*/gi, '$1​:')
    // ChatML / Llama / Anthropic-style special tokens.
    .replace(/<\|(?:im_start|im_end|endoftext|system|user|assistant)\|>/gi, '')
    .replace(/\[(?:INST|\/INST)\]/g, '')
    // Closing the <context> wrapper from inside is the obvious break-out.
    .replace(/<\/?context>/gi, '')
    // Excessive blank-line runs that could fake a new section in the prompt.
    .replace(/\n{4,}/g, '\n\n\n');
}

export function buildContext(chunks: MatchedChunk[]): string {
  if (chunks.length === 0) return '';

  const contextParts = chunks.map((chunk, index) => {
    const page = chunk.metadata.page || 'N/A';
    const section = chunk.metadata.section || '';
    const chapter = chunk.metadata.chapter || '';
    const docId = chunk.metadata.documentName;
    const docInfo = docId ? getDocumentByIdSync(docId) : undefined;
    const docLabel = docInfo ? docInfo.displayName : 'Building Code';

    const truncated = chunk.content.length > MAX_CHUNK_LENGTH
      ? chunk.content.slice(0, MAX_CHUNK_LENGTH) + '...'
      : chunk.content;
    const content = sanitizeChunkContent(truncated);

    const header = `[SOURCE ${index + 1}] Document: ${docLabel}, Page ${page}${section ? `, Section ${section}` : ''}${chapter ? `, ${chapter}` : ''}`;

    // Wrap each chunk in <context> tags so the model can syntactically tell
    // where data begins and ends. Combined with the sanitizer's stripping of
    // </context>, this prevents a chunk from closing its own wrapper.
    return `<context source="${index + 1}">\n${header}\n${content}\n</context>`;
  });

  const docNames = new Set(chunks.map(c => {
    const docId = c.metadata.documentName;
    const info = docId ? getDocumentByIdSync(docId) : undefined;
    return info?.displayName || 'Building Code';
  }));
  const docsHeader = `CONTEXT FROM: ${Array.from(docNames).join(', ')}`;

  return `${docsHeader}:\n\n${contextParts.join('\n\n')}`;
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
    keyword_weight: KEYWORD_WEIGHT,
    vector_weight: VECTOR_WEIGHT,
    rrf_k: HYBRID_SEARCH_RRF_K,
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

  return ((data || []) as HybridRpcRow[]).map(mapHybridRow);
}

async function hybridSearchWithPostFilter(
  query: string,
  pageRanges: PageRange[],
  matchCount: number,
  precomputedEmbedding?: number[]
): Promise<HybridSearchResult[]> {
  // PSE2 (v1.5.0 re-audit): the DB-side cap is LEAST(match_count, 50). Asking
  // for matchCount * 3 here used to over-fetch (since the DB silently truncated
  // to a higher implicit limit), giving the post-filter a wide candidate pool.
  // Now the DB caps at 50, so requesting matchCount * 3 with matchCount > 16
  // collapses to the same 50 — wasted clamp on the DB side. Cap at 50 here
  // so the call shape stays honest, AND we still get the widest pool the DB
  // is willing to return for the post-filter step.
  const expandedCount = Math.min(matchCount * 3, 50);
  const results = await hybridSearch(query, expandedCount, {
    precomputedEmbedding: precomputedEmbedding,
  });

  const filtered = results.filter(result => {
    const chunkStart = result.metadata.startPage ?? result.metadata.page ?? 0;
    const chunkEnd = result.metadata.endPage ?? result.metadata.page ?? 0;

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

  const exactChunks = await runExactSearchIfApplicable(query, pageRanges);
  const hybridResults = await filteredHybridSearch(
    query, pageRanges, matchCount, params.precomputedEmbedding,
  );

  return assembleRAGResult(exactChunks, hybridResults);
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
