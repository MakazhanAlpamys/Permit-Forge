# Pipeline Optimization Plan

## Current State (v1)

- 3-9 API calls per question (embedding + LLM)
- Query Expansion: 1 LLM + 1-4 embeddings (generates 3-5 query variations)
- LLM Reranker: 1 LLM (scores each chunk 0-100)
- Answer Verification: 1 LLM (self-check for hallucinations)
- Citation parsing: depends on LLM writing [Page X] in text (unreliable)
- No caching
- Searches all documents every time
- Fixed chunk size 800 chars

## Target State (v2)

- 1-2 API calls per question (~1.5 average with cache hits)
- Semantic caching (30-40% hit rate in production)
- Chunk-based citations (100% accurate, no LLM dependency)
- Document-aware search (scalable to 50+ documents)
- Parent-child chunking (better context for LLM)

---

## New Pipeline

```
Query
  |
  v
[1] Semantic Cache (1 embedding, reused later)
  |-- HIT --> cached response + citations (0 more API, done)
  |-- MISS --> continue
  |
  v
[2] Topic Classification (regex --> LLM fallback)
  |-- OFF_TOPIC --> template response (done)
  |-- GREETING --> template response (done)
  |-- ON_TOPIC --> continue
  |
  v
[3] Document Selector (keyword scoring on registry, 0 API)
  |--> selects 1-3 documents if confident
  |--> all documents if scores are close (difference < 20%)
  |
  v
[4] Scope Detector (regex, 0 API)
  |--> adds page range filter if query mentions chapter/section
  |
  v
[5] Hybrid Search (reuses embedding from step 1)
  |--> vector (0.7) + keyword FTS (0.3), RRF fusion
  |--> filtered by: selected documents + page ranges
  |
  v
[6] CRAG Check (0 API)
  |-- top score < 0.3 --> "information not found" (done)
  |-- OK --> continue
  |
  v
[7] Heuristic Rerank + Diversity (0 API, ~1ms)
  |--> score = hybrid_score * 0.4 + keyword_overlap * 0.3
  |          + metadata_match * 0.2 + position_bonus * 0.1
  |--> max 3 chunks per document, max 2 per page range
  |
  v
[8] Parent Chunk Expansion (DB lookup, 0 API)
  |--> replace child chunks with their parent chunks for richer context
  |
  v
[9] LLM Generation (1 LLM, streaming)
  |--> strict prompt: answer ONLY from context, never invent
  |--> no need to write citations in text
  |
  v
[10] Chunk-Based Citations (0 API)
  |--> sources = metadata from chunks used in context
  |--> each citation: document_name, startPage, endPage, section, excerpt
  |--> 100% accurate (comes from ingestion, not LLM)
  |
  v
[11] Cache Store (0 API)
  |--> store: query_embedding + response + citations
  |--> TTL: 1 hour
```

## API Calls Per Scenario

| Scenario              | Embedding | LLM | Total |
|-----------------------|-----------|-----|-------|
| Cache hit             | 1         | 0   | 1     |
| Greeting (regex)      | 0         | 0   | 0     |
| Greeting (LLM)        | 0         | 1   | 1     |
| Off-topic (regex)     | 0         | 0   | 0     |
| Off-topic (LLM)       | 0         | 1   | 1     |
| Weak search (CRAG)    | 1         | 0   | 1     |
| Full pipeline         | 1         | 1   | 2     |
| Average (with cache)  | ~0.8      | ~0.7| ~1.5  |

---

## What Gets Removed

| Component | Was | Why remove |
|-----------|-----|------------|
| Query Expansion | 1 LLM + 1-4 embeddings | Hybrid search already covers synonyms via keyword FTS; vector covers semantics |
| LLM Reranker | 1 LLM | Replace with heuristic scoring (~1ms, 0 API) |
| Answer Verification | 1 LLM | Replace with CRAG pre-check + strict prompt (prevents vs catches) |
| LLM-based citations | regex parse of LLM text | Replace with chunk metadata (100% accurate) |
| classifyQueryStructure two-path routing | structural vs standard | Merge into single path with optional filters |

## What Gets Added

| Component | Cost | Why |
|-----------|------|-----|
| Semantic Cache | 0 API (uses same embedding) | 30-40% queries skipped entirely |
| Document Selector | 0 API | Reduces noise at scale, focuses search |
| Scope Detector | 0 API | Replaces Tree Reasoning two-path split |
| CRAG Check | 0 API | Prevents hallucinations before generation |
| Heuristic Reranker | 0 API | Replaces LLM reranker, ~1ms |
| Chunk-based citations | 0 API | 100% accurate, no LLM dependency |
| Parent chunk expansion | 0 API (DB) | Better context for LLM |

