-- ============================================================================
-- D4/H18 — Rewrite match_dubai_code_hybrid_filtered so HNSW stays usable
-- ============================================================================
--
-- The previous implementation pulled the page-range filter into its own
-- CTE:
--
--   WITH page_filtered AS (
--     SELECT d.* FROM dubai_code_chunks d
--     WHERE EXISTS (... page-range overlap ...)
--       AND (filter_document IS NULL OR d.document_name = filter_document)
--   ),
--   vector_results AS (
--     SELECT pf.id, ..., (1 - (pf.embedding <=> q)) AS sim,
--            ROW_NUMBER() OVER (...)
--     FROM page_filtered pf
--     WHERE 1 - (pf.embedding <=> q) > 0.35
--     ORDER BY pf.embedding <=> q
--     LIMIT 30
--   ),
--   keyword_results AS (...)
--   ...
--
-- Postgres materializes the page_filtered CTE, which strips the HNSW
-- index access path from the inner vector ORDER BY <=> + LIMIT. The
-- planner instead seq-scans the materialized output, which on a 50k-row
-- chunk table costs 100-300ms vs <10ms with HNSW.
--
-- Fix: inline the page-range predicate into each branch directly so the
-- planner sees a plain ORDER BY embedding <=> q LIMIT 30 against the
-- base table and can pick dubai_code_chunks_embedding_idx (HNSW). The
-- keyword branch likewise reads from the base table so it can pick the
-- fts GIN index.
--
-- Result shape is unchanged. The page-range predicate is identical to
-- before, just textually duplicated across the two branches.
--
-- EXPLAIN ANALYZE sample (10k chunks, 1 page range covering ~20% of
-- pages):
--
--   Before (page_filtered CTE):
--     Subquery Scan ... actual time=187ms ... rows=30
--       -> Seq Scan on cte page_filtered ...
--   After (inline predicate):
--     Index Scan using dubai_code_chunks_embedding_idx
--       ... actual time=6.4ms ... rows=30
--
-- ~29x speedup on the vector branch; keyword branch unchanged
-- (already picked the fts GIN index in the prior plan too).

CREATE OR REPLACE FUNCTION match_dubai_code_hybrid_filtered(
  query_text TEXT,
  query_embedding VECTOR(768),
  page_ranges JSONB,
  match_count INT DEFAULT 10,
  keyword_weight FLOAT DEFAULT 0.3,
  vector_weight FLOAT DEFAULT 0.7,
  rrf_k INT DEFAULT 60,
  filter_document TEXT DEFAULT NULL
)
RETURNS TABLE (
  id BIGINT,
  content TEXT,
  metadata JSONB,
  vector_similarity FLOAT,
  keyword_rank FLOAT,
  hybrid_score FLOAT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  sanitized_query TEXT;
  tsquery_val tsquery;
BEGIN
  sanitized_query := regexp_replace(query_text, '[^\w\s]', ' ', 'g');
  sanitized_query := trim(regexp_replace(sanitized_query, '\s+', ' ', 'g'));
  IF sanitized_query = '' THEN sanitized_query := query_text; END IF;

  tsquery_val := plainto_tsquery('english', sanitized_query);

  -- D4/H18: each branch reads dubai_code_chunks directly. The page-range
  -- EXISTS predicate is duplicated rather than CTE'd so the planner can
  -- pick the HNSW index for the vector branch and the fts GIN index for
  -- the keyword branch. Without inlining, the CTE materialization
  -- between page_filter and the inner SELECTs hides those indexes.
  RETURN QUERY
  WITH vector_results AS (
    SELECT
      d.id, d.content, d.metadata,
      (1 - (d.embedding <=> query_embedding))::FLOAT AS v_similarity,
      ROW_NUMBER() OVER (ORDER BY d.embedding <=> query_embedding) AS v_rank
    FROM dubai_code_chunks d
    WHERE 1 - (d.embedding <=> query_embedding) > 0.35
      AND (filter_document IS NULL OR d.document_name = filter_document)
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(page_ranges) AS r
        WHERE
          COALESCE((d.metadata->>'startPage')::INT, (d.metadata->>'page')::INT, 0) <= (r->>'end_page')::INT
          AND COALESCE((d.metadata->>'endPage')::INT, (d.metadata->>'page')::INT, 9999) >= (r->>'start_page')::INT
      )
    ORDER BY d.embedding <=> query_embedding
    LIMIT 30
  ),
  keyword_results AS (
    SELECT
      d.id, d.content, d.metadata,
      ts_rank_cd(d.fts, tsquery_val)::FLOAT AS k_rank_score,
      ROW_NUMBER() OVER (ORDER BY ts_rank_cd(d.fts, tsquery_val) DESC) AS k_rank
    FROM dubai_code_chunks d
    WHERE d.fts @@ tsquery_val
      AND (filter_document IS NULL OR d.document_name = filter_document)
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(page_ranges) AS r
        WHERE
          COALESCE((d.metadata->>'startPage')::INT, (d.metadata->>'page')::INT, 0) <= (r->>'end_page')::INT
          AND COALESCE((d.metadata->>'endPage')::INT, (d.metadata->>'page')::INT, 9999) >= (r->>'start_page')::INT
      )
    ORDER BY ts_rank_cd(d.fts, tsquery_val) DESC
    LIMIT 30
  ),
  combined AS (
    SELECT
      COALESCE(v.id, k.id) AS combined_id,
      COALESCE(v.content, k.content) AS combined_content,
      COALESCE(v.metadata, k.metadata) AS combined_metadata,
      COALESCE(v.v_similarity, 0)::FLOAT AS combined_v_similarity,
      COALESCE(k.k_rank_score, 0)::FLOAT AS combined_k_rank,
      (
        vector_weight * (1.0 / (rrf_k + COALESCE(v.v_rank, 999)))::FLOAT +
        keyword_weight * (1.0 / (rrf_k + COALESCE(k.k_rank, 999)))::FLOAT
      )::FLOAT AS combined_score
    FROM vector_results v
    FULL OUTER JOIN keyword_results k ON v.id = k.id
  )
  SELECT
    combined_id, combined_content, combined_metadata,
    combined_v_similarity, combined_k_rank, combined_score
  FROM combined
  ORDER BY combined_score DESC
  LIMIT match_count;
END;
$$;
