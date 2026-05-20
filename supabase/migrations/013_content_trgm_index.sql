-- ============================================================================
-- D3/H17 — Trigram expression index on LOWER(dubai_code_chunks.content)
-- ============================================================================
--
-- search_dubai_code_exact runs:
--   WHERE LOWER(d.content) LIKE '%' || LOWER(safe_pattern) || '%'
--
-- Without a matching expression index, that forces a seq-scan over
-- dubai_code_chunks (currently 10k+ rows after a single PDF ingest). The
-- pg_trgm extension's gin_trgm_ops opclass supports left-and-right
-- wildcard LIKE patterns; combined with a functional index over
-- LOWER(content), the planner can pick the index for any substring
-- search.
--
-- pg_trgm is already enabled (see 000_full_setup.sql §1 EXTENSIONS).

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS dubai_code_chunks_content_lower_trgm_idx
  ON dubai_code_chunks USING gin (LOWER(content) gin_trgm_ops);