---

## Citation System (v2)

### Problem with current approach
- LLM writes [Page 45, Section 3.2] in response text
- 9 regex patterns parse these from response
- match_citation RPC looks up chunk by page/section
- If LLM invents a page number --> wrong citation or no match

### New approach: chunk-based citations
- Citations come directly from chunks used as context
- Each chunk has exact metadata from ingestion: startPage, endPage, section, sectionTitle, document_name
- After reranking, top 5-7 chunks = the sources
- No parsing needed, no LLM dependency, 100% accurate
- LLM response text: stripped of inline citations (cleaner)
- System prompt tells LLM: "Do not write page references. Sources are shown separately."

### Citation data structure (unchanged)
```typescript
{
  chunkId: number;
  page: number;
  startPage: number;
  endPage: number;
  section: string;
  sectionTitle: string;
  excerpt: string;        // first 200 chars of chunk
  similarity: number;     // search score
  confidence: number;     // rerank score normalized to 0-100
  documentName: string;
  contentType: string;    // text | table | list
  isVerified: true;       // always true (from DB, not LLM)
}
```

---

## Scalability (Future)

### Document Selector details
Each document in registry gets:
- keywords: string[] (domain terms found in this document)
- categories: string[] (structural, safety, mep, environmental, etc.)

Selector scores query against each document's keywords.
If top score >> others (>20% gap) --> filter to top 1-3 docs.
If scores are close --> search all (safe fallback).

### Database changes for scale
1. HNSW index instead of IVFFlat (stable recall at any scale)
2. document_registry table in DB (not hardcoded in code)
3. Per-document tree cache (load only selected docs, not all)
4. Adaptive chunk limits (1 doc = 7 chunks, 2 docs = 4 each, 3 docs = 3 each)

### Parent-child chunking (requires re-ingestion)
- Child chunks: 400 chars (for embedding + search, higher precision)
- Parent chunks: 2000 chars (for LLM context, richer information)
- Child references parent via parent_id
- Only child chunks get embeddings (saves API during ingestion)
- Search finds child --> LLM receives parent

---

## Implementation Phases

### Phase 1: Pipeline optimization (no re-ingestion needed)
Files to modify:
- lib/chat-pipeline.ts -- remove query expansion, verification; add CRAG check
- lib/agents.ts -- remove expandQuery, rerankChunks, verifyAnswer; add heuristic reranker
- lib/rag.ts -- accept pre-computed embedding; add document filter param
- lib/citation-parser.ts -- simplify to chunk-based citations
- lib/semantic-cache.ts -- NEW: semantic cache with pgvector
- lib/document-selector.ts -- NEW: keyword-based document scoring
- app/api/chat/stream/route.ts -- update pipeline flow
- components/chat/message-bubble.tsx -- remove stripInlineCitations (LLM won't write them)
- lib/gemini.ts -- update system prompt (no inline citations)

### Phase 2: Database improvements
- Add semantic_cache table (query_embedding, response, citations, created_at)
- Add HNSW index option
- Move document_registry to DB table
- Update 000_full_setup.sql

### Phase 3: Parent-child chunking (requires re-ingestion)
- Add parent_chunks table (content, metadata, no embedding)
- Modify dubai_code_chunks to add parent_id column
- Update lib/pdf-ingestion.ts for two-level chunking
- Re-ingest all documents
- Update search to return parent content

### Phase 4: Admin UI for dynamic documents
- Document registry CRUD in admin panel
- Upload any PDF --> auto-register + ingest
- Per-document stats and management
- Delete/re-ingest individual documents

---

## System Prompt (v2)

```
You are Emirate Forge, a Dubai construction compliance assistant.

RULES:
1. Answer ONLY using the provided CONTEXT. Never invent information.
2. If the CONTEXT does not contain the answer, say: "I could not find this information in the available documents."
3. Do NOT write page numbers, section references, or citations in your response. Sources are displayed separately below your answer.
4. Be precise with numbers, measurements, and requirements.
5. Use bullet points and headers for clarity.
6. You can respond in any language the user writes in.
```

This prompt:
- Eliminates need for citation parsing (saves complexity)
- Prevents hallucinations at source (strict context-only rule)
- Replaces post-generation verification
- Cleaner response text (no [Page X] clutter)
