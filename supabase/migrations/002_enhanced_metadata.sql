-- ============================================================================
-- Migration 002: Enhanced Metadata for Precise Citations
-- ============================================================================
-- 
-- This migration adds support for:
-- - Page ranges (startPage, endPage) instead of single page
-- - Section hierarchy from TOC (sectionPath)
-- - Content type detection (text, table, list, heading)
--
-- Note: The metadata column is already JSONB, so new fields are automatically
-- supported. This migration adds indexes and helper functions for the new fields.
-- ============================================================================

-- ============================================================================
-- 1. INDEX FOR PAGE RANGE QUERIES
-- ============================================================================

-- Index for querying by startPage (useful for citation matching)
CREATE INDEX IF NOT EXISTS idx_chunks_start_page 
ON dubai_code_chunks ((metadata->>'startPage'));

-- Index for querying by endPage
CREATE INDEX IF NOT EXISTS idx_chunks_end_page 
ON dubai_code_chunks ((metadata->>'endPage'));

-- Index for section lookups
CREATE INDEX IF NOT EXISTS idx_chunks_section 
ON dubai_code_chunks ((metadata->>'section'));

-- Index for content type filtering
CREATE INDEX IF NOT EXISTS idx_chunks_content_type 
ON dubai_code_chunks ((metadata->>'contentType'));

-- ============================================================================
-- 2. HELPER FUNCTION: Find chunks by page range
-- ============================================================================

CREATE OR REPLACE FUNCTION find_chunks_by_page(
  target_page INT,
  match_count INT DEFAULT 10
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
    END as page_match_type
  FROM dubai_code_chunks d
  WHERE 
    -- New format: check page range
    (
      (d.metadata->>'startPage')::INT <= target_page 
      AND (d.metadata->>'endPage')::INT >= target_page
    )
    -- Legacy format: check single page
    OR (d.metadata->>'page')::INT = target_page
  ORDER BY 
    -- Prioritize exact matches, then ranges
    CASE 
      WHEN (d.metadata->>'startPage')::INT = target_page THEN 0
      ELSE 1
    END,
    d.id
  LIMIT match_count;
END;
$$;

-- ============================================================================
-- 3. HELPER FUNCTION: Find chunks by section
-- ============================================================================

CREATE OR REPLACE FUNCTION find_chunks_by_section(
  section_number TEXT,
  match_count INT DEFAULT 10
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
    END as section_match_type
  FROM dubai_code_chunks d
  WHERE 
    d.metadata->>'section' = section_number
    OR d.metadata->>'section' LIKE section_number || '.%'
    OR section_number LIKE (d.metadata->>'section') || '.%'
  ORDER BY 
    -- Prioritize exact matches
    CASE 
      WHEN d.metadata->>'section' = section_number THEN 0
      WHEN d.metadata->>'section' LIKE section_number || '.%' THEN 1
      ELSE 2
    END,
    (d.metadata->>'startPage')::INT
  LIMIT match_count;
END;
$$;

-- ============================================================================
-- 4. HELPER FUNCTION: Match citations from AI response
-- ============================================================================

-- This function helps match [Page X, Section Y] citations from AI responses
-- to actual chunks in the database

CREATE OR REPLACE FUNCTION match_citation(
  citation_page INT,
  citation_section TEXT DEFAULT NULL,
  match_count INT DEFAULT 5
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
    -- Calculate match score (higher is better)
    (
      -- Page match: 50 points for exact, 30 for range
      CASE 
        WHEN (d.metadata->>'startPage')::INT = citation_page 
             AND (d.metadata->>'endPage')::INT = citation_page THEN 50
        WHEN (d.metadata->>'startPage')::INT <= citation_page 
             AND (d.metadata->>'endPage')::INT >= citation_page THEN 30
        WHEN (d.metadata->>'page')::INT = citation_page THEN 40
        ELSE 0
      END
      +
      -- Section match: 50 points for exact, 20 for partial
      CASE 
        WHEN citation_section IS NOT NULL AND d.metadata->>'section' = citation_section THEN 50
        WHEN citation_section IS NOT NULL AND d.metadata->>'section' LIKE citation_section || '%' THEN 20
        WHEN citation_section IS NULL THEN 10 -- Small bonus if no section specified
        ELSE 0
      END
    )::INT as match_score
  FROM dubai_code_chunks d
  WHERE 
    -- Must match the page (required)
    (
      (d.metadata->>'startPage')::INT <= citation_page 
      AND (d.metadata->>'endPage')::INT >= citation_page
    )
    OR (d.metadata->>'page')::INT = citation_page
  ORDER BY match_score DESC
  LIMIT match_count;
END;
$$;

-- ============================================================================
-- 5. GRANT PERMISSIONS
-- ============================================================================

GRANT EXECUTE ON FUNCTION find_chunks_by_page TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION find_chunks_by_section TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION match_citation TO anon, authenticated, service_role;

-- ============================================================================
-- 6. VERIFICATION
-- ============================================================================

SELECT 
  'Migration 002 complete!' AS status,
  (SELECT COUNT(*) FROM dubai_code_chunks) AS total_chunks,
  (SELECT COUNT(*) FROM dubai_code_chunks WHERE metadata->>'startPage' IS NOT NULL) AS chunks_with_page_range,
  (SELECT COUNT(*) FROM dubai_code_chunks WHERE metadata->>'sectionPath' IS NOT NULL) AS chunks_with_section_path,
  (SELECT COUNT(*) FROM dubai_code_chunks WHERE metadata->>'contentType' = 'table') AS table_chunks;
