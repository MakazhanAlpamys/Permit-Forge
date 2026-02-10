-- ============================================================================
-- Migration 004: Multi-Document RAG Support
-- Adds document_name column to dubai_code_chunks and updates all RPC functions
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Add document_name column to dubai_code_chunks
-- ---------------------------------------------------------------------------

ALTER TABLE dubai_code_chunks
  ADD COLUMN IF NOT EXISTS document_name TEXT NOT NULL DEFAULT 'dubai-building-code-2021';

-- Index for document filtering
CREATE INDEX IF NOT EXISTS idx_chunks_document_name
  ON dubai_code_chunks(document_name);

-- Composite index for document + page range filtering
CREATE INDEX IF NOT EXISTS idx_chunks_doc_pages
  ON dubai_code_chunks(document_name, ((metadata->>'startPage')::INT), ((metadata->>'endPage')::INT));

-- ---------------------------------------------------------------------------
-- 2. Update match_dubai_code to support optional document filtering
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION match_dubai_code(
  query_embedding VECTOR(768),
  match_count INT DEFAULT 5,
  filter JSONB DEFAULT '{}',
  filter_document TEXT DEFAULT NULL
)
RETURNS TABLE (
  id BIGINT,
  content TEXT,
  metadata JSONB,
  similarity FLOAT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    d.id,
    d.content,
    d.metadata,
    (1 - (d.embedding <=> query_embedding))::FLOAT AS similarity
  FROM dubai_code_chunks d
  WHERE 1 - (d.embedding <=> query_embedding) > 0.5
    AND (filter_document IS NULL OR d.document_name = filter_document)
  ORDER BY d.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Update search_dubai_code_keywords
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION search_dubai_code_keywords(
  search_query TEXT,
  match_count INT DEFAULT 25,
  filter_document TEXT DEFAULT NULL
)
RETURNS TABLE (
  id BIGINT,
  content TEXT,
  metadata JSONB,
  rank FLOAT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  sanitized_query TEXT;
  tsquery_val tsquery;
BEGIN
  sanitized_query := regexp_replace(search_query, '[^\w\s]', ' ', 'g');
  sanitized_query := trim(regexp_replace(sanitized_query, '\s+', ' ', 'g'));

  IF sanitized_query = '' THEN
    RETURN;
  END IF;

  tsquery_val := plainto_tsquery('english', sanitized_query);

  RETURN QUERY
  SELECT
    d.id,
    d.content,
    d.metadata,
    ts_rank_cd(d.fts, tsquery_val)::FLOAT AS rank
  FROM dubai_code_chunks d
  WHERE d.fts @@ tsquery_val
    AND (filter_document IS NULL OR d.document_name = filter_document)
  ORDER BY ts_rank_cd(d.fts, tsquery_val) DESC
  LIMIT LEAST(match_count, 100);
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Update match_dubai_code_hybrid (main search function)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION match_dubai_code_hybrid(
  query_text TEXT,
  query_embedding VECTOR(768),
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
SET search_path = public
AS $$
DECLARE
  sanitized_query TEXT;
  tsquery_val tsquery;
BEGIN
  sanitized_query := regexp_replace(query_text, '[^\w\s]', ' ', 'g');
  sanitized_query := trim(regexp_replace(sanitized_query, '\s+', ' ', 'g'));

  IF sanitized_query = '' THEN
    sanitized_query := query_text;
  END IF;

  tsquery_val := plainto_tsquery('english', sanitized_query);

  RETURN QUERY
  WITH vector_results AS (
    SELECT
      d.id,
      d.content,
      d.metadata,
      (1 - (d.embedding <=> query_embedding))::FLOAT AS v_similarity,
      ROW_NUMBER() OVER (ORDER BY d.embedding <=> query_embedding) AS v_rank
    FROM dubai_code_chunks d
    WHERE 1 - (d.embedding <=> query_embedding) > 0.4
      AND (filter_document IS NULL OR d.document_name = filter_document)
    ORDER BY d.embedding <=> query_embedding
    LIMIT 50
  ),
  keyword_results AS (
    SELECT
      d.id,
      d.content,
      d.metadata,
      ts_rank_cd(d.fts, tsquery_val)::FLOAT AS k_rank_score,
      ROW_NUMBER() OVER (ORDER BY ts_rank_cd(d.fts, tsquery_val) DESC) AS k_rank
    FROM dubai_code_chunks d
    WHERE d.fts @@ tsquery_val
      AND (filter_document IS NULL OR d.document_name = filter_document)
    ORDER BY ts_rank_cd(d.fts, tsquery_val) DESC
    LIMIT 50
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
    combined_id AS id,
    combined_content AS content,
    combined_metadata AS metadata,
    combined_v_similarity AS vector_similarity,
    combined_k_rank AS keyword_rank,
    combined_score AS hybrid_score
  FROM combined
  ORDER BY combined_score DESC
  LIMIT match_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Update search_dubai_code_exact
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION search_dubai_code_exact(
  search_pattern TEXT,
  match_count INT DEFAULT 10,
  filter_document TEXT DEFAULT NULL
)
RETURNS TABLE (
  id BIGINT,
  content TEXT,
  metadata JSONB,
  match_position INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  safe_pattern TEXT;
BEGIN
  safe_pattern := regexp_replace(search_pattern, '([%_\\])', '\\\1', 'g');

  RETURN QUERY
  SELECT
    d.id,
    d.content,
    d.metadata,
    POSITION(LOWER(safe_pattern) IN LOWER(d.content))::INT AS match_position
  FROM dubai_code_chunks d
  WHERE LOWER(d.content) LIKE '%' || LOWER(safe_pattern) || '%'
    AND (filter_document IS NULL OR d.document_name = filter_document)
  ORDER BY match_position
  LIMIT LEAST(match_count, 100);
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. Update find_chunks_by_page
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION find_chunks_by_page(
  target_page INT,
  match_count INT DEFAULT 10,
  filter_document TEXT DEFAULT NULL
)
RETURNS TABLE (
  id BIGINT,
  content TEXT,
  metadata JSONB,
  page_match_type TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    d.id,
    d.content,
    d.metadata,
    CASE
      WHEN (d.metadata->>'startPage')::INT = target_page
           AND (d.metadata->>'endPage')::INT = target_page THEN 'exact'
      WHEN (d.metadata->>'startPage')::INT <= target_page
           AND (d.metadata->>'endPage')::INT >= target_page THEN 'range'
      WHEN (d.metadata->>'page')::INT = target_page THEN 'legacy'
      ELSE 'none'
    END AS page_match_type
  FROM dubai_code_chunks d
  WHERE
    (
      (d.metadata->>'startPage')::INT <= target_page
      AND (d.metadata->>'endPage')::INT >= target_page
    )
    OR (d.metadata->>'page')::INT = target_page
  AND (filter_document IS NULL OR d.document_name = filter_document)
  ORDER BY
    CASE
      WHEN (d.metadata->>'startPage')::INT = target_page
           AND (d.metadata->>'endPage')::INT = target_page THEN 1
      WHEN (d.metadata->>'page')::INT = target_page THEN 2
      ELSE 3
    END,
    d.id
  LIMIT match_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- 7. Update find_chunks_by_section
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION find_chunks_by_section(
  section_number TEXT,
  match_count INT DEFAULT 10,
  filter_document TEXT DEFAULT NULL
)
RETURNS TABLE (
  id BIGINT,
  content TEXT,
  metadata JSONB,
  section_match_type TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    d.id,
    d.content,
    d.metadata,
    CASE
      WHEN d.metadata->>'section' = section_number THEN 'exact'
      WHEN d.metadata->>'section' LIKE section_number || '.%' THEN 'child'
      WHEN section_number LIKE (d.metadata->>'section') || '.%' THEN 'parent'
      ELSE 'none'
    END AS section_match_type
  FROM dubai_code_chunks d
  WHERE
    (
      d.metadata->>'section' = section_number
      OR d.metadata->>'section' LIKE section_number || '.%'
      OR section_number LIKE (d.metadata->>'section') || '.%'
    )
    AND (filter_document IS NULL OR d.document_name = filter_document)
  ORDER BY
    CASE
      WHEN d.metadata->>'section' = section_number THEN 1
      WHEN d.metadata->>'section' LIKE section_number || '.%' THEN 2
      WHEN section_number LIKE (d.metadata->>'section') || '.%' THEN 3
      ELSE 4
    END,
    (d.metadata->>'startPage')::INT
  LIMIT match_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- 8. Update match_citation
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION match_citation(
  citation_page INT,
  citation_section TEXT DEFAULT NULL,
  match_count INT DEFAULT 5,
  filter_document TEXT DEFAULT NULL
)
RETURNS TABLE (
  id BIGINT,
  content TEXT,
  metadata JSONB,
  match_score INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    d.id,
    d.content,
    d.metadata,
    (
      -- Page matching (0-50 points)
      CASE
        WHEN (d.metadata->>'startPage')::INT = citation_page
             AND (d.metadata->>'endPage')::INT = citation_page THEN 50
        WHEN (d.metadata->>'startPage')::INT <= citation_page
             AND (d.metadata->>'endPage')::INT >= citation_page THEN 30
        WHEN (d.metadata->>'page')::INT = citation_page THEN 40
        ELSE 0
      END
      +
      -- Section matching (0-50 points)
      CASE
        WHEN citation_section IS NOT NULL AND d.metadata->>'section' = citation_section THEN 50
        WHEN citation_section IS NOT NULL AND d.metadata->>'section' LIKE citation_section || '%' THEN 20
        WHEN citation_section IS NULL THEN 10
        ELSE 0
      END
    )::INT AS match_score
  FROM dubai_code_chunks d
  WHERE
    (
      (d.metadata->>'startPage')::INT <= citation_page
      AND (d.metadata->>'endPage')::INT >= citation_page
    )
    OR (d.metadata->>'page')::INT = citation_page
  AND (filter_document IS NULL OR d.document_name = filter_document)
  ORDER BY match_score DESC
  LIMIT match_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- 9. Update match_dubai_code_hybrid_filtered (Tree Reasoning)
-- ---------------------------------------------------------------------------

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
SET search_path = public
AS $$
DECLARE
  sanitized_query TEXT;
  tsquery_val tsquery;
BEGIN
  sanitized_query := regexp_replace(query_text, '[^\w\s]', ' ', 'g');
  sanitized_query := trim(regexp_replace(sanitized_query, '\s+', ' ', 'g'));

  IF sanitized_query = '' THEN
    sanitized_query := query_text;
  END IF;

  tsquery_val := plainto_tsquery('english', sanitized_query);

  RETURN QUERY
  WITH page_filtered AS (
    SELECT d.*
    FROM dubai_code_chunks d
    WHERE EXISTS (
      SELECT 1
      FROM jsonb_array_elements(page_ranges) AS r
      WHERE (
        COALESCE((d.metadata->>'startPage')::INT, (d.metadata->>'page')::INT, 0) <= (r->>'end_page')::INT
        AND COALESCE((d.metadata->>'endPage')::INT, (d.metadata->>'page')::INT, 9999) >= (r->>'start_page')::INT
      )
    )
    AND (filter_document IS NULL OR d.document_name = filter_document)
  ),
  vector_results AS (
    SELECT
      pf.id,
      pf.content,
      pf.metadata,
      (1 - (pf.embedding <=> query_embedding))::FLOAT AS v_similarity,
      ROW_NUMBER() OVER (ORDER BY pf.embedding <=> query_embedding) AS v_rank
    FROM page_filtered pf
    WHERE 1 - (pf.embedding <=> query_embedding) > 0.35
    ORDER BY pf.embedding <=> query_embedding
    LIMIT 30
  ),
  keyword_results AS (
    SELECT
      pf.id,
      pf.content,
      pf.metadata,
      ts_rank_cd(pf.fts, tsquery_val)::FLOAT AS k_rank_score,
      ROW_NUMBER() OVER (ORDER BY ts_rank_cd(pf.fts, tsquery_val) DESC) AS k_rank
    FROM page_filtered pf
    WHERE pf.fts @@ tsquery_val
    ORDER BY ts_rank_cd(pf.fts, tsquery_val) DESC
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
    combined_id AS id,
    combined_content AS content,
    combined_metadata AS metadata,
    combined_v_similarity AS vector_similarity,
    combined_k_rank AS keyword_rank,
    combined_score AS hybrid_score
  FROM combined
  ORDER BY combined_score DESC
  LIMIT match_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- 10. New helper: get chunks count per document
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION get_document_stats()
RETURNS TABLE (
  document_name TEXT,
  chunk_count BIGINT,
  min_page INT,
  max_page INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    d.document_name,
    COUNT(*)::BIGINT AS chunk_count,
    MIN(COALESCE((d.metadata->>'startPage')::INT, (d.metadata->>'page')::INT, 0))::INT AS min_page,
    MAX(COALESCE((d.metadata->>'endPage')::INT, (d.metadata->>'page')::INT, 0))::INT AS max_page
  FROM dubai_code_chunks d
  GROUP BY d.document_name
  ORDER BY d.document_name;
END;
$$;

-- Grant permissions
GRANT EXECUTE ON FUNCTION get_document_stats() TO service_role;
REVOKE EXECUTE ON FUNCTION get_document_stats() FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- 11. New helper: clear chunks for a specific document
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION clear_document_chunks(target_document TEXT)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  deleted_count BIGINT;
BEGIN
  DELETE FROM dubai_code_chunks WHERE document_name = target_document;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

GRANT EXECUTE ON FUNCTION clear_document_chunks(TEXT) TO service_role;
REVOKE EXECUTE ON FUNCTION clear_document_chunks(TEXT) FROM anon, authenticated;
