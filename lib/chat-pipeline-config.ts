// ============================================================================
// Chat Pipeline Configuration (v1.7.0 Part G — extracted from chat-pipeline.ts)
// ============================================================================
//
// Extracted so lib/rag.ts and lib/heuristic-reranker.ts can read pipeline
// tunables without importing the whole chat-pipeline module (which itself
// imports both of them — that's the cycle that the extraction breaks).
// ============================================================================

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

  // v1.7.0 Part G (A-M-4) — heuristic reranker weights surfaced here so an
  // operator can tune them without editing lib/heuristic-reranker.ts. Sum
  // should add to 1.0; the reranker doesn't enforce that, it just composes
  // the weighted score literally. Defaults preserved from v0.
  RERANK_WEIGHT_HYBRID: 0.4,
  RERANK_WEIGHT_KEYWORD: 0.3,
  RERANK_WEIGHT_METADATA: 0.2,
  RERANK_WEIGHT_POSITION: 0.1,

  // v1.7.0 Part G (A-M-4) — CRAG threshold lives next to the reranker
  // weights so an operator can lift/lower the "good-enough search" bar
  // alongside the reranker tuning. The constant in lib/rag.ts now reads
  // from here.
  CRAG_THRESHOLD: 0.08,
} as const;
