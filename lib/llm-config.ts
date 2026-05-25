// ============================================================================
// LLM Provider Configuration (v1.7.0 Part F / A-H-8)
// ============================================================================
//
// Two responsibilities:
//   1. Single source of truth for which Gemini model IDs the app uses, so a
//      provider-side rename (gemini-2.5-flash → gemini-2.6-flash) needs one
//      edit instead of N. Three sites in lib/gemini.ts used to hardcode this.
//   2. Allow env-var overrides so a defense-day demo can A/B test a faster
//      model without a code change.
//
// NOT a multi-provider abstraction. A real provider swap (Anthropic, OpenAI,
// Mistral) needs streaming + tool-call shape work that's out of scope for
// the diploma. This is just the "model name lives here" pass.
// ============================================================================

/** Chat completion model — temperature=0 reasoner used by both streaming + non-streaming paths. */
export const GEMINI_MODEL_CHAT = process.env.GEMINI_MODEL_CHAT || 'gemini-2.5-flash';

/** Embedding model — 768-dim vectors to match the DB VECTOR(768) columns. Bump the column too if you change this. */
export const GEMINI_MODEL_EMBED = process.env.GEMINI_MODEL_EMBED || 'gemini-embedding-001';

/** Embedding output dimensionality. Must match `dubai_code_chunks.embedding` + `semantic_cache.query_embedding`. */
export const GEMINI_EMBED_DIMS = 768;

// v1.7.0 re-audit (M-2): GEMINI_MODEL_EMBED is env-overridable for A/B
// testing, but the DB column is VECTOR(768) and pgvector rejects
// dimension-mismatched inserts. The list below is the set of Gemini models
// known to honour `outputDimensionality: 768`. An operator swapping in
// e.g. `gemini-embedding-large` would silently produce >768-dim vectors
// and break ingestion mid-batch. Warn loudly at module load when the
// override is set to anything outside this allowlist — the operator can
// still proceed (they may have validated a new model out of band) but the
// log makes the footgun visible.
const SUPPORTED_EMBED_MODELS_768D = new Set([
  'gemini-embedding-001',
  'text-embedding-004', // legacy alias still accepted by the API
]);

if (
  process.env.GEMINI_MODEL_EMBED &&
  !SUPPORTED_EMBED_MODELS_768D.has(process.env.GEMINI_MODEL_EMBED)
) {
  console.warn(
    `[llm-config] GEMINI_MODEL_EMBED="${process.env.GEMINI_MODEL_EMBED}" is not in the ` +
      `768-dim allowlist (${Array.from(SUPPORTED_EMBED_MODELS_768D).join(', ')}). ` +
      `If this model produces a different dimensionality, pgvector inserts into ` +
      `dubai_code_chunks.embedding and semantic_cache.query_embedding will fail. ` +
      `Re-ingest all documents AND alter the column type before proceeding.`,
  );
}
