-- ============================================================================
-- Emirate Forge - Complete Database Setup
-- Combined Migration: Base Setup + Security & Admin Features
-- Run this SQL in Supabase SQL Editor (https://supabase.com/dashboard)
-- ============================================================================

-- ============================================================================
-- 0. DROP EXISTING TABLES (Clean slate)
-- ============================================================================

-- Drop tables in correct order (respecting foreign keys)
DROP TABLE IF EXISTS audit_logs CASCADE;
DROP TABLE IF EXISTS rate_limits CASCADE;
DROP TABLE IF EXISTS chat_messages CASCADE;
DROP TABLE IF EXISTS chat_sessions CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF EXISTS dubai_code_chunks CASCADE;

-- Drop functions
DROP FUNCTION IF EXISTS match_dubai_code CASCADE;
DROP FUNCTION IF EXISTS search_dubai_code_keywords CASCADE;
DROP FUNCTION IF EXISTS match_dubai_code_hybrid CASCADE;
DROP FUNCTION IF EXISTS match_dubai_code_hybrid_filtered CASCADE;
DROP FUNCTION IF EXISTS search_dubai_code_exact CASCADE;
DROP FUNCTION IF EXISTS update_session_timestamp CASCADE;
DROP FUNCTION IF EXISTS check_rate_limit CASCADE;
DROP FUNCTION IF EXISTS refresh_analytics CASCADE;
DROP FUNCTION IF EXISTS get_admin_stats CASCADE;
DROP FUNCTION IF EXISTS get_weekly_activity CASCADE;
DROP FUNCTION IF EXISTS get_recent_audit_logs CASCADE;
DROP FUNCTION IF EXISTS admin_block_user CASCADE;
DROP FUNCTION IF EXISTS admin_update_user_role CASCADE;
DROP FUNCTION IF EXISTS get_all_users_admin CASCADE;
DROP FUNCTION IF EXISTS find_chunks_by_page CASCADE;
DROP FUNCTION IF EXISTS find_chunks_by_section CASCADE;
DROP FUNCTION IF EXISTS match_citation CASCADE;
DROP FUNCTION IF EXISTS get_document_tree CASCADE;
DROP FUNCTION IF EXISTS save_document_tree CASCADE;

-- Drop Tree Reasoning table
DROP TABLE IF EXISTS document_trees CASCADE;

-- Drop materialized views
DROP MATERIALIZED VIEW IF EXISTS analytics_daily CASCADE;

-- ============================================================================
-- 1. EXTENSIONS
-- ============================================================================

-- Enable pgvector extension for embeddings
CREATE EXTENSION IF NOT EXISTS vector;

-- Enable pg_trgm for fuzzy text matching (optional but useful)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Enable pgcrypto for password hashing (bcrypt)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================================
-- 2. RAG SYSTEM (Dubai Code Chunks) - Enhanced with FTS
-- ============================================================================

-- Create the chunks table with Full-Text Search support
CREATE TABLE IF NOT EXISTS dubai_code_chunks (
  id BIGSERIAL PRIMARY KEY,
  content TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  embedding VECTOR(768), -- Gemini text-embedding-004 dimensions
  fts tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED, -- Auto-generated FTS
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create index for fast vector similarity search
CREATE INDEX IF NOT EXISTS dubai_code_chunks_embedding_idx 
ON dubai_code_chunks 
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);

-- Create GIN index for fast full-text search
CREATE INDEX IF NOT EXISTS dubai_code_chunks_fts_idx 
ON dubai_code_chunks 
USING gin(fts);

-- Create index on metadata for filtering by page/section
CREATE INDEX IF NOT EXISTS dubai_code_chunks_metadata_idx 
ON dubai_code_chunks 
USING gin(metadata jsonb_path_ops);

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
-- 2.1 VECTOR SEARCH FUNCTION (Original - LangChain compatible)
-- ============================================================================

CREATE OR REPLACE FUNCTION match_dubai_code(
  query_embedding VECTOR(768),
  match_count INT DEFAULT 5,
  filter JSONB DEFAULT '{}'
)
RETURNS TABLE (
  id BIGINT,
  content TEXT,
  metadata JSONB,
  similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    dubai_code_chunks.id,
    dubai_code_chunks.content,
    dubai_code_chunks.metadata,
    1 - (dubai_code_chunks.embedding <=> query_embedding) AS similarity
  FROM dubai_code_chunks
  WHERE 1 - (dubai_code_chunks.embedding <=> query_embedding) > 0.5
  ORDER BY dubai_code_chunks.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- ============================================================================
-- 2.2 KEYWORD SEARCH FUNCTION (Full-Text Search with SQL Injection Protection)
-- ============================================================================

CREATE OR REPLACE FUNCTION search_dubai_code_keywords(
  search_query TEXT,
  match_count INT DEFAULT 25
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
  tsquery_val tsquery;
  sanitized_query TEXT;
BEGIN
  -- Sanitize input: remove special characters that could cause issues
  sanitized_query := regexp_replace(search_query, '[^\w\s]', ' ', 'g');
  sanitized_query := trim(regexp_replace(sanitized_query, '\s+', ' ', 'g'));
  
  -- Convert search query to tsquery with prefix matching
  tsquery_val := plainto_tsquery('english', sanitized_query);
  
  RETURN QUERY
  SELECT
    dubai_code_chunks.id,
    dubai_code_chunks.content,
    dubai_code_chunks.metadata,
    ts_rank_cd(dubai_code_chunks.fts, tsquery_val)::FLOAT AS rank
  FROM dubai_code_chunks
  WHERE dubai_code_chunks.fts @@ tsquery_val
  ORDER BY rank DESC
  LIMIT LEAST(match_count, 100);
END;
$$;

-- ============================================================================
-- 2.3 HYBRID SEARCH FUNCTION (Vector + Keyword with RRF)
-- ============================================================================

CREATE OR REPLACE FUNCTION match_dubai_code_hybrid(
  query_text TEXT,
  query_embedding VECTOR(768),
  match_count INT DEFAULT 10,
  keyword_weight FLOAT DEFAULT 0.3,
  vector_weight FLOAT DEFAULT 0.7,
  rrf_k INT DEFAULT 60
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
AS $$
BEGIN
  RETURN QUERY
  WITH 
  -- Vector search results with ranking
  vector_results AS (
    SELECT 
      d.id,
      d.content,
      d.metadata,
      1 - (d.embedding <=> query_embedding) AS similarity,
      ROW_NUMBER() OVER (ORDER BY d.embedding <=> query_embedding) AS vector_rank
    FROM dubai_code_chunks d
    WHERE 1 - (d.embedding <=> query_embedding) > 0.4
    ORDER BY d.embedding <=> query_embedding
    LIMIT 50
  ),
  -- Keyword search results with ranking
  keyword_results AS (
    SELECT 
      d.id,
      d.content,
      d.metadata,
      ts_rank_cd(d.fts, plainto_tsquery('english', query_text))::FLOAT AS kw_rank,
      ROW_NUMBER() OVER (ORDER BY ts_rank_cd(d.fts, plainto_tsquery('english', query_text)) DESC) AS keyword_rank
    FROM dubai_code_chunks d
    WHERE d.fts @@ plainto_tsquery('english', query_text)
    ORDER BY kw_rank DESC
    LIMIT 50
  ),
  -- Combine using Reciprocal Rank Fusion (RRF)
  combined AS (
    SELECT 
      COALESCE(v.id, k.id) AS id,
      COALESCE(v.content, k.content) AS content,
      COALESCE(v.metadata, k.metadata) AS metadata,
      COALESCE(v.similarity, 0.0) AS vec_sim,
      COALESCE(k.kw_rank, 0.0) AS kw_score,
      -- RRF formula: 1/(k + rank)
      (
        vector_weight * COALESCE(1.0 / (rrf_k + v.vector_rank), 0.0) +
        keyword_weight * COALESCE(1.0 / (rrf_k + k.keyword_rank), 0.0)
      ) AS rrf_score
    FROM vector_results v
    FULL OUTER JOIN keyword_results k ON v.id = k.id
  )
  SELECT 
    combined.id,
    combined.content,
    combined.metadata,
    combined.vec_sim AS vector_similarity,
    combined.kw_score AS keyword_rank,
    combined.rrf_score AS hybrid_score
  FROM combined
  ORDER BY combined.rrf_score DESC
  LIMIT match_count;
END;
$$;

-- ============================================================================
-- 2.4 EXACT SECTION SEARCH (For precise lookups with SQL Injection Protection)
-- ============================================================================

CREATE OR REPLACE FUNCTION search_dubai_code_exact(
  search_pattern TEXT,
  match_count INT DEFAULT 10
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
  -- Sanitize: escape special characters for LIKE pattern
  safe_pattern := regexp_replace(search_pattern, '([%_\\])', '\\\1', 'g');
  
  RETURN QUERY
  SELECT
    d.id,
    d.content,
    d.metadata,
    POSITION(LOWER(safe_pattern) IN LOWER(d.content))::INT AS match_position
  FROM dubai_code_chunks d
  WHERE LOWER(d.content) LIKE '%' || LOWER(safe_pattern) || '%'
  ORDER BY match_position
  LIMIT LEAST(match_count, 100); -- Cap results
END;
$$;

-- ============================================================================
-- 2.5 HELPER FUNCTION: Find chunks by page range
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
-- 2.6 HELPER FUNCTION: Find chunks by section
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
-- 2.7 HELPER FUNCTION: Match citations from AI response
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
-- 2.8 DOCUMENT TREE TABLE (For Tree Reasoning)
-- Stores hierarchical structure of documents for structure-aware search
-- ============================================================================

CREATE TABLE IF NOT EXISTS document_trees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_name TEXT NOT NULL UNIQUE,  -- e.g., "Dubai Building Code 2021"
  total_pages INT NOT NULL DEFAULT 0,
  tree_data JSONB NOT NULL DEFAULT '[]',  -- Array of TreeNode objects
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for fast lookup by document name
CREATE INDEX IF NOT EXISTS idx_document_trees_name ON document_trees(document_name);

-- ============================================================================
-- 2.9 FILTERED HYBRID SEARCH (For Tree Reasoning)
-- Combines vector + keyword search within specified page ranges
-- ============================================================================

CREATE OR REPLACE FUNCTION match_dubai_code_hybrid_filtered(
  query_text TEXT,
  query_embedding VECTOR(768),
  page_ranges JSONB,  -- Array of {start_page: int, end_page: int}
  match_count INT DEFAULT 10,
  keyword_weight FLOAT DEFAULT 0.3,
  vector_weight FLOAT DEFAULT 0.7,
  rrf_k INT DEFAULT 60
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
AS $$
DECLARE
  range_filter TEXT;
BEGIN
  RETURN QUERY
  WITH 
  -- Filter chunks by page ranges first
  page_filtered AS (
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
  ),
  -- Vector search results with ranking (within filtered chunks)
  vector_results AS (
    SELECT 
      pf.id,
      pf.content,
      pf.metadata,
      1 - (pf.embedding <=> query_embedding) AS similarity,
      ROW_NUMBER() OVER (ORDER BY pf.embedding <=> query_embedding) AS vector_rank
    FROM page_filtered pf
    WHERE 1 - (pf.embedding <=> query_embedding) > 0.35
    ORDER BY pf.embedding <=> query_embedding
    LIMIT 30
  ),
  -- Keyword search results with ranking (within filtered chunks)
  keyword_results AS (
    SELECT 
      pf.id,
      pf.content,
      pf.metadata,
      ts_rank_cd(pf.fts, plainto_tsquery('english', query_text))::FLOAT AS kw_rank,
      ROW_NUMBER() OVER (ORDER BY ts_rank_cd(pf.fts, plainto_tsquery('english', query_text)) DESC) AS keyword_rank
    FROM page_filtered pf
    WHERE pf.fts @@ plainto_tsquery('english', query_text)
    ORDER BY kw_rank DESC
    LIMIT 30
  ),
  -- Combine using Reciprocal Rank Fusion (RRF)
  combined AS (
    SELECT 
      COALESCE(v.id, k.id) AS id,
      COALESCE(v.content, k.content) AS content,
      COALESCE(v.metadata, k.metadata) AS metadata,
      COALESCE(v.similarity, 0.0) AS vec_sim,
      COALESCE(k.kw_rank, 0.0) AS kw_score,
      (
        vector_weight * COALESCE(1.0 / (rrf_k + v.vector_rank), 0.0) +
        keyword_weight * COALESCE(1.0 / (rrf_k + k.keyword_rank), 0.0)
      ) AS rrf_score
    FROM vector_results v
    FULL OUTER JOIN keyword_results k ON v.id = k.id
  )
  SELECT 
    combined.id,
    combined.content,
    combined.metadata,
    combined.vec_sim AS vector_similarity,
    combined.kw_score AS keyword_rank,
    combined.rrf_score AS hybrid_score
  FROM combined
  ORDER BY combined.rrf_score DESC
  LIMIT match_count;
END;
$$;

-- ============================================================================
-- 2.10 TREE HELPER FUNCTIONS
-- ============================================================================

-- Get document tree
CREATE OR REPLACE FUNCTION get_document_tree(
  p_document_name TEXT DEFAULT 'Dubai Building Code 2021'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tree JSONB;
BEGIN
  SELECT tree_data INTO v_tree
  FROM document_trees
  WHERE document_name = p_document_name;
  
  RETURN COALESCE(v_tree, '[]'::JSONB);
END;
$$;

-- Save/Update document tree
CREATE OR REPLACE FUNCTION save_document_tree(
  p_document_name TEXT,
  p_total_pages INT,
  p_tree_data JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO document_trees (document_name, total_pages, tree_data, updated_at)
  VALUES (p_document_name, p_total_pages, p_tree_data, NOW())
  ON CONFLICT (document_name) 
  DO UPDATE SET 
    total_pages = EXCLUDED.total_pages,
    tree_data = EXCLUDED.tree_data,
    updated_at = NOW()
  RETURNING id INTO v_id;
  
  RETURN v_id;
END;
$$;

-- ============================================================================
-- 3. AUTHENTICATION SYSTEM
-- ============================================================================

-- Create users table with blocked fields
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT,
  role TEXT DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  blocked BOOLEAN DEFAULT FALSE,
  blocked_reason TEXT,
  blocked_at TIMESTAMP WITH TIME ZONE,
  blocked_by UUID,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_login TIMESTAMP WITH TIME ZONE
);

-- Create index for faster username lookup
CREATE INDEX IF NOT EXISTS users_username_idx ON users(username);

-- Create index for blocked users
CREATE INDEX IF NOT EXISTS users_blocked_idx ON users(blocked) WHERE blocked = TRUE;

-- Add foreign key for blocked_by (self-referencing)
ALTER TABLE users ADD CONSTRAINT users_blocked_by_fkey 
  FOREIGN KEY (blocked_by) REFERENCES users(id) ON DELETE SET NULL;

-- ============================================================================
-- 4. CHAT HISTORY SYSTEM
-- ============================================================================

-- Create chat_sessions table
CREATE TABLE IF NOT EXISTS chat_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create chat_messages table
CREATE TABLE IF NOT EXISTS chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  citations JSONB DEFAULT '[]',
  compliance_status TEXT CHECK (compliance_status IN ('compliant', 'non-compliant', 'requires-review', 'pending')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS chat_messages_session_id_idx ON chat_messages(session_id);
CREATE INDEX IF NOT EXISTS chat_sessions_user_id_idx ON chat_sessions(user_id);
CREATE INDEX IF NOT EXISTS chat_sessions_updated_at_idx ON chat_sessions(updated_at DESC);

-- Create function to auto-update updated_at on sessions
CREATE OR REPLACE FUNCTION update_session_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE chat_sessions 
  SET updated_at = NOW() 
  WHERE id = NEW.session_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for auto-updating session timestamp
DROP TRIGGER IF EXISTS update_session_on_message ON chat_messages;
CREATE TRIGGER update_session_on_message
AFTER INSERT ON chat_messages
FOR EACH ROW
EXECUTE FUNCTION update_session_timestamp();

-- ============================================================================
-- 5. AUDIT LOGS TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  metadata JSONB DEFAULT '{}',
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS audit_logs_user_id_idx ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS audit_logs_action_idx ON audit_logs(action);
CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_target_user_idx ON audit_logs(target_user_id);

-- ============================================================================
-- 6. RATE LIMITING SYSTEM
-- ============================================================================

-- Create rate_limits table to track API requests per user
CREATE TABLE IF NOT EXISTS rate_limits (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for fast lookups by user and time
CREATE INDEX IF NOT EXISTS rate_limits_user_time_idx 
ON rate_limits(user_id, request_timestamp DESC);

-- Function to check and record rate limit
CREATE OR REPLACE FUNCTION check_rate_limit(
  p_user_id UUID,
  p_window_seconds INT DEFAULT 60,
  p_max_requests INT DEFAULT 10,
  p_min_interval_ms INT DEFAULT 2000
)
RETURNS TABLE (
  allowed BOOLEAN,
  retry_after_ms INT,
  current_count INT
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_window_start TIMESTAMP WITH TIME ZONE;
  v_last_request TIMESTAMP WITH TIME ZONE;
  v_request_count INT;
  v_ms_since_last INT;
BEGIN
  v_window_start := NOW() - (p_window_seconds || ' seconds')::INTERVAL;
  
  -- Get count of requests in window and last request time
  SELECT 
    COUNT(*),
    MAX(request_timestamp)
  INTO v_request_count, v_last_request
  FROM rate_limits
  WHERE user_id = p_user_id
    AND request_timestamp > v_window_start;
  
  -- Check minimum interval between requests
  IF v_last_request IS NOT NULL THEN
    v_ms_since_last := EXTRACT(EPOCH FROM (NOW() - v_last_request)) * 1000;
    
    IF v_ms_since_last < p_min_interval_ms THEN
      RETURN QUERY SELECT 
        FALSE::BOOLEAN,
        (p_min_interval_ms - v_ms_since_last)::INT,
        v_request_count::INT;
      RETURN;
    END IF;
  END IF;
  
  -- Check max requests per window
  IF v_request_count >= p_max_requests THEN
    RETURN QUERY SELECT 
      FALSE::BOOLEAN,
      (p_window_seconds * 1000)::INT,
      v_request_count::INT;
    RETURN;
  END IF;
  
  -- Request allowed - record it
  INSERT INTO rate_limits (user_id, request_timestamp)
  VALUES (p_user_id, NOW());
  
  -- Clean up old records (keep only last hour)
  DELETE FROM rate_limits
  WHERE user_id = p_user_id
    AND request_timestamp < NOW() - INTERVAL '1 hour';
  
  RETURN QUERY SELECT 
    TRUE::BOOLEAN,
    0::INT,
    (v_request_count + 1)::INT;
END;
$$;

-- ============================================================================
-- 7. ANALYTICS MATERIALIZED VIEWS
-- ============================================================================

-- Daily stats view (refresh periodically)
CREATE MATERIALIZED VIEW IF NOT EXISTS analytics_daily AS
SELECT 
  DATE(cm.created_at) as date,
  COUNT(DISTINCT cs.user_id) as active_users,
  COUNT(*) as total_messages,
  COUNT(*) FILTER (WHERE cm.role = 'user') as user_messages,
  COUNT(*) FILTER (WHERE cm.role = 'assistant') as assistant_messages
FROM chat_messages cm
JOIN chat_sessions cs ON cm.session_id = cs.id
GROUP BY DATE(cm.created_at)
ORDER BY date DESC;

-- Create index on materialized view
CREATE UNIQUE INDEX IF NOT EXISTS analytics_daily_date_idx ON analytics_daily(date);

-- Function to refresh analytics
CREATE OR REPLACE FUNCTION refresh_analytics()
RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY analytics_daily;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- 8. ADMIN ANALYTICS FUNCTIONS
-- ============================================================================

-- Get dashboard stats
CREATE OR REPLACE FUNCTION get_admin_stats()
RETURNS TABLE (
  total_users BIGINT,
  active_users_today BIGINT,
  total_sessions BIGINT,
  total_messages BIGINT,
  messages_today BIGINT,
  blocked_users BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    (SELECT COUNT(*) FROM users)::BIGINT as total_users,
    (SELECT COUNT(DISTINCT cs.user_id) 
     FROM chat_messages cm 
     JOIN chat_sessions cs ON cm.session_id = cs.id 
     WHERE cm.created_at > NOW() - INTERVAL '24 hours')::BIGINT as active_users_today,
    (SELECT COUNT(*) FROM chat_sessions)::BIGINT as total_sessions,
    (SELECT COUNT(*) FROM chat_messages)::BIGINT as total_messages,
    (SELECT COUNT(*) FROM chat_messages WHERE created_at > NOW() - INTERVAL '24 hours')::BIGINT as messages_today,
    (SELECT COUNT(*) FROM users WHERE blocked = TRUE)::BIGINT as blocked_users;
END;
$$;

-- Get weekly activity chart data
CREATE OR REPLACE FUNCTION get_weekly_activity()
RETURNS TABLE (
  day DATE,
  messages BIGINT,
  users BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    DATE(d.day) as day,
    COALESCE(COUNT(m.id), 0)::BIGINT as messages,
    COALESCE(COUNT(DISTINCT m.session_id), 0)::BIGINT as users
  FROM generate_series(
    NOW() - INTERVAL '7 days',
    NOW(),
    INTERVAL '1 day'
  ) as d(day)
  LEFT JOIN chat_messages m ON DATE(m.created_at) = DATE(d.day)
  GROUP BY DATE(d.day)
  ORDER BY day;
END;
$$;

-- Get recent audit logs for admin
CREATE OR REPLACE FUNCTION get_recent_audit_logs(
  p_limit INT DEFAULT 50,
  p_action_filter TEXT DEFAULT NULL
)
RETURNS TABLE (
  id BIGINT,
  user_id UUID,
  username TEXT,
  action TEXT,
  target_user_id UUID,
  target_username TEXT,
  metadata JSONB,
  ip_address TEXT,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    al.id,
    al.user_id,
    u.username,
    al.action,
    al.target_user_id,
    tu.username as target_username,
    al.metadata,
    al.ip_address,
    al.created_at
  FROM audit_logs al
  LEFT JOIN users u ON al.user_id = u.id
  LEFT JOIN users tu ON al.target_user_id = tu.id
  WHERE (p_action_filter IS NULL OR al.action = p_action_filter)
  ORDER BY al.created_at DESC
  LIMIT LEAST(p_limit, 500);
END;
$$;

-- ============================================================================
-- 9. USER MANAGEMENT FUNCTIONS
-- ============================================================================

-- Block/Unblock user
CREATE OR REPLACE FUNCTION admin_block_user(
  p_admin_id UUID,
  p_target_user_id UUID,
  p_blocked BOOLEAN,
  p_reason TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_admin_role TEXT;
BEGIN
  -- Verify admin role
  SELECT role INTO v_admin_role FROM users WHERE id = p_admin_id;
  IF v_admin_role != 'admin' THEN
    RAISE EXCEPTION 'Unauthorized: Admin role required';
  END IF;
  
  -- Prevent self-blocking
  IF p_admin_id = p_target_user_id THEN
    RAISE EXCEPTION 'Cannot block yourself';
  END IF;
  
  -- Update user
  UPDATE users
  SET 
    blocked = p_blocked,
    blocked_reason = CASE WHEN p_blocked THEN p_reason ELSE NULL END,
    blocked_at = CASE WHEN p_blocked THEN NOW() ELSE NULL END,
    blocked_by = CASE WHEN p_blocked THEN p_admin_id ELSE NULL END
  WHERE id = p_target_user_id;
  
  RETURN TRUE;
END;
$$;

-- Update user role
CREATE OR REPLACE FUNCTION admin_update_user_role(
  p_admin_id UUID,
  p_target_user_id UUID,
  p_new_role TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_admin_role TEXT;
BEGIN
  -- Validate role
  IF p_new_role NOT IN ('admin', 'user') THEN
    RAISE EXCEPTION 'Invalid role';
  END IF;
  
  -- Verify admin role
  SELECT role INTO v_admin_role FROM users WHERE id = p_admin_id;
  IF v_admin_role != 'admin' THEN
    RAISE EXCEPTION 'Unauthorized: Admin role required';
  END IF;
  
  -- Update user role
  UPDATE users SET role = p_new_role WHERE id = p_target_user_id;
  
  RETURN TRUE;
END;
$$;

-- Get all users for admin management
CREATE OR REPLACE FUNCTION get_all_users_admin(
  p_admin_id UUID,
  p_limit INT DEFAULT 50,
  p_offset INT DEFAULT 0,
  p_search TEXT DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  username TEXT,
  full_name TEXT,
  role TEXT,
  blocked BOOLEAN,
  blocked_reason TEXT,
  created_at TIMESTAMPTZ,
  last_login TIMESTAMPTZ,
  session_count BIGINT,
  message_count BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_admin_role TEXT;
BEGIN
  -- Verify admin role
  SELECT users.role INTO v_admin_role FROM users WHERE users.id = p_admin_id;
  IF v_admin_role != 'admin' THEN
    RAISE EXCEPTION 'Unauthorized: Admin role required';
  END IF;
  
  RETURN QUERY
  SELECT 
    u.id,
    u.username,
    u.full_name,
    u.role,
    u.blocked,
    u.blocked_reason,
    u.created_at,
    u.last_login,
    (SELECT COUNT(*) FROM chat_sessions cs WHERE cs.user_id = u.id)::BIGINT as session_count,
    (SELECT COUNT(*) FROM chat_messages cm 
     JOIN chat_sessions cs ON cm.session_id = cs.id 
     WHERE cs.user_id = u.id)::BIGINT as message_count
  FROM users u
  WHERE (p_search IS NULL OR u.username ILIKE '%' || p_search || '%' OR u.full_name ILIKE '%' || p_search || '%')
  ORDER BY u.created_at DESC
  LIMIT LEAST(p_limit, 100)
  OFFSET p_offset;
END;
$$;

-- ============================================================================
-- 10. PERMISSIONS (for anon, authenticated, and service_role)
-- ============================================================================

-- Grant permissions for RAG system (dubai_code_chunks)
GRANT SELECT, INSERT, DELETE, UPDATE ON dubai_code_chunks TO anon, authenticated, service_role;
GRANT USAGE, SELECT ON SEQUENCE dubai_code_chunks_id_seq TO anon, authenticated, service_role;

-- Grant RPC function permissions (public RAG functions)
GRANT EXECUTE ON FUNCTION match_dubai_code TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION search_dubai_code_keywords TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION match_dubai_code_hybrid TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION match_dubai_code_hybrid_filtered TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION search_dubai_code_exact TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION find_chunks_by_page TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION find_chunks_by_section TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION match_citation TO anon, authenticated, service_role;

-- Grant permissions for Tree Reasoning
GRANT SELECT ON document_trees TO anon, authenticated, service_role;
GRANT ALL ON document_trees TO service_role;
GRANT EXECUTE ON FUNCTION get_document_tree TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION save_document_tree TO service_role;

-- Grant permissions for users table (restricted - authenticated only)
GRANT SELECT, UPDATE ON users TO authenticated;
GRANT ALL ON users TO service_role;
-- NOTE: No GRANT for anon on users table - anonymous users cannot access user data

-- Grant permissions for chat systems (authenticated users only)
GRANT ALL ON chat_sessions TO authenticated, service_role;
GRANT ALL ON chat_messages TO authenticated, service_role;
-- NOTE: No GRANT for anon on chat tables

-- Grant permissions for rate limiting (authenticated only)
GRANT ALL ON rate_limits TO authenticated, service_role;
GRANT USAGE, SELECT ON SEQUENCE rate_limits_id_seq TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION check_rate_limit TO authenticated, service_role;

-- Grant permissions for ADMIN functions (service_role ONLY)
-- These functions perform privileged operations and should NOT be accessible to anon/authenticated
GRANT EXECUTE ON FUNCTION get_admin_stats TO service_role;
GRANT EXECUTE ON FUNCTION get_weekly_activity TO service_role;
GRANT EXECUTE ON FUNCTION get_recent_audit_logs TO service_role;
GRANT EXECUTE ON FUNCTION admin_block_user TO service_role;
GRANT EXECUTE ON FUNCTION admin_update_user_role TO service_role;
GRANT EXECUTE ON FUNCTION get_all_users_admin TO service_role;
GRANT EXECUTE ON FUNCTION refresh_analytics TO service_role;
GRANT EXECUTE ON FUNCTION update_session_timestamp TO authenticated, service_role;

-- Grant access to audit_logs table (service_role only for read, authenticated can insert)
GRANT INSERT ON audit_logs TO authenticated;
GRANT ALL ON audit_logs TO service_role;
GRANT USAGE, SELECT ON SEQUENCE audit_logs_id_seq TO authenticated, service_role;

-- ============================================================================
-- 11. ROW LEVEL SECURITY
-- ============================================================================

-- Enable RLS on all sensitive tables
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;

-- dubai_code_chunks is read-only for users, so RLS optional
ALTER TABLE dubai_code_chunks ENABLE ROW LEVEL SECURITY;

-- document_trees for Tree Reasoning
ALTER TABLE document_trees ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- USERS TABLE POLICIES (SECURE)
-- -----------------------------------------------------------------------------
-- Service role bypasses RLS automatically
-- Security principles:
-- 1. Users can only see their own profile
-- 2. Anonymous users cannot modify any data
-- 3. Only the profile owner can update their profile
-- 4. Admins use service_role which bypasses RLS

-- Drop all existing policies first
DROP POLICY IF EXISTS "Service role full access to users" ON users;
DROP POLICY IF EXISTS "Users can view own profile" ON users;
DROP POLICY IF EXISTS "Allow username lookup for login" ON users;
DROP POLICY IF EXISTS "Allow update for login" ON users;
DROP POLICY IF EXISTS "Allow insert users" ON users;
DROP POLICY IF EXISTS "Allow delete users" ON users;
DROP POLICY IF EXISTS "Allow all users operations" ON users;
DROP POLICY IF EXISTS "Authenticated users can view own profile" ON users;
DROP POLICY IF EXISTS "Authenticated users can update own profile" ON users;

-- SELECT: Authenticated users can only view their own profile
CREATE POLICY "Authenticated users can view own profile" ON users
  FOR SELECT
  TO authenticated
  USING (id = auth.uid());

-- UPDATE: Only the profile owner (authenticated) can update their own profile
CREATE POLICY "Authenticated users can update own profile" ON users
  FOR UPDATE
  TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

-- NOTE: No INSERT/DELETE policies for anon or authenticated
-- Anonymous users have NO direct access to users table from client
-- INSERT/DELETE operations are handled via service_role (server-side only)
-- LOGIN: The application uses service_role (createAdminClient) for login queries
--        This bypasses RLS and allows reading users table for authentication
-- This prevents:
-- - Anonymous users from creating/modifying/deleting users
-- - Authenticated users from seeing other users' profiles
-- - Authenticated users from modifying other users' profiles

-- -----------------------------------------------------------------------------
-- DUBAI_CODE_CHUNKS POLICIES (Full access for PDF ingestion)
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Anyone can read chunks" ON dubai_code_chunks;
DROP POLICY IF EXISTS "Service role manages chunks" ON dubai_code_chunks;
DROP POLICY IF EXISTS "Allow insert chunks" ON dubai_code_chunks;
DROP POLICY IF EXISTS "Allow delete chunks" ON dubai_code_chunks;
DROP POLICY IF EXISTS "Allow read chunks" ON dubai_code_chunks;
DROP POLICY IF EXISTS "Service role full access" ON dubai_code_chunks;
DROP POLICY IF EXISTS "Allow all chunks operations" ON dubai_code_chunks;

-- FULL ACCESS: Allow all operations on dubai_code_chunks table
-- PDF ingestion and clearing needs INSERT/DELETE, RAG needs SELECT
CREATE POLICY "Allow all chunks operations" ON dubai_code_chunks
  FOR ALL
  TO anon, authenticated, service_role
  USING (true)
  WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- DOCUMENT_TREES POLICIES (Tree Reasoning)
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Allow read document trees" ON document_trees;
DROP POLICY IF EXISTS "Service role full access to document trees" ON document_trees;

-- Allow read access to everyone (tree structure is not sensitive)
CREATE POLICY "Allow read document trees" ON document_trees
  FOR SELECT
  TO anon, authenticated, service_role
  USING (true);

-- Allow full access for service_role (admin operations)
CREATE POLICY "Service role full access to document trees" ON document_trees
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- CHAT_SESSIONS POLICIES
-- -----------------------------------------------------------------------------

-- Drop all existing policies first
DROP POLICY IF EXISTS "Service role full access to sessions" ON chat_sessions;
DROP POLICY IF EXISTS "Users can view own sessions" ON chat_sessions;
DROP POLICY IF EXISTS "Users can insert own sessions" ON chat_sessions;
DROP POLICY IF EXISTS "Users can delete own sessions" ON chat_sessions;
DROP POLICY IF EXISTS "Allow all sessions operations" ON chat_sessions;

-- FULL ACCESS: Allow all operations (auth check done in application layer)
CREATE POLICY "Allow all sessions operations" ON chat_sessions
  FOR ALL
  TO anon, authenticated, service_role
  USING (true)
  WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- CHAT_MESSAGES POLICIES
-- -----------------------------------------------------------------------------

-- Drop all existing policies first
DROP POLICY IF EXISTS "Service role full access to messages" ON chat_messages;
DROP POLICY IF EXISTS "Users can view own messages" ON chat_messages;
DROP POLICY IF EXISTS "Users can insert own messages" ON chat_messages;
DROP POLICY IF EXISTS "Allow all messages operations" ON chat_messages;

-- FULL ACCESS: Allow all operations (auth check done in application layer)
CREATE POLICY "Allow all messages operations" ON chat_messages
  FOR ALL
  TO anon, authenticated, service_role
  USING (true)
  WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- AUDIT_LOGS POLICIES
-- -----------------------------------------------------------------------------

-- Drop all existing policies first
DROP POLICY IF EXISTS "Service role full access to audit logs" ON audit_logs;
DROP POLICY IF EXISTS "Authenticated can view audit logs" ON audit_logs;
DROP POLICY IF EXISTS "Anyone can insert audit logs" ON audit_logs;
DROP POLICY IF EXISTS "Anon can view audit logs" ON audit_logs;
DROP POLICY IF EXISTS "Anyone can view audit logs" ON audit_logs;
DROP POLICY IF EXISTS "Allow all audit operations" ON audit_logs;

-- FULL ACCESS: Allow all operations (admin check done in application layer)
CREATE POLICY "Allow all audit operations" ON audit_logs
  FOR ALL
  TO anon, authenticated, service_role
  USING (true)
  WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- RATE_LIMITS POLICIES
-- -----------------------------------------------------------------------------

-- Drop all existing policies first
DROP POLICY IF EXISTS "Service role full access to rate limits" ON rate_limits;
DROP POLICY IF EXISTS "Users manage own rate limits" ON rate_limits;
DROP POLICY IF EXISTS "Allow all rate limits operations" ON rate_limits;

-- FULL ACCESS: Allow all operations
CREATE POLICY "Allow all rate limits operations" ON rate_limits
  FOR ALL
  TO anon, authenticated, service_role
  USING (true)
  WITH CHECK (true);

-- Note: Service role key bypasses RLS, so admin operations still work

-- ============================================================================
-- 13. REVOKE ADMIN FUNCTION EXECUTE PERMISSIONS FROM ANON AND AUTHENTICATED
-- ============================================================================
-- Security: Admin functions should only be callable via service_role
-- This prevents privilege escalation attacks

REVOKE EXECUTE ON FUNCTION admin_block_user FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION admin_update_user_role FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION get_all_users_admin FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION get_admin_stats FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION get_recent_audit_logs FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION refresh_analytics FROM anon, authenticated;

-- Also revoke permissions on sensitive tables for anon role
REVOKE ALL ON users FROM anon;
REVOKE ALL ON audit_logs FROM anon;

-- ============================================================================
-- 14. DEFAULT ADMIN USER
-- ============================================================================
-- 
-- Creates default admin user with bcrypt hashed password
-- Default credentials: admin / Admin123!
-- IMPORTANT: Change password after first login!
--

INSERT INTO users (username, password_hash, full_name, role)
VALUES (
  'admin',
  crypt('Admin123!', gen_salt('bf', 12)),  -- bcrypt hash with 12 rounds
  'System Administrator',
  'admin'
) ON CONFLICT (username) DO NOTHING;

-- ============================================================================
-- VERIFICATION
-- ============================================================================

SELECT 
  'Database setup complete!' AS status,
  (SELECT COUNT(*) FROM dubai_code_chunks) AS chunks_count,
  (SELECT COUNT(*) FROM users) AS users_count,
  (SELECT COUNT(*) FROM chat_sessions) AS sessions_count,
  (SELECT COUNT(*) FROM chat_messages) AS messages_count,
  (SELECT COUNT(*) FROM rate_limits) AS rate_limits_count,
  (SELECT COUNT(*) FROM audit_logs) AS audit_logs_count,
  EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'document_trees') AS tree_reasoning_enabled,
  EXISTS(SELECT 1 FROM information_schema.routines WHERE routine_name = 'match_dubai_code_hybrid_filtered') AS filtered_search_exists;
