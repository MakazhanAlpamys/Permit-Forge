-- ============================================================================
-- PermitForge — Complete Database Setup (Merged Migration)
-- Combines: 001_complete_setup + 002_permit_applications +
--           003_permit_enhancements + 004_multi_document_support +
--           005_analytics_functions + 006_cleanup_functions
-- Run this SQL in Supabase SQL Editor (https://supabase.com/dashboard)
-- ============================================================================

-- ============================================================================
-- 0. CLEAN SLATE — Drop everything in correct order
-- ============================================================================

DROP TABLE IF EXISTS semantic_cache CASCADE;
DROP TABLE IF EXISTS parent_chunks CASCADE;
DROP TABLE IF EXISTS document_registry CASCADE;
DROP TABLE IF EXISTS permit_certificates CASCADE;
DROP TABLE IF EXISTS permit_attachments CASCADE;
DROP TABLE IF EXISTS notifications CASCADE;
DROP TABLE IF EXISTS permit_status_history CASCADE;
DROP TABLE IF EXISTS permit_applications CASCADE;
DROP TABLE IF EXISTS audit_logs CASCADE;
DROP TABLE IF EXISTS ip_rate_limits CASCADE;
DROP TABLE IF EXISTS rate_limits CASCADE;
DROP TABLE IF EXISTS chat_messages CASCADE;
DROP TABLE IF EXISTS chat_sessions CASCADE;
DROP TABLE IF EXISTS document_trees CASCADE;
DROP TABLE IF EXISTS dubai_code_chunks CASCADE;
DROP TABLE IF EXISTS users CASCADE;

DROP MATERIALIZED VIEW IF EXISTS analytics_daily CASCADE;

-- Drop all overloaded function variants dynamically
DO $$
DECLARE
  _sql TEXT;
BEGIN
  FOR _sql IN
    SELECT 'DROP FUNCTION IF EXISTS ' || oid::regprocedure || ' CASCADE'
    FROM pg_proc
    WHERE proname IN (
      'match_dubai_code', 'search_dubai_code_keywords', 'match_dubai_code_hybrid',
      'match_dubai_code_hybrid_filtered', 'search_dubai_code_exact', 'find_chunks_by_page',
      'find_chunks_by_section', 'match_citation', 'get_document_tree', 'save_document_tree',
      'update_session_timestamp', 'check_rate_limit', 'refresh_analytics', 'get_admin_stats',
      'get_weekly_activity', 'get_recent_audit_logs', 'admin_block_user', 'admin_update_user_role',
      'get_all_users_admin', 'update_permit_timestamp', 'get_permit_stats', 'get_document_stats',
      'clear_document_chunks', 'get_analytics_dashboard_stats', 'get_message_activity_30d',
      'get_top_active_users', 'cleanup_old_sessions', 'cleanup_old_audit_logs',
      'cleanup_expired_rate_limits', 'run_all_cleanup',
      'search_semantic_cache', 'insert_semantic_cache', 'cleanup_semantic_cache',
      'get_parent_chunks',
      'get_all_documents', 'upsert_document', 'delete_document',
      'check_ip_rate_limit'
    )
    AND pg_function_is_visible(oid)
  LOOP
    EXECUTE _sql;
  END LOOP;
END $$;

-- ============================================================================
-- 1. EXTENSIONS
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================================
-- 2. TABLES
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 2.1 USERS
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT,
  email TEXT UNIQUE,
  email_verified BOOLEAN DEFAULT FALSE,
  -- D9/M17: both code columns are always exactly 6 numeric chars
  -- (generateSixDigitCode in lib/email.ts). CHAR(6) enforces the
  -- length at the type level; since values always fill the column
  -- there's no space-padding surprise on read.
  verification_code CHAR(6),
  reset_code CHAR(6),
  code_expires_at TIMESTAMPTZ,
  reset_code_expires_at TIMESTAMPTZ,
  role TEXT DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  blocked BOOLEAN DEFAULT FALSE,
  blocked_reason TEXT,
  blocked_at TIMESTAMPTZ,
  blocked_by UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_login TIMESTAMPTZ
);

ALTER TABLE users ADD CONSTRAINT users_blocked_by_fkey
  FOREIGN KEY (blocked_by) REFERENCES users(id) ON DELETE SET NULL;

-- users.username already has a UNIQUE constraint which creates an implicit
-- B-tree index; an explicit users_username_idx would be redundant (D13/L7).
CREATE INDEX users_blocked_idx ON users(blocked) WHERE blocked = TRUE;
CREATE INDEX users_email_idx ON users(email) WHERE email IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2.2 DUBAI CODE CHUNKS (RAG)
-- ---------------------------------------------------------------------------

CREATE TABLE dubai_code_chunks (
  id BIGSERIAL PRIMARY KEY,
  content TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  embedding VECTOR(768),
  -- D11/M19 + D18: width matches document_registry.id (the FK target).
  -- The FK constraint itself is added after document_registry exists.
  document_name VARCHAR(64) NOT NULL DEFAULT 'unknown',
  parent_id BIGINT,  -- References parent_chunks for parent-child chunking (v2)
  fts tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX dubai_code_chunks_embedding_idx
  ON dubai_code_chunks USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX dubai_code_chunks_fts_idx
  ON dubai_code_chunks USING gin(fts);
CREATE INDEX dubai_code_chunks_metadata_idx
  ON dubai_code_chunks USING gin(metadata jsonb_path_ops);
CREATE INDEX idx_chunks_start_page  ON dubai_code_chunks ((metadata->>'startPage'));
CREATE INDEX idx_chunks_end_page    ON dubai_code_chunks ((metadata->>'endPage'));
CREATE INDEX idx_chunks_section     ON dubai_code_chunks ((metadata->>'section'));
-- D8/M15: text_pattern_ops variant so find_chunks_by_section's
-- LIKE 'section.%' predicates can pick the index under any collation.
CREATE INDEX idx_chunks_section_pattern
  ON dubai_code_chunks ((metadata->>'section') text_pattern_ops);
CREATE INDEX idx_chunks_content_type ON dubai_code_chunks ((metadata->>'contentType'));
CREATE INDEX idx_chunks_document_name ON dubai_code_chunks(document_name);
CREATE INDEX idx_chunks_parent_id ON dubai_code_chunks(parent_id);
CREATE INDEX idx_chunks_doc_pages
  ON dubai_code_chunks(document_name, ((metadata->>'startPage')::INT), ((metadata->>'endPage')::INT));
-- D3/H17: trigram expression index so search_dubai_code_exact's
-- LOWER(content) LIKE '%pattern%' uses the index instead of seq-scanning.
CREATE INDEX dubai_code_chunks_content_lower_trgm_idx
  ON dubai_code_chunks USING gin (LOWER(content) gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- 2.3 DOCUMENT TREES (Tree Reasoning)
-- ---------------------------------------------------------------------------

CREATE TABLE document_trees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_name TEXT NOT NULL UNIQUE,
  total_pages INT NOT NULL DEFAULT 0,
  tree_data JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_document_trees_name ON document_trees(document_name);

-- ---------------------------------------------------------------------------
-- 2.4 CHAT SESSIONS & MESSAGES
-- ---------------------------------------------------------------------------

CREATE TABLE chat_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  citations JSONB DEFAULT '[]',
  compliance_status TEXT CHECK (compliance_status IN ('compliant', 'non-compliant', 'requires-review', 'pending')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX chat_messages_session_id_idx ON chat_messages(session_id);
CREATE INDEX chat_sessions_user_id_idx   ON chat_sessions(user_id);
CREATE INDEX chat_sessions_updated_at_idx ON chat_sessions(updated_at DESC);

-- ---------------------------------------------------------------------------
-- 2.5 AUDIT LOGS
-- ---------------------------------------------------------------------------

CREATE TABLE audit_logs (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  metadata JSONB DEFAULT '{}',
  -- D10/M18: bound at IPv6-with-embedded-v4 max length and a generous UA
  -- ceiling so a forged request can't bloat the table.
  ip_address VARCHAR(45),
  user_agent VARCHAR(512),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX audit_logs_user_id_idx    ON audit_logs(user_id);
CREATE INDEX audit_logs_action_idx     ON audit_logs(action);
CREATE INDEX audit_logs_created_at_idx ON audit_logs(created_at DESC);
CREATE INDEX audit_logs_target_user_idx ON audit_logs(target_user_id);

-- ---------------------------------------------------------------------------
-- 2.6 RATE LIMITS
-- ---------------------------------------------------------------------------

CREATE TABLE rate_limits (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_timestamp TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX rate_limits_user_time_idx ON rate_limits(user_id, request_timestamp DESC);

-- ---------------------------------------------------------------------------
-- 2.7 PERMIT APPLICATIONS
-- ---------------------------------------------------------------------------

CREATE TABLE permit_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted', 'under_review', 'approved', 'rejected', 'revision_requested')),
  project_name TEXT NOT NULL,
  project_type TEXT NOT NULL
    CHECK (project_type IN ('residential', 'commercial', 'industrial', 'mixed_use', 'institutional')),
  project_address TEXT NOT NULL,
  plot_number TEXT,
  project_description TEXT,
  building_details JSONB NOT NULL DEFAULT '{}',
  compliance_requirements JSONB NOT NULL DEFAULT '{}',
  compliance_check_result JSONB DEFAULT NULL,
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  review_comments TEXT,
  revision_count INTEGER NOT NULL DEFAULT 0,
  revision_notes TEXT,
  submitted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX permit_apps_user_id_idx     ON permit_applications(user_id);
CREATE INDEX permit_apps_status_idx      ON permit_applications(status);
CREATE INDEX permit_apps_created_at_idx  ON permit_applications(created_at DESC);
CREATE INDEX permit_apps_submitted_at_idx ON permit_applications(submitted_at DESC);
CREATE INDEX permit_apps_reviewed_by_idx ON permit_applications(reviewed_by);
CREATE INDEX permit_apps_project_type_idx ON permit_applications(project_type);

-- ---------------------------------------------------------------------------
-- 2.8 PERMIT STATUS HISTORY
-- ---------------------------------------------------------------------------

CREATE TABLE permit_status_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  permit_id UUID NOT NULL REFERENCES permit_applications(id) ON DELETE CASCADE,
  from_status TEXT
    CHECK (from_status IS NULL OR from_status IN ('draft', 'submitted', 'under_review', 'approved', 'rejected', 'revision_requested')),
  to_status TEXT NOT NULL
    CHECK (to_status IN ('draft', 'submitted', 'under_review', 'approved', 'rejected', 'revision_requested')),
  changed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  comment TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX permit_history_permit_id_idx  ON permit_status_history(permit_id);
CREATE INDEX permit_history_created_at_idx ON permit_status_history(created_at DESC);
CREATE INDEX permit_history_changed_by_idx ON permit_status_history(changed_by);

-- ---------------------------------------------------------------------------
-- 2.9 PERMIT ATTACHMENTS
-- ---------------------------------------------------------------------------

CREATE TABLE permit_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  permit_id UUID NOT NULL REFERENCES permit_applications(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  file_type TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX permit_attachments_permit_id_idx   ON permit_attachments(permit_id);
CREATE INDEX permit_attachments_uploaded_by_idx ON permit_attachments(uploaded_by);

-- ---------------------------------------------------------------------------
-- 2.10 NOTIFICATIONS
-- ---------------------------------------------------------------------------

CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN (
    'permit_submitted',
    'permit_under_review',
    'permit_approved',
    'permit_rejected',
    'permit_revision_requested'
  )),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  data JSONB DEFAULT '{}',
  read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX notifications_user_id_idx    ON notifications(user_id);
CREATE INDEX notifications_user_unread_idx ON notifications(user_id, read) WHERE read = FALSE;
CREATE INDEX notifications_created_at_idx ON notifications(created_at DESC);

-- ---------------------------------------------------------------------------
-- 2.11 PERMIT CERTIFICATES
-- ---------------------------------------------------------------------------

CREATE TABLE permit_certificates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  permit_id UUID NOT NULL REFERENCES permit_applications(id) ON DELETE CASCADE,
  certificate_number TEXT NOT NULL UNIQUE,
  generated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  storage_path TEXT,
  generated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX permit_certificates_permit_id_idx ON permit_certificates(permit_id);
-- certificate_number already has a UNIQUE column constraint above, which creates
-- an implicit unique index; a second permit_certificates_number_idx would be
-- redundant (D14/L8).

-- ---------------------------------------------------------------------------
-- 2.12 PARENT CHUNKS (v2 Pipeline - Parent-Child Chunking)
-- ---------------------------------------------------------------------------

CREATE TABLE parent_chunks (
  id BIGSERIAL PRIMARY KEY,
  content TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  document_name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX parent_chunks_document_name_idx ON parent_chunks(document_name);

-- Add foreign key from dubai_code_chunks.parent_id to parent_chunks.id
ALTER TABLE dubai_code_chunks ADD CONSTRAINT dubai_code_chunks_parent_id_fkey
  FOREIGN KEY (parent_id) REFERENCES parent_chunks(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- 2.13 SEMANTIC CACHE (v2 Pipeline - Query Response Caching)
-- ---------------------------------------------------------------------------

CREATE TABLE semantic_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  query_text TEXT NOT NULL,
  query_embedding VECTOR(768) NOT NULL,
  response TEXT NOT NULL,
  citations JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  ttl_seconds INT NOT NULL DEFAULT 3600  -- 1 hour default
);

CREATE INDEX semantic_cache_embedding_idx
  ON semantic_cache USING hnsw (query_embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX semantic_cache_created_at_idx ON semantic_cache(created_at DESC);

-- ---------------------------------------------------------------------------
-- 2.14 DOCUMENT REGISTRY (Dynamic document management)
-- ---------------------------------------------------------------------------

CREATE TABLE document_registry (
  -- D11/M19: bound to reasonable lengths (id is also an FK target).
  id VARCHAR(64) PRIMARY KEY,                   -- e.g. 'building-code-2021'
  display_name VARCHAR(128) NOT NULL,
  short_name TEXT NOT NULL,
  file_name TEXT NOT NULL,                      -- PDF filename (original name)
  storage_path TEXT DEFAULT NULL,               -- Supabase Storage path (e.g. 'documents/doc-id/file.pdf')
  source_url TEXT DEFAULT '',
  authority TEXT DEFAULT '',
  description TEXT DEFAULT '',
  badge_color VARCHAR(128) DEFAULT 'bg-gray-500/20 text-gray-400 border-gray-500/30',
  keywords TEXT[] DEFAULT '{}',                 -- For document selector scoring
  categories TEXT[] DEFAULT '{}',               -- Category tags
  is_active BOOLEAN DEFAULT TRUE,               -- Soft delete / disable
  keywords_auto_generated BOOLEAN DEFAULT TRUE,  -- FALSE if admin manually edited keywords
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_document_registry_active ON document_registry(is_active) WHERE is_active = TRUE;

-- D18/P2-A8: real FK from chunks → registry. CASCADE so a hard-delete of
-- the registry row cleans up orphaned chunks.
ALTER TABLE dubai_code_chunks
  ADD CONSTRAINT dubai_code_chunks_document_name_fkey
  FOREIGN KEY (document_name) REFERENCES document_registry(id) ON DELETE CASCADE;

-- D18: keep a single inactive 'unknown' stub so the dubai_code_chunks
-- default value doesn't violate the FK if a future ingestion path ever
-- forgets to supply document_name. is_active=false hides it from the
-- selector / dashboard.
INSERT INTO document_registry (id, display_name, short_name, file_name, is_active)
VALUES ('unknown', 'Unknown (orphan chunks)', 'UNK', 'unknown.pdf', FALSE)
ON CONFLICT (id) DO NOTHING;

-- No other seed documents — documents are added dynamically via the admin panel.
-- Example:
-- INSERT INTO document_registry (id, display_name, short_name, file_name, authority, description, badge_color, keywords, categories)
-- VALUES ('my-building-code', 'My Building Code', 'MBC', 'my-code.pdf', '', 'Description', 'bg-blue-500/20 text-blue-400 border-blue-500/30', '{}', '{}');

-- ============================================================================
-- 3. TRIGGERS
-- ============================================================================

-- Auto-update chat_sessions.updated_at when a message is inserted
CREATE OR REPLACE FUNCTION update_session_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE chat_sessions SET updated_at = NOW() WHERE id = NEW.session_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_session_on_message
AFTER INSERT ON chat_messages
FOR EACH ROW EXECUTE FUNCTION update_session_timestamp();

-- Auto-update permit_applications.updated_at on any update
CREATE OR REPLACE FUNCTION update_permit_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_permit_on_change
BEFORE UPDATE ON permit_applications
FOR EACH ROW EXECUTE FUNCTION update_permit_timestamp();

-- ============================================================================
-- 4. MATERIALIZED VIEWS
-- ============================================================================

CREATE MATERIALIZED VIEW analytics_daily AS
SELECT
  DATE(cm.created_at) AS date,
  COUNT(DISTINCT cs.user_id) AS active_users,
  COUNT(*) AS total_messages,
  COUNT(*) FILTER (WHERE cm.role = 'user') AS user_messages,
  COUNT(*) FILTER (WHERE cm.role = 'assistant') AS assistant_messages
FROM chat_messages cm
JOIN chat_sessions cs ON cm.session_id = cs.id
GROUP BY DATE(cm.created_at);
-- ORDER BY inside a materialized view is dropped on every REFRESH and only
-- happens to hold on the initial CREATE; consumers must add ORDER BY at query
-- time. The unique index on (date) lets the planner serve sorted scans for free
-- when the consumer asks for them. (D15/L9)

CREATE UNIQUE INDEX analytics_daily_date_idx ON analytics_daily(date);

-- ============================================================================
-- 5. RAG SEARCH FUNCTIONS (multi-document versions)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 5.1 Vector Search
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
    d.id, d.content, d.metadata,
    (1 - (d.embedding <=> query_embedding))::FLOAT AS similarity
  FROM dubai_code_chunks d
  WHERE 1 - (d.embedding <=> query_embedding) > 0.5
    AND (filter_document IS NULL OR d.document_name = filter_document)
  ORDER BY d.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5.2 Keyword Search (FTS)
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
  IF sanitized_query = '' THEN RETURN; END IF;

  tsquery_val := plainto_tsquery('english', sanitized_query);

  RETURN QUERY
  SELECT
    d.id, d.content, d.metadata,
    ts_rank_cd(d.fts, tsquery_val)::FLOAT AS rank
  FROM dubai_code_chunks d
  WHERE d.fts @@ tsquery_val
    AND (filter_document IS NULL OR d.document_name = filter_document)
  ORDER BY ts_rank_cd(d.fts, tsquery_val) DESC
  LIMIT LEAST(match_count, 100);
END;
$$;

-- ---------------------------------------------------------------------------
-- 5.3 Hybrid Search (Vector + Keyword, RRF)
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
  IF sanitized_query = '' THEN sanitized_query := query_text; END IF;

  tsquery_val := plainto_tsquery('english', sanitized_query);

  RETURN QUERY
  WITH vector_results AS (
    SELECT
      d.id, d.content, d.metadata,
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
      d.id, d.content, d.metadata,
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
    combined_id, combined_content, combined_metadata,
    combined_v_similarity, combined_k_rank, combined_score
  FROM combined
  ORDER BY combined_score DESC
  LIMIT match_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5.4 Hybrid Search Filtered by Page Ranges (Tree Reasoning)
-- ---------------------------------------------------------------------------

-- D4/H18: inline the page-range predicate into each branch. A CTE
-- (page_filtered) materializes and hides the HNSW / fts GIN index
-- access paths from the inner ORDER BY/LIMIT. Reading dubai_code_chunks
-- directly in each branch keeps the indexes available.
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

-- ---------------------------------------------------------------------------
-- 5.5 Exact Text Search
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
    d.id, d.content, d.metadata,
    POSITION(LOWER(safe_pattern) IN LOWER(d.content))::INT AS match_position
  FROM dubai_code_chunks d
  WHERE LOWER(d.content) LIKE '%' || LOWER(safe_pattern) || '%'
    AND (filter_document IS NULL OR d.document_name = filter_document)
  ORDER BY match_position
  LIMIT LEAST(match_count, 100);
END;
$$;

-- ---------------------------------------------------------------------------
-- 5.6 Find Chunks by Page
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
    d.id, d.content, d.metadata,
    CASE
      WHEN (d.metadata->>'startPage')::INT = target_page
           AND (d.metadata->>'endPage')::INT = target_page THEN 'exact'
      WHEN (d.metadata->>'startPage')::INT <= target_page
           AND (d.metadata->>'endPage')::INT >= target_page THEN 'range'
      WHEN (d.metadata->>'page')::INT = target_page THEN 'legacy'
      ELSE 'none'
    END AS page_match_type
  FROM dubai_code_chunks d
  WHERE (
      ((d.metadata->>'startPage')::INT <= target_page
       AND (d.metadata->>'endPage')::INT >= target_page)
    OR (d.metadata->>'page')::INT = target_page
    )
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
-- 5.7 Find Chunks by Section
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
    d.id, d.content, d.metadata,
    CASE
      WHEN d.metadata->>'section' = section_number THEN 'exact'
      WHEN d.metadata->>'section' LIKE section_number || '.%' THEN 'child'
      WHEN section_number LIKE (d.metadata->>'section') || '.%' THEN 'parent'
      ELSE 'none'
    END AS section_match_type
  FROM dubai_code_chunks d
  WHERE (
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
-- 5.8 Match Citation
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
    d.id, d.content, d.metadata,
    (
      CASE
        WHEN (d.metadata->>'startPage')::INT = citation_page
             AND (d.metadata->>'endPage')::INT = citation_page THEN 50
        WHEN (d.metadata->>'startPage')::INT <= citation_page
             AND (d.metadata->>'endPage')::INT >= citation_page THEN 30
        WHEN (d.metadata->>'page')::INT = citation_page THEN 40
        ELSE 0
      END
      +
      CASE
        WHEN citation_section IS NOT NULL AND d.metadata->>'section' = citation_section THEN 50
        WHEN citation_section IS NOT NULL AND d.metadata->>'section' LIKE citation_section || '%' THEN 20
        WHEN citation_section IS NULL THEN 10
        ELSE 0
      END
    )::INT AS match_score
  FROM dubai_code_chunks d
  WHERE (
      ((d.metadata->>'startPage')::INT <= citation_page
       AND (d.metadata->>'endPage')::INT >= citation_page)
    OR (d.metadata->>'page')::INT = citation_page
    )
    AND (filter_document IS NULL OR d.document_name = filter_document)
  ORDER BY match_score DESC
  LIMIT match_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5.9 Tree Helper Functions
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION get_document_tree(
  p_document_name TEXT DEFAULT ''
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

-- ---------------------------------------------------------------------------
-- 5.10 Document Stats & Cleanup
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

CREATE OR REPLACE FUNCTION clear_document_chunks(target_document TEXT)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  deleted_count BIGINT;
BEGIN
  -- Delete child chunks (must go first due to parent_id FK)
  DELETE FROM dubai_code_chunks WHERE document_name = target_document;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  -- Delete orphaned parent chunks for this document
  DELETE FROM parent_chunks WHERE document_name = target_document;
  RETURN deleted_count;
END;
$$;

-- ============================================================================
-- 6. RATE LIMIT FUNCTION
-- ============================================================================

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
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_window_start TIMESTAMPTZ;
  v_last_request TIMESTAMPTZ;
  v_request_count INT;
  v_ms_since_last INT;
BEGIN
  v_window_start := NOW() - (p_window_seconds || ' seconds')::INTERVAL;

  SELECT COUNT(*), MAX(request_timestamp)
  INTO v_request_count, v_last_request
  FROM rate_limits
  WHERE user_id = p_user_id AND request_timestamp > v_window_start;

  -- Check minimum interval
  IF v_last_request IS NOT NULL THEN
    v_ms_since_last := EXTRACT(EPOCH FROM (NOW() - v_last_request)) * 1000;
    IF v_ms_since_last < p_min_interval_ms THEN
      RETURN QUERY SELECT FALSE, (p_min_interval_ms - v_ms_since_last)::INT, v_request_count::INT;
      RETURN;
    END IF;
  END IF;

  -- Check max requests
  IF v_request_count >= p_max_requests THEN
    RETURN QUERY SELECT FALSE, (p_window_seconds * 1000)::INT, v_request_count::INT;
    RETURN;
  END IF;

  -- Allowed — record and cleanup
  INSERT INTO rate_limits (user_id, request_timestamp) VALUES (p_user_id, NOW());
  DELETE FROM rate_limits WHERE user_id = p_user_id AND request_timestamp < NOW() - INTERVAL '1 hour';

  RETURN QUERY SELECT TRUE, 0::INT, (v_request_count + 1)::INT;
END;
$$;

-- ============================================================================
-- 7. ANALYTICS & ADMIN FUNCTIONS
-- ============================================================================

CREATE OR REPLACE FUNCTION refresh_analytics()
RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY analytics_daily;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ---------------------------------------------------------------------------
-- 7.1 Admin Dashboard Stats (legacy)
-- ---------------------------------------------------------------------------

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
    (SELECT COUNT(*) FROM users)::BIGINT,
    (SELECT COUNT(DISTINCT cs.user_id)
     FROM chat_messages cm JOIN chat_sessions cs ON cm.session_id = cs.id
     WHERE cm.created_at > NOW() - INTERVAL '24 hours')::BIGINT,
    (SELECT COUNT(*) FROM chat_sessions)::BIGINT,
    (SELECT COUNT(*) FROM chat_messages)::BIGINT,
    (SELECT COUNT(*) FROM chat_messages WHERE created_at > NOW() - INTERVAL '24 hours')::BIGINT,
    (SELECT COUNT(*) FROM users WHERE blocked = TRUE)::BIGINT;
END;
$$;

-- ---------------------------------------------------------------------------
-- 7.2 Weekly Activity
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION get_weekly_activity()
RETURNS TABLE (day DATE, messages BIGINT, users BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT
    DATE(d.day),
    COALESCE(COUNT(m.id), 0)::BIGINT,
    COALESCE(COUNT(DISTINCT m.session_id), 0)::BIGINT
  FROM generate_series(NOW() - INTERVAL '7 days', NOW(), INTERVAL '1 day') AS d(day)
  LEFT JOIN chat_messages m ON DATE(m.created_at) = DATE(d.day)
  GROUP BY DATE(d.day)
  ORDER BY DATE(d.day);
END;
$$;

-- ---------------------------------------------------------------------------
-- 7.3 Recent Audit Logs
-- ---------------------------------------------------------------------------

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
    al.id, al.user_id, u.username, al.action,
    al.target_user_id, tu.username AS target_username,
    al.metadata, al.ip_address, al.created_at
  FROM audit_logs al
  LEFT JOIN users u ON al.user_id = u.id
  LEFT JOIN users tu ON al.target_user_id = tu.id
  WHERE (p_action_filter IS NULL OR al.action = p_action_filter)
  ORDER BY al.created_at DESC
  LIMIT LEAST(p_limit, 500);
END;
$$;

-- ---------------------------------------------------------------------------
-- 7.4 Enhanced Analytics Dashboard Stats (today vs yesterday trends)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION get_analytics_dashboard_stats()
RETURNS TABLE (
  total_users BIGINT,
  active_users_today BIGINT,
  active_users_yesterday BIGINT,
  messages_today BIGINT,
  messages_yesterday BIGINT,
  permits_today BIGINT,
  permits_yesterday BIGINT,
  new_users_today BIGINT,
  new_users_yesterday BIGINT,
  total_chunks BIGINT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    (SELECT count(*) FROM users),
    (SELECT count(DISTINCT user_id) FROM chat_sessions WHERE created_at >= date_trunc('day', now())),
    (SELECT count(DISTINCT user_id) FROM chat_sessions
     WHERE created_at >= date_trunc('day', now() - interval '1 day')
       AND created_at < date_trunc('day', now())),
    (SELECT count(*) FROM chat_messages WHERE created_at >= date_trunc('day', now())),
    (SELECT count(*) FROM chat_messages
     WHERE created_at >= date_trunc('day', now() - interval '1 day')
       AND created_at < date_trunc('day', now())),
    (SELECT count(*) FROM permit_applications WHERE created_at >= date_trunc('day', now())),
    (SELECT count(*) FROM permit_applications
     WHERE created_at >= date_trunc('day', now() - interval '1 day')
       AND created_at < date_trunc('day', now())),
    (SELECT count(*) FROM users WHERE created_at >= date_trunc('day', now())),
    (SELECT count(*) FROM users
     WHERE created_at >= date_trunc('day', now() - interval '1 day')
       AND created_at < date_trunc('day', now())),
    (SELECT count(*) FROM dubai_code_chunks);
$$;

-- ---------------------------------------------------------------------------
-- 7.5 Message Activity (30 days, no gaps)
-- ---------------------------------------------------------------------------

-- D2/H15+H16: read historic days from analytics_daily MV, recompute today
-- live. The admin "Refresh" button calls refresh_analytics() to update the
-- MV on demand.
CREATE OR REPLACE FUNCTION get_message_activity_30d()
RETURNS TABLE (
  day DATE,
  user_count BIGINT,
  assistant_count BIGINT,
  total_count BIGINT,
  active_users BIGINT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH date_series AS (
    SELECT generate_series(
      (current_date - interval '29 days')::date,
      current_date,
      '1 day'::interval
    )::date AS day
  ),
  historic AS (
    SELECT
      ad.date AS day,
      ad.user_messages AS user_count,
      ad.assistant_messages AS assistant_count,
      ad.total_messages AS total_count,
      ad.active_users
    FROM analytics_daily ad
    WHERE ad.date >= current_date - interval '29 days'
      AND ad.date < current_date
  ),
  today_live AS (
    SELECT
      current_date::date AS day,
      count(*) FILTER (WHERE cm.role = 'user') AS user_count,
      count(*) FILTER (WHERE cm.role = 'assistant') AS assistant_count,
      count(*) AS total_count,
      count(DISTINCT cs.user_id) AS active_users
    FROM chat_messages cm
    JOIN chat_sessions cs ON cs.id = cm.session_id
    WHERE cm.created_at >= current_date
  ),
  merged AS (
    SELECT * FROM historic
    UNION ALL
    SELECT * FROM today_live WHERE total_count > 0
  )
  SELECT
    ds.day,
    COALESCE(m.user_count, 0),
    COALESCE(m.assistant_count, 0),
    COALESCE(m.total_count, 0),
    COALESCE(m.active_users, 0)
  FROM date_series ds
  LEFT JOIN merged m ON m.day = ds.day
  ORDER BY ds.day;
$$;

-- ---------------------------------------------------------------------------
-- 7.6 Top Active Users
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION get_top_active_users(
  p_days INT DEFAULT 30,
  p_limit INT DEFAULT 5
)
RETURNS TABLE (
  user_id UUID,
  username TEXT,
  full_name TEXT,
  message_count BIGINT,
  last_active TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    u.id, u.username, u.full_name,
    count(cm.id) AS message_count,
    max(cm.created_at) AS last_active
  FROM users u
  JOIN chat_sessions cs ON cs.user_id = u.id
  JOIN chat_messages cm ON cm.session_id = cs.id
  WHERE cm.created_at >= now() - (p_days || ' days')::interval
    AND cm.role = 'user'
  GROUP BY u.id, u.username, u.full_name
  ORDER BY message_count DESC
  LIMIT p_limit;
$$;

-- ---------------------------------------------------------------------------
-- 7.7 Permit Stats
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION get_permit_stats()
RETURNS TABLE (
  total_permits BIGINT,
  draft_count BIGINT,
  submitted_count BIGINT,
  under_review_count BIGINT,
  approved_count BIGINT,
  rejected_count BIGINT,
  revision_requested_count BIGINT,
  permits_today BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    (SELECT COUNT(*) FROM permit_applications)::BIGINT,
    (SELECT COUNT(*) FROM permit_applications WHERE status = 'draft')::BIGINT,
    (SELECT COUNT(*) FROM permit_applications WHERE status = 'submitted')::BIGINT,
    (SELECT COUNT(*) FROM permit_applications WHERE status = 'under_review')::BIGINT,
    (SELECT COUNT(*) FROM permit_applications WHERE status = 'approved')::BIGINT,
    (SELECT COUNT(*) FROM permit_applications WHERE status = 'rejected')::BIGINT,
    (SELECT COUNT(*) FROM permit_applications WHERE status = 'revision_requested')::BIGINT,
    (SELECT COUNT(*) FROM permit_applications WHERE created_at > NOW() - INTERVAL '24 hours')::BIGINT;
END;
$$;

-- ============================================================================
-- 8. USER MANAGEMENT FUNCTIONS (Admin)
-- ============================================================================

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
  v_target_role TEXT;
  v_unblocked_admin_count INT;
BEGIN
  SELECT role INTO v_admin_role FROM users WHERE id = p_admin_id;
  IF v_admin_role != 'admin' THEN RAISE EXCEPTION 'Unauthorized: Admin role required'; END IF;
  IF p_admin_id = p_target_user_id THEN RAISE EXCEPTION 'Cannot block yourself'; END IF;

  -- C9H/H12: if blocking the only remaining unblocked admin, refuse.
  -- FOR UPDATE prevents two concurrent blocks from both seeing count=2 and
  -- both proceeding (leaving zero admins).
  IF p_blocked THEN
    SELECT role INTO v_target_role FROM users WHERE id = p_target_user_id;
    IF v_target_role = 'admin' THEN
      SELECT count(*) INTO v_unblocked_admin_count
      FROM users
      WHERE role = 'admin' AND blocked = FALSE
      FOR UPDATE;
      IF v_unblocked_admin_count <= 1 THEN
        RAISE EXCEPTION 'Cannot block the only remaining unblocked admin';
      END IF;
    END IF;
  END IF;

  UPDATE users SET
    blocked = p_blocked,
    blocked_reason = CASE WHEN p_blocked THEN p_reason ELSE NULL END,
    blocked_at = CASE WHEN p_blocked THEN NOW() ELSE NULL END,
    blocked_by = CASE WHEN p_blocked THEN p_admin_id ELSE NULL END
  WHERE id = p_target_user_id;

  RETURN TRUE;
END;
$$;

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
  v_target_current_role TEXT;
  v_target_blocked BOOLEAN;
  v_unblocked_admin_count INT;
BEGIN
  IF p_new_role NOT IN ('admin', 'user') THEN RAISE EXCEPTION 'Invalid role'; END IF;
  SELECT role INTO v_admin_role FROM users WHERE id = p_admin_id;
  IF v_admin_role != 'admin' THEN RAISE EXCEPTION 'Unauthorized: Admin role required'; END IF;

  -- C9H/H12: demoting the only remaining unblocked admin would lock the
  -- system out. Same pattern as admin_block_user: SELECT FOR UPDATE to
  -- serialize concurrent demotions.
  SELECT role, blocked INTO v_target_current_role, v_target_blocked
  FROM users WHERE id = p_target_user_id;

  IF v_target_current_role = 'admin' AND p_new_role = 'user' AND v_target_blocked = FALSE THEN
    SELECT count(*) INTO v_unblocked_admin_count
    FROM users
    WHERE role = 'admin' AND blocked = FALSE
    FOR UPDATE;
    IF v_unblocked_admin_count <= 1 THEN
      RAISE EXCEPTION 'Cannot demote the only remaining unblocked admin';
    END IF;
  END IF;

  UPDATE users SET role = p_new_role WHERE id = p_target_user_id;
  RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION get_all_users_admin(
  p_admin_id UUID,
  p_limit INT DEFAULT 50,
  p_offset INT DEFAULT 0,
  p_search TEXT DEFAULT NULL,
  p_after_created_at TIMESTAMPTZ DEFAULT NULL,
  p_after_id UUID DEFAULT NULL
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
SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin_role TEXT;
  v_use_keyset BOOLEAN := (p_after_created_at IS NOT NULL AND p_after_id IS NOT NULL);
BEGIN
  SELECT users.role INTO v_admin_role FROM users WHERE users.id = p_admin_id;
  IF v_admin_role != 'admin' THEN RAISE EXCEPTION 'Unauthorized: Admin role required'; END IF;

  -- D1/H14: replace two correlated subqueries per row with a single
  -- pre-aggregated session_stats CTE joined once.
  -- D12/M21: keyset pagination on (created_at DESC, id DESC). p_offset is
  -- still honored when no cursor is supplied for backward compat.
  RETURN QUERY
  WITH session_stats AS (
    SELECT cs.user_id,
           COUNT(*)::BIGINT AS session_count,
           COUNT(cm.id)::BIGINT AS message_count
    FROM chat_sessions cs
    LEFT JOIN chat_messages cm ON cm.session_id = cs.id
    GROUP BY cs.user_id
  )
  SELECT
    u.id, u.username, u.full_name, u.role, u.blocked, u.blocked_reason,
    u.created_at, u.last_login,
    COALESCE(s.session_count, 0)::BIGINT AS session_count,
    COALESCE(s.message_count, 0)::BIGINT AS message_count
  FROM users u
  LEFT JOIN session_stats s ON s.user_id = u.id
  WHERE (p_search IS NULL OR u.username ILIKE '%' || p_search || '%' OR u.full_name ILIKE '%' || p_search || '%')
    AND (NOT v_use_keyset OR (u.created_at, u.id) < (p_after_created_at, p_after_id))
  ORDER BY u.created_at DESC, u.id DESC
  LIMIT LEAST(p_limit, 100)
  OFFSET CASE WHEN v_use_keyset THEN 0 ELSE GREATEST(p_offset, 0) END;
END;
$$;

-- ============================================================================
-- 9. PERMISSIONS
-- ============================================================================

-- RAG system
-- A3/C5: anon and authenticated can only read; ingestion runs via service_role.
GRANT SELECT ON dubai_code_chunks TO anon, authenticated;
GRANT SELECT, INSERT, DELETE, UPDATE ON dubai_code_chunks TO service_role;
GRANT USAGE, SELECT ON SEQUENCE dubai_code_chunks_id_seq TO service_role;

-- RAG search functions
GRANT EXECUTE ON FUNCTION match_dubai_code TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION search_dubai_code_keywords TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION match_dubai_code_hybrid TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION match_dubai_code_hybrid_filtered TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION search_dubai_code_exact TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION find_chunks_by_page TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION find_chunks_by_section TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION match_citation TO anon, authenticated, service_role;

-- Tree Reasoning
GRANT SELECT ON document_trees TO anon, authenticated, service_role;
GRANT ALL ON document_trees TO service_role;
GRANT EXECUTE ON FUNCTION get_document_tree TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION save_document_tree TO service_role;

-- Users (restricted)
GRANT SELECT, UPDATE ON users TO authenticated;
GRANT ALL ON users TO service_role;

-- Chat
GRANT ALL ON chat_sessions TO authenticated, service_role;
GRANT ALL ON chat_messages TO authenticated, service_role;

-- Rate limits
GRANT ALL ON rate_limits TO authenticated, service_role;
GRANT USAGE, SELECT ON SEQUENCE rate_limits_id_seq TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION check_rate_limit TO authenticated, service_role;

-- Audit logs
GRANT INSERT ON audit_logs TO authenticated;
GRANT ALL ON audit_logs TO service_role;
GRANT USAGE, SELECT ON SEQUENCE audit_logs_id_seq TO authenticated, service_role;

-- Permits
GRANT ALL ON permit_applications TO authenticated, service_role;
GRANT ALL ON permit_status_history TO authenticated, service_role;
GRANT ALL ON permit_attachments TO authenticated, service_role;
GRANT ALL ON permit_certificates TO authenticated, service_role;

-- Notifications
GRANT ALL ON notifications TO authenticated, service_role;

-- Document Registry
GRANT SELECT ON document_registry TO anon, authenticated;
GRANT ALL ON document_registry TO service_role;

-- Trigger function
GRANT EXECUTE ON FUNCTION update_session_timestamp TO authenticated, service_role;

-- Admin-only functions
GRANT EXECUTE ON FUNCTION get_admin_stats TO service_role;
GRANT EXECUTE ON FUNCTION get_weekly_activity TO service_role;
GRANT EXECUTE ON FUNCTION get_recent_audit_logs TO service_role;
GRANT EXECUTE ON FUNCTION admin_block_user TO service_role;
GRANT EXECUTE ON FUNCTION admin_update_user_role TO service_role;
GRANT EXECUTE ON FUNCTION get_all_users_admin TO service_role;
GRANT EXECUTE ON FUNCTION refresh_analytics TO service_role;
GRANT EXECUTE ON FUNCTION get_permit_stats TO service_role;
GRANT EXECUTE ON FUNCTION get_document_stats TO service_role;
GRANT EXECUTE ON FUNCTION clear_document_chunks TO service_role;
GRANT EXECUTE ON FUNCTION get_analytics_dashboard_stats TO service_role;
GRANT EXECUTE ON FUNCTION get_message_activity_30d TO service_role;
GRANT EXECUTE ON FUNCTION get_top_active_users TO service_role;

-- ============================================================================
-- 10. ROW LEVEL SECURITY
-- ============================================================================

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE dubai_code_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_trees ENABLE ROW LEVEL SECURITY;
ALTER TABLE permit_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE permit_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE permit_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE permit_certificates ENABLE ROW LEVEL SECURITY;
ALTER TABLE parent_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE semantic_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_registry ENABLE ROW LEVEL SECURITY;

-- Users: authenticated can read/update only own profile
CREATE POLICY "Authenticated users can view own profile" ON users
  FOR SELECT TO authenticated USING (id = auth.uid());
CREATE POLICY "Authenticated users can update own profile" ON users
  FOR UPDATE TO authenticated USING (id = auth.uid()) WITH CHECK (id = auth.uid());

-- dubai_code_chunks: read for authenticated, full for service_role (ingestion)
CREATE POLICY "Allow read chunks" ON dubai_code_chunks
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role full access to chunks" ON dubai_code_chunks
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- document_trees: read for all, write for service_role
CREATE POLICY "Allow read document trees" ON document_trees
  FOR SELECT TO anon, authenticated, service_role USING (true);
CREATE POLICY "Service role full access to document trees" ON document_trees
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================================================
-- Ownership-based policies (A1/C3). Service_role bypasses RLS by definition,
-- so admin server actions (createAdminClient) keep their unrestricted access.
-- The authenticated grants are tightened to "only your own rows" via auth.uid()
-- — defense in depth in case a future read path moves to the user-context
-- (anon-key + JWT) client introduced in A2.
-- ============================================================================

-- chat_sessions: own sessions only
CREATE POLICY "Users access own chat_sessions" ON chat_sessions
  FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY "Service role full access to chat_sessions" ON chat_sessions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- chat_messages: ownership via parent chat_sessions
CREATE POLICY "Users access own chat_messages" ON chat_messages
  FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM chat_sessions cs WHERE cs.id = chat_messages.session_id
            AND cs.user_id = (SELECT auth.uid()))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM chat_sessions cs WHERE cs.id = chat_messages.session_id
            AND cs.user_id = (SELECT auth.uid()))
  );
CREATE POLICY "Service role full access to chat_messages" ON chat_messages
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- audit_logs: service_role only (written by server actions)
CREATE POLICY "Service role full access to audit_logs" ON audit_logs
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- rate_limits: service_role only
CREATE POLICY "Service role full access to rate_limits" ON rate_limits
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- permit_applications: own permits only
CREATE POLICY "Users access own permit_applications" ON permit_applications
  FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY "Service role full access to permit_applications" ON permit_applications
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- permit_status_history: ownership via parent permit
CREATE POLICY "Users access own permit_status_history" ON permit_status_history
  FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM permit_applications pa WHERE pa.id = permit_status_history.permit_id
            AND pa.user_id = (SELECT auth.uid()))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM permit_applications pa WHERE pa.id = permit_status_history.permit_id
            AND pa.user_id = (SELECT auth.uid()))
  );
CREATE POLICY "Service role full access to permit_status_history" ON permit_status_history
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- permit_attachments: ownership via parent permit
CREATE POLICY "Users access own permit_attachments" ON permit_attachments
  FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM permit_applications pa WHERE pa.id = permit_attachments.permit_id
            AND pa.user_id = (SELECT auth.uid()))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM permit_applications pa WHERE pa.id = permit_attachments.permit_id
            AND pa.user_id = (SELECT auth.uid()))
  );
CREATE POLICY "Service role full access to permit_attachments" ON permit_attachments
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- notifications: own rows only
CREATE POLICY "Users access own notifications" ON notifications
  FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY "Service role full access to notifications" ON notifications
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- permit_certificates: ownership via parent permit
CREATE POLICY "Users access own permit_certificates" ON permit_certificates
  FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM permit_applications pa WHERE pa.id = permit_certificates.permit_id
            AND pa.user_id = (SELECT auth.uid()))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM permit_applications pa WHERE pa.id = permit_certificates.permit_id
            AND pa.user_id = (SELECT auth.uid()))
  );
CREATE POLICY "Service role full access to permit_certificates" ON permit_certificates
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- parent_chunks: service_role only (DB-C-5 / v1.0.0 Part D). The user-facing
-- chat path reads parents via createAdminClient (service_role), so the broad
-- "Allow read parent_chunks" policy that previously existed only leaked
-- chunk content to direct PostgREST callers — removed.
CREATE POLICY "Service role full access to parent_chunks" ON parent_chunks
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- semantic_cache: service_role only (DB-C-5 / v1.0.0 Part D). The "Allow read
-- semantic_cache" policy that previously existed exposed verbatim user queries
-- and AI responses to any logged-in user via the anon REST endpoint.
CREATE POLICY "Service role full access to semantic_cache" ON semantic_cache
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- document_registry: read for all, write via service_role only
CREATE POLICY "Allow read document registry" ON document_registry
  FOR SELECT TO anon, authenticated, service_role USING (true);
CREATE POLICY "Service role full access to document registry" ON document_registry
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================================================
-- 11. REVOKE — Harden sensitive tables & admin functions
-- ============================================================================

REVOKE EXECUTE ON FUNCTION admin_block_user FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION admin_update_user_role FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION get_all_users_admin FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION get_admin_stats FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION get_recent_audit_logs FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION refresh_analytics FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION get_permit_stats FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION get_document_stats FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION clear_document_chunks FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION get_analytics_dashboard_stats FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION get_message_activity_30d FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION get_top_active_users FROM anon, authenticated;

REVOKE ALL ON users FROM anon;
REVOKE ALL ON audit_logs FROM anon;

-- ============================================================================
-- 11.5 SEMANTIC CACHE FUNCTIONS (v2 Pipeline)
-- ============================================================================

-- Search cache for semantically similar queries (cosine similarity > threshold)
CREATE OR REPLACE FUNCTION search_semantic_cache(
  query_embedding VECTOR(768),
  similarity_threshold FLOAT DEFAULT 0.95,
  max_age_seconds INT DEFAULT 3600
)
RETURNS TABLE (
  id UUID,
  query_text TEXT,
  response TEXT,
  citations JSONB,
  similarity FLOAT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    sc.id, sc.query_text, sc.response, sc.citations,
    (1 - (sc.query_embedding <=> search_semantic_cache.query_embedding))::FLOAT AS similarity
  FROM semantic_cache sc
  WHERE (1 - (sc.query_embedding <=> search_semantic_cache.query_embedding)) > similarity_threshold
    AND sc.created_at > NOW() - (max_age_seconds || ' seconds')::INTERVAL
  ORDER BY sc.query_embedding <=> search_semantic_cache.query_embedding
  LIMIT 1;
END;
$$;

-- Insert a new cache entry
CREATE OR REPLACE FUNCTION insert_semantic_cache(
  p_query_text TEXT,
  p_query_embedding VECTOR(768),
  p_response TEXT,
  p_citations JSONB DEFAULT '[]',
  p_ttl_seconds INT DEFAULT 3600
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_id UUID;
BEGIN
  INSERT INTO semantic_cache (query_text, query_embedding, response, citations, ttl_seconds)
  VALUES (p_query_text, p_query_embedding, p_response, p_citations, p_ttl_seconds)
  RETURNING semantic_cache.id INTO new_id;
  RETURN new_id;
END;
$$;

-- Cleanup expired cache entries
CREATE OR REPLACE FUNCTION cleanup_semantic_cache()
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  deleted_count BIGINT;
BEGIN
  DELETE FROM semantic_cache
  WHERE created_at < NOW() - (ttl_seconds || ' seconds')::INTERVAL;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

-- Fetch parent chunk content for child chunks (parent-child expansion)
CREATE OR REPLACE FUNCTION get_parent_chunks(
  child_ids BIGINT[]
)
RETURNS TABLE (
  child_id BIGINT,
  parent_id BIGINT,
  parent_content TEXT,
  parent_metadata JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    c.id AS child_id,
    p.id AS parent_id,
    p.content AS parent_content,
    p.metadata AS parent_metadata
  FROM dubai_code_chunks c
  JOIN parent_chunks p ON c.parent_id = p.id
  WHERE c.id = ANY(child_ids)
    AND c.parent_id IS NOT NULL;
END;
$$;

-- ============================================================================
-- 11.6 DOCUMENT REGISTRY FUNCTIONS
-- ============================================================================

-- Get all active documents
CREATE OR REPLACE FUNCTION get_all_documents()
RETURNS TABLE (
  id TEXT,
  display_name TEXT,
  short_name TEXT,
  file_name TEXT,
  storage_path TEXT,
  source_url TEXT,
  authority TEXT,
  description TEXT,
  badge_color TEXT,
  keywords TEXT[],
  categories TEXT[],
  is_active BOOLEAN,
  keywords_auto_generated BOOLEAN,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT dr.id, dr.display_name, dr.short_name, dr.file_name,
         dr.storage_path, dr.source_url, dr.authority, dr.description, dr.badge_color,
         dr.keywords, dr.categories, dr.is_active, dr.keywords_auto_generated,
         dr.created_at, dr.updated_at
  FROM document_registry dr
  ORDER BY dr.created_at;
END;
$$;

-- Upsert document (insert or update)
CREATE OR REPLACE FUNCTION upsert_document(
  p_id TEXT,
  p_display_name TEXT,
  p_short_name TEXT,
  p_file_name TEXT,
  p_source_url TEXT DEFAULT '',
  p_authority TEXT DEFAULT '',
  p_description TEXT DEFAULT '',
  p_badge_color TEXT DEFAULT 'bg-gray-500/20 text-gray-400 border-gray-500/30',
  p_keywords TEXT[] DEFAULT '{}',
  p_categories TEXT[] DEFAULT '{}',
  p_keywords_auto_generated BOOLEAN DEFAULT TRUE
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO document_registry (id, display_name, short_name, file_name, source_url, authority, description, badge_color, keywords, categories, keywords_auto_generated)
  VALUES (p_id, p_display_name, p_short_name, p_file_name, p_source_url, p_authority, p_description, p_badge_color, p_keywords, p_categories, p_keywords_auto_generated)
  ON CONFLICT (id) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    short_name = EXCLUDED.short_name,
    file_name = EXCLUDED.file_name,
    source_url = EXCLUDED.source_url,
    authority = EXCLUDED.authority,
    description = EXCLUDED.description,
    badge_color = EXCLUDED.badge_color,
    keywords = EXCLUDED.keywords,
    categories = EXCLUDED.categories,
    keywords_auto_generated = EXCLUDED.keywords_auto_generated,
    updated_at = NOW();
  RETURN p_id;
END;
$$;

-- Delete (soft) a document — sets is_active = false
CREATE OR REPLACE FUNCTION delete_document(p_id TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE document_registry SET is_active = FALSE, updated_at = NOW()
  WHERE document_registry.id = p_id;
  RETURN FOUND;
END;
$$;

GRANT EXECUTE ON FUNCTION get_all_documents TO service_role;
GRANT EXECUTE ON FUNCTION upsert_document TO service_role;
GRANT EXECUTE ON FUNCTION delete_document TO service_role;
REVOKE EXECUTE ON FUNCTION upsert_document FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION delete_document FROM anon, authenticated;

-- D19/P2-A9: atomic ingestion claim guarded by a per-document advisory
-- lock. Returns FALSE if another run is already 'pending' so /api/ingest
-- can refuse a second parallel call instead of inserting duplicate chunks.
CREATE OR REPLACE FUNCTION try_start_ingestion(p_document_id TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_current_state TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_document_id, 0));

  SELECT ingestion_state INTO v_current_state
    FROM document_registry
   WHERE id = p_document_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  IF v_current_state = 'pending' THEN
    RETURN FALSE;
  END IF;

  UPDATE document_registry
     SET ingestion_state = 'pending',
         ingestion_started_at = NOW(),
         ingestion_finished_at = NULL,
         updated_at = NOW()
   WHERE id = p_document_id;

  RETURN TRUE;
END;
$$;

GRANT EXECUTE ON FUNCTION try_start_ingestion(TEXT) TO service_role;
REVOKE EXECUTE ON FUNCTION try_start_ingestion(TEXT) FROM anon, authenticated;

REVOKE ALL ON FUNCTION search_semantic_cache(VECTOR(768), FLOAT, INT) FROM public, anon;
GRANT EXECUTE ON FUNCTION search_semantic_cache(VECTOR(768), FLOAT, INT) TO authenticated;
-- A4/H19: insert/cleanup mutate the cache; app calls them via service_role only.
REVOKE ALL ON FUNCTION insert_semantic_cache(TEXT, VECTOR(768), TEXT, JSONB, INT) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION insert_semantic_cache(TEXT, VECTOR(768), TEXT, JSONB, INT) TO service_role;
REVOKE ALL ON FUNCTION cleanup_semantic_cache() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION cleanup_semantic_cache() TO service_role;
REVOKE ALL ON FUNCTION get_parent_chunks(BIGINT[]) FROM public, anon;
GRANT EXECUTE ON FUNCTION get_parent_chunks(BIGINT[]) TO authenticated;

-- ============================================================================
-- 12. DATA CLEANUP FUNCTIONS (from 006_cleanup_functions)
-- ============================================================================

-- Clean old chat sessions (no activity in retention_days)
CREATE OR REPLACE FUNCTION cleanup_old_sessions(retention_days INT DEFAULT 90)
RETURNS TABLE(deleted_count BIGINT) AS $$
DECLARE
  _deleted BIGINT;
BEGIN
  WITH deleted AS (
    DELETE FROM chat_sessions
    WHERE updated_at < NOW() - (retention_days || ' days')::INTERVAL
    RETURNING id
  )
  SELECT COUNT(*) INTO _deleted FROM deleted;

  RETURN QUERY SELECT _deleted;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION cleanup_old_sessions(INT) FROM public, anon;
GRANT EXECUTE ON FUNCTION cleanup_old_sessions(INT) TO service_role;

-- Clean old audit logs (older than retention_days)
CREATE OR REPLACE FUNCTION cleanup_old_audit_logs(retention_days INT DEFAULT 365)
RETURNS TABLE(deleted_count BIGINT) AS $$
DECLARE
  _deleted BIGINT;
BEGIN
  WITH deleted AS (
    DELETE FROM audit_logs
    WHERE created_at < NOW() - (retention_days || ' days')::INTERVAL
    RETURNING id
  )
  SELECT COUNT(*) INTO _deleted FROM deleted;

  RETURN QUERY SELECT _deleted;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION cleanup_old_audit_logs(INT) FROM public, anon;
GRANT EXECUTE ON FUNCTION cleanup_old_audit_logs(INT) TO service_role;

-- Clean expired rate limit entries (older than 1 hour)
CREATE OR REPLACE FUNCTION cleanup_expired_rate_limits()
RETURNS TABLE(deleted_count BIGINT) AS $$
DECLARE
  _deleted BIGINT;
BEGIN
  WITH deleted AS (
    DELETE FROM rate_limits
    WHERE request_timestamp < NOW() - INTERVAL '1 hour'
    RETURNING id
  )
  SELECT COUNT(*) INTO _deleted FROM deleted;

  RETURN QUERY SELECT _deleted;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION cleanup_expired_rate_limits() FROM public, anon;
GRANT EXECUTE ON FUNCTION cleanup_expired_rate_limits() TO service_role;

-- Run all cleanup functions at once
CREATE OR REPLACE FUNCTION run_all_cleanup(
  session_retention_days INT DEFAULT 90,
  audit_retention_days INT DEFAULT 365
)
RETURNS TABLE(
  sessions_deleted BIGINT,
  audit_logs_deleted BIGINT,
  rate_limits_deleted BIGINT
) AS $$
DECLARE
  _sessions BIGINT;
  _audits BIGINT;
  _rates BIGINT;
BEGIN
  SELECT deleted_count INTO _sessions FROM cleanup_old_sessions(session_retention_days);
  SELECT deleted_count INTO _audits FROM cleanup_old_audit_logs(audit_retention_days);
  SELECT deleted_count INTO _rates FROM cleanup_expired_rate_limits();

  RETURN QUERY SELECT _sessions, _audits, _rates;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION run_all_cleanup(INT, INT) FROM public, anon;
GRANT EXECUTE ON FUNCTION run_all_cleanup(INT, INT) TO service_role;

-- ============================================================================
-- 13. DEFAULT ADMIN USER
-- ============================================================================

INSERT INTO users (username, password_hash, full_name, role)
VALUES (
  'admin',
  crypt('Admin123!', gen_salt('bf', 12)),
  'System Administrator',
  'admin'
) ON CONFLICT (username) DO NOTHING;

-- ============================================================================
-- 14. STORAGE BUCKET FOR DOCUMENT PDFs
-- ============================================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'document-pdfs',
  'document-pdfs',
  FALSE,
  104857600,  -- 100MB
  ARRAY['application/pdf']
)
ON CONFLICT (id) DO NOTHING;

-- Policy: only service_role can manage files (our server actions use adminClient)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'objects' AND policyname = 'Service role full access to document-pdfs'
  ) THEN
    CREATE POLICY "Service role full access to document-pdfs"
      ON storage.objects FOR ALL TO service_role
      USING (bucket_id = 'document-pdfs')
      WITH CHECK (bucket_id = 'document-pdfs');
  END IF;
END $$;

-- ============================================================================
-- VERIFICATION
-- ============================================================================

-- ============================================================================
-- IP Rate Limits (pre-login brute-force protection)
-- ============================================================================

CREATE TABLE ip_rate_limits (
  id BIGSERIAL PRIMARY KEY,
  ip_address TEXT NOT NULL,
  request_timestamp TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ip_rate_limits_ip_time_idx
  ON ip_rate_limits(ip_address, request_timestamp DESC);

ALTER TABLE ip_rate_limits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access to ip_rate_limits" ON ip_rate_limits
  FOR ALL TO service_role USING (true) WITH CHECK (true);

GRANT ALL ON ip_rate_limits TO service_role;
GRANT USAGE, SELECT ON SEQUENCE ip_rate_limits_id_seq TO service_role;

CREATE OR REPLACE FUNCTION check_ip_rate_limit(
  p_ip TEXT,
  p_window_seconds INT DEFAULT 60,
  p_max_requests INT DEFAULT 10
)
RETURNS TABLE(allowed BOOLEAN, request_count INT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_window_start TIMESTAMPTZ;
  v_request_count BIGINT;
BEGIN
  v_window_start := NOW() - (p_window_seconds || ' seconds')::INTERVAL;

  SELECT COUNT(*)
  INTO v_request_count
  FROM ip_rate_limits
  WHERE ip_address = p_ip AND request_timestamp > v_window_start;

  IF v_request_count >= p_max_requests THEN
    RETURN QUERY SELECT FALSE, v_request_count::INT;
    RETURN;
  END IF;

  -- Allowed — record request and cleanup old entries
  INSERT INTO ip_rate_limits (ip_address, request_timestamp) VALUES (p_ip, NOW());
  DELETE FROM ip_rate_limits
    WHERE ip_address = p_ip AND request_timestamp < NOW() - INTERVAL '1 hour';

  RETURN QUERY SELECT TRUE, (v_request_count + 1)::INT;
END;
$$;

REVOKE ALL ON FUNCTION check_ip_rate_limit(TEXT, INT, INT) FROM public, anon;
GRANT EXECUTE ON FUNCTION check_ip_rate_limit(TEXT, INT, INT) TO service_role;


-- ============================================================================
-- APPLIED MIGRATIONS 001-023 (merged inline for diploma single-file setup)
-- ============================================================================


-- ---- 001_add_pdf_hash.sql ----

-- ============================================================================
-- B5 — Track PDF content hash on document_registry
-- ============================================================================
--
-- pdf_hash:               SHA-256 of the most recently uploaded PDF.
-- last_ingested_pdf_hash: SHA-256 of the PDF that produced the *current* chunk
--                         set. When these diverge AND chunks already exist,
--                         the admin UI prompts before clearing prior chunks
--                         (avoids silently mixing old + new chunks).
--
-- Idempotent — safe to re-run after a fresh 000_full_setup.sql.

ALTER TABLE document_registry
  ADD COLUMN IF NOT EXISTS pdf_hash TEXT,
  ADD COLUMN IF NOT EXISTS last_ingested_pdf_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_document_registry_pdf_hash
  ON document_registry(pdf_hash)
  WHERE pdf_hash IS NOT NULL;


-- ---- 002_add_ingestion_state.sql ----

-- ============================================================================
-- B4 — Track explicit ingestion state on document_registry
-- ============================================================================
--
-- ingestion_state is one of:
--   NULL       — never ingested (default)
--   'pending'  — an ingestion job is currently running
--   'completed'— last ingestion finished successfully
--   'failed'   — last ingestion errored or was aborted
--   'aborted'  — client cancelled the ingestion mid-stream
--
-- Used by the admin UI to surface which documents are mid-ingest, and to mark
-- abandoned runs so admin can spot them after a server crash / browser close.
--
-- ingestion_started_at / ingestion_finished_at let the UI show wall-clock
-- duration and detect runs older than the longest-allowed ingestion window
-- (those are effectively stuck and should be re-tried).

ALTER TABLE document_registry
  ADD COLUMN IF NOT EXISTS ingestion_state TEXT
    CHECK (ingestion_state IS NULL OR ingestion_state IN ('pending', 'completed', 'failed', 'aborted')),
  ADD COLUMN IF NOT EXISTS ingestion_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ingestion_finished_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_document_registry_ingestion_state
  ON document_registry(ingestion_state)
  WHERE ingestion_state IS NOT NULL;


-- ---- 003_submit_permit_atomic.sql ----

-- ============================================================================
-- B7 — Atomic permit submit / revise RPCs
-- ============================================================================
--
-- Replaces two-step "UPDATE then INSERT status_history" with a single
-- transactional RPC so a crash between the two writes can't leave a permit
-- in 'submitted' state without a matching status history row.
--
-- Returns:
--   { status_changed boolean, is_resubmission boolean, project_name text,
--     prev_status text, new_status text }
-- so the caller can decide whether the row actually transitioned (false if
-- another tab raced and already moved it).
--
-- Best-effort notification stays in the application layer — it isn't part
-- of the DB transaction because notification failure shouldn't block the
-- state change (see B8 warning surface).

DROP FUNCTION IF EXISTS submit_permit_atomic(UUID, UUID);

CREATE OR REPLACE FUNCTION submit_permit_atomic(
  p_permit_id UUID,
  p_user_id UUID
)
RETURNS TABLE (
  status_changed BOOLEAN,
  is_resubmission BOOLEAN,
  project_name TEXT,
  prev_status TEXT,
  new_status TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_prev_status TEXT;
  v_revision_count INT;
  v_bd JSONB;
  v_project_name TEXT;
  v_is_resub BOOLEAN := FALSE;
BEGIN
  -- Lock the row for the duration of this transaction to prevent racing
  -- submitters from both observing status='draft' and both transitioning.
  SELECT pa.status, pa.revision_count, pa.building_details, pa.project_name
    INTO v_prev_status, v_revision_count, v_bd, v_project_name
  FROM permit_applications pa
  WHERE pa.id = p_permit_id AND pa.user_id = p_user_id
  FOR UPDATE;

  IF v_prev_status IS NULL THEN
    RAISE EXCEPTION 'PERMIT_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF v_prev_status NOT IN ('draft', 'revision_requested') THEN
    -- Idempotent: don't raise, just report no change.
    RETURN QUERY SELECT FALSE, FALSE, v_project_name, v_prev_status, v_prev_status;
    RETURN;
  END IF;

  -- Building details guard mirrors the action-layer check so the RPC is
  -- safe to call without re-validating in JS.
  IF v_bd IS NULL
     OR COALESCE((v_bd->>'numberOfFloors')::NUMERIC, 0) <= 0
     OR COALESCE((v_bd->>'totalBuiltUpArea')::NUMERIC, 0) <= 0
     OR COALESCE((v_bd->>'plotArea')::NUMERIC, 0) <= 0
     OR COALESCE((v_bd->>'buildingHeight')::NUMERIC, 0) <= 0 THEN
    RAISE EXCEPTION 'BUILDING_DETAILS_INCOMPLETE' USING ERRCODE = 'P0002';
  END IF;

  v_is_resub := v_prev_status = 'revision_requested';

  UPDATE permit_applications
     SET status = 'submitted',
         submitted_at = NOW(),
         revision_count = CASE WHEN v_is_resub THEN COALESCE(v_revision_count, 0) + 1
                               ELSE COALESCE(v_revision_count, 0) END,
         revision_notes = CASE WHEN v_is_resub THEN NULL ELSE revision_notes END,
         updated_at = NOW()
   WHERE id = p_permit_id AND user_id = p_user_id;

  INSERT INTO permit_status_history (permit_id, from_status, to_status, changed_by, comment)
  VALUES (
    p_permit_id,
    v_prev_status,
    'submitted',
    p_user_id,
    CASE WHEN v_is_resub THEN 'Application resubmitted after revision'
         ELSE 'Application submitted for review' END
  );

  RETURN QUERY SELECT TRUE, v_is_resub, v_project_name, v_prev_status, 'submitted'::TEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION submit_permit_atomic(UUID, UUID) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- revise_permit_atomic: same shape, for the user re-opening a returned permit.
-- ----------------------------------------------------------------------------

DROP FUNCTION IF EXISTS revise_permit_atomic(UUID, UUID);

CREATE OR REPLACE FUNCTION revise_permit_atomic(
  p_permit_id UUID,
  p_user_id UUID
)
RETURNS TABLE (
  status_changed BOOLEAN,
  prev_status TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_prev_status TEXT;
BEGIN
  SELECT pa.status INTO v_prev_status
  FROM permit_applications pa
  WHERE pa.id = p_permit_id AND pa.user_id = p_user_id
  FOR UPDATE;

  IF v_prev_status IS NULL THEN
    RAISE EXCEPTION 'PERMIT_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF v_prev_status <> 'revision_requested' THEN
    RETURN QUERY SELECT FALSE, v_prev_status;
    RETURN;
  END IF;

  UPDATE permit_applications
     SET status = 'draft',
         compliance_check_result = NULL,
         updated_at = NOW()
   WHERE id = p_permit_id AND user_id = p_user_id;

  INSERT INTO permit_status_history (permit_id, from_status, to_status, changed_by, comment)
  VALUES (p_permit_id, v_prev_status, 'draft', p_user_id, 'Started revision');

  RETURN QUERY SELECT TRUE, v_prev_status;
END;
$$;

GRANT EXECUTE ON FUNCTION revise_permit_atomic(UUID, UUID) TO authenticated, service_role;


-- ---- 004_insert_permit_attachment_capped.sql ----

-- ============================================================================
-- C6H — Atomic per-permit attachment insert with cap enforcement
-- ============================================================================
--
-- The Node-side flow was:
--   1. SELECT count(*) FROM permit_attachments WHERE permit_id = $1
--   2. if count >= 10: reject
--   3. INSERT INTO permit_attachments ...
--
-- Two concurrent uploads both see count=9, both insert, end state = 11
-- attachments — the cap is silently bypassed. This RPC moves the count check
-- inside the same transaction as the insert, holding ROW SHARE locks via the
-- pl/pgsql block so a second caller observes the first caller's pending row.
--
-- Returns the inserted row's id (or raises ATTACHMENT_LIMIT_EXCEEDED). The
-- caller is expected to have already validated ownership + status='draft'.

DROP FUNCTION IF EXISTS insert_permit_attachment_capped(UUID, TEXT, BIGINT, TEXT, TEXT, UUID, INT);

CREATE OR REPLACE FUNCTION insert_permit_attachment_capped(
  p_permit_id UUID,
  p_file_name TEXT,
  p_file_size BIGINT,
  p_file_type TEXT,
  p_storage_path TEXT,
  p_uploaded_by UUID,
  p_max_files INT DEFAULT 10
)
RETURNS TABLE (
  id UUID,
  permit_id UUID,
  file_name TEXT,
  file_size BIGINT,
  file_type TEXT,
  storage_path TEXT,
  uploaded_by UUID,
  uploaded_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing_count INT;
BEGIN
  -- Lock the parent permit row so concurrent uploaders serialize on it.
  -- This is what makes the SELECT count below see committed-and-uncommitted
  -- inserts from the previous holder of the lock.
  PERFORM 1 FROM permit_applications WHERE permit_applications.id = p_permit_id FOR UPDATE;

  SELECT COUNT(*) INTO v_existing_count
  FROM permit_attachments
  WHERE permit_attachments.permit_id = p_permit_id;

  IF v_existing_count >= p_max_files THEN
    RAISE EXCEPTION 'ATTACHMENT_LIMIT_EXCEEDED' USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY
  INSERT INTO permit_attachments (
    permit_id, file_name, file_size, file_type, storage_path, uploaded_by
  )
  VALUES (
    p_permit_id, p_file_name, p_file_size, p_file_type, p_storage_path, p_uploaded_by
  )
  RETURNING
    permit_attachments.id,
    permit_attachments.permit_id,
    permit_attachments.file_name,
    permit_attachments.file_size,
    permit_attachments.file_type,
    permit_attachments.storage_path,
    permit_attachments.uploaded_by,
    permit_attachments.uploaded_at;
END;
$$;

GRANT EXECUTE ON FUNCTION insert_permit_attachment_capped(UUID, TEXT, BIGINT, TEXT, TEXT, UUID, INT) TO authenticated, service_role;


-- ---- 005_atomic_check_rate_limit.sql ----

-- ============================================================================
-- C10H — Atomic check_rate_limit
-- ============================================================================
--
-- The previous RPC did:
--   1. SELECT COUNT(*), MAX(request_timestamp) FROM rate_limits WHERE user=$1
--   2. compare against limits (in pl/pgsql)
--   3. INSERT a new row
--
-- Between steps 1 and 3 two concurrent callers can both observe
-- count < max_requests and both insert — the cap is bypassed.
--
-- Fix: take a per-user transaction-scoped advisory lock at the top of the
-- function. Two callers with the same user_id serialize through the lock
-- (cheap — int8 hash, no table involved). Different users are unaffected.
--
-- We also fold the cleanup-after-insert into the same transaction so it
-- can't leave stale rows behind on rollback.

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
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_window_start TIMESTAMPTZ;
  v_last_request TIMESTAMPTZ;
  v_request_count INT;
  v_ms_since_last INT;
BEGIN
  -- C10H: per-user advisory lock to serialize concurrent rate-limit checks.
  -- hashtextextended is deterministic per UUID; the lock auto-releases at
  -- transaction end. Different users hash to different ints → no contention.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  v_window_start := NOW() - (p_window_seconds || ' seconds')::INTERVAL;

  SELECT COUNT(*), MAX(request_timestamp)
  INTO v_request_count, v_last_request
  FROM rate_limits
  WHERE user_id = p_user_id AND request_timestamp > v_window_start;

  -- Check minimum interval
  IF v_last_request IS NOT NULL THEN
    v_ms_since_last := EXTRACT(EPOCH FROM (NOW() - v_last_request)) * 1000;
    IF v_ms_since_last < p_min_interval_ms THEN
      RETURN QUERY SELECT FALSE, (p_min_interval_ms - v_ms_since_last)::INT, v_request_count::INT;
      RETURN;
    END IF;
  END IF;

  -- Check max requests
  IF v_request_count >= p_max_requests THEN
    RETURN QUERY SELECT FALSE, (p_window_seconds * 1000)::INT, v_request_count::INT;
    RETURN;
  END IF;

  -- Allowed — record and cleanup. Both writes are now inside the locked
  -- region, so a concurrent caller can't observe the pre-insert count.
  INSERT INTO rate_limits (user_id, request_timestamp) VALUES (p_user_id, NOW());
  DELETE FROM rate_limits WHERE user_id = p_user_id AND request_timestamp < NOW() - INTERVAL '1 hour';

  RETURN QUERY SELECT TRUE, 0, (v_request_count + 1)::INT;
END;
$$;

GRANT EXECUTE ON FUNCTION check_rate_limit(UUID, INT, INT, INT) TO authenticated, service_role;


-- ---- 006_rate_limit_endpoint_buckets.sql ----

-- ============================================================================
-- C11H + C22H prep — per-endpoint rate-limit buckets
-- ============================================================================
--
-- The old check_rate_limit was keyed on user_id only, so chat streaming,
-- permit submission, certificate downloads, and admin mutations all shared
-- one bucket. A heavy endpoint (chat) starved everything else.
--
-- This migration:
--   1. Adds rate_limits.endpoint TEXT, defaulting to 'default' for existing rows.
--   2. Replaces the single (user_id, ts) index with (user_id, endpoint, ts).
--   3. Re-creates check_rate_limit with an optional p_endpoint param. The
--      window query is now WHERE user_id=$1 AND endpoint=$2. Per-user advisory
--      lock (C10H) becomes per-(user, endpoint) so concurrent endpoints don't
--      block each other.

ALTER TABLE rate_limits ADD COLUMN IF NOT EXISTS endpoint TEXT NOT NULL DEFAULT 'default';

DROP INDEX IF EXISTS rate_limits_user_time_idx;
CREATE INDEX IF NOT EXISTS rate_limits_user_endpoint_time_idx
  ON rate_limits(user_id, endpoint, request_timestamp DESC);

-- Drop and recreate so the parameter list changes cleanly. Postgres requires
-- a drop because adding a new parameter is treated as a new overload.
DROP FUNCTION IF EXISTS check_rate_limit(UUID, INT, INT, INT);
DROP FUNCTION IF EXISTS check_rate_limit(UUID, TEXT, INT, INT, INT);

CREATE OR REPLACE FUNCTION check_rate_limit(
  p_user_id UUID,
  p_endpoint TEXT DEFAULT 'default',
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
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_window_start TIMESTAMPTZ;
  v_last_request TIMESTAMPTZ;
  v_request_count INT;
  v_ms_since_last INT;
  v_endpoint TEXT;
BEGIN
  v_endpoint := COALESCE(p_endpoint, 'default');

  -- C10H: per-(user, endpoint) advisory lock, transaction-scoped.
  -- Two callers for the same user+endpoint serialize; different endpoints
  -- under the same user don't contend with each other.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_user_id::text, 0),
    hashtextextended(v_endpoint, 0)
  );

  v_window_start := NOW() - (p_window_seconds || ' seconds')::INTERVAL;

  SELECT COUNT(*), MAX(request_timestamp)
  INTO v_request_count, v_last_request
  FROM rate_limits
  WHERE user_id = p_user_id
    AND endpoint = v_endpoint
    AND request_timestamp > v_window_start;

  IF v_last_request IS NOT NULL THEN
    v_ms_since_last := EXTRACT(EPOCH FROM (NOW() - v_last_request)) * 1000;
    IF v_ms_since_last < p_min_interval_ms THEN
      RETURN QUERY SELECT FALSE, (p_min_interval_ms - v_ms_since_last)::INT, v_request_count::INT;
      RETURN;
    END IF;
  END IF;

  IF v_request_count >= p_max_requests THEN
    RETURN QUERY SELECT FALSE, (p_window_seconds * 1000)::INT, v_request_count::INT;
    RETURN;
  END IF;

  INSERT INTO rate_limits (user_id, endpoint, request_timestamp)
  VALUES (p_user_id, v_endpoint, NOW());

  DELETE FROM rate_limits
  WHERE user_id = p_user_id
    AND endpoint = v_endpoint
    AND request_timestamp < NOW() - INTERVAL '1 hour';

  RETURN QUERY SELECT TRUE, 0, (v_request_count + 1)::INT;
END;
$$;

GRANT EXECUTE ON FUNCTION check_rate_limit(UUID, TEXT, INT, INT, INT) TO authenticated, service_role;


-- ---- 007_token_version.sql ----

-- ============================================================================
-- C14H/M3 — token_version column for session invalidation on privilege change
-- ============================================================================
--
-- Adds users.token_version. Bumped by admin_update_user_role, admin_block_user
-- (so the bump can't be skipped by a forgetful TS caller), and TS-side
-- password change paths.
--
-- The JWT carries `tv` at issue time; middleware compares JWT.tv against
-- users.token_version on the existing block-status hop (no extra DB call).
-- Mismatch → session is treated as invalid and the user is logged out.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS token_version INT NOT NULL DEFAULT 0;

-- Helper for TS callers (password changes) so the increment is atomic and
-- can't be skipped by writing UPDATE ... SET password_hash=... and forgetting
-- the bump.
--
-- DB-H-7 / v1.0.0 Part A: in-body admin guard. service_role (the only legitimate
-- caller from app code) has auth.uid() = NULL → bypass. PostgREST-as-authenticated
-- callers must be admin OR be bumping their own row (self-logout). Without this,
-- any logged-in user could force-log-out any other user.
CREATE OR REPLACE FUNCTION bump_user_token_version(p_user_id UUID)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_new INT;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    IF NOT EXISTS (
      SELECT 1 FROM users
       WHERE id = auth.uid() AND role = 'admin' AND blocked = FALSE
    ) THEN
      RAISE EXCEPTION 'Unauthorized: admin role required' USING ERRCODE = '42501';
    END IF;
  END IF;

  UPDATE users
     SET token_version = COALESCE(token_version, 0) + 1
   WHERE id = p_user_id
   RETURNING token_version INTO v_new;
  RETURN COALESCE(v_new, 0);
END;
$$;

-- Re-create admin_update_user_role with token_version bump; keep BOOLEAN
-- return type and existing guards so callers don't need to change.
CREATE OR REPLACE FUNCTION admin_update_user_role(
  p_admin_id UUID,
  p_target_user_id UUID,
  p_new_role TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin_role TEXT;
  v_target_current_role TEXT;
  v_target_blocked BOOLEAN;
  v_unblocked_admin_count INT;
BEGIN
  IF p_new_role NOT IN ('admin', 'user') THEN RAISE EXCEPTION 'Invalid role'; END IF;
  SELECT role INTO v_admin_role FROM users WHERE id = p_admin_id;
  IF v_admin_role != 'admin' THEN RAISE EXCEPTION 'Unauthorized: Admin role required'; END IF;

  SELECT role, blocked INTO v_target_current_role, v_target_blocked
  FROM users WHERE id = p_target_user_id;

  IF v_target_current_role = 'admin' AND p_new_role = 'user' AND v_target_blocked = FALSE THEN
    SELECT count(*) INTO v_unblocked_admin_count
    FROM users
    WHERE role = 'admin' AND blocked = FALSE
    FOR UPDATE;
    IF v_unblocked_admin_count <= 1 THEN
      RAISE EXCEPTION 'Cannot demote the only remaining unblocked admin';
    END IF;
  END IF;

  UPDATE users
     SET role = p_new_role,
         token_version = COALESCE(token_version, 0) + 1
   WHERE id = p_target_user_id;
  RETURN TRUE;
END;
$$;

-- Re-create admin_block_user with token_version bump.
CREATE OR REPLACE FUNCTION admin_block_user(
  p_admin_id UUID,
  p_target_user_id UUID,
  p_blocked BOOLEAN,
  p_reason TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin_role TEXT;
  v_target_role TEXT;
  v_unblocked_admin_count INT;
BEGIN
  SELECT role INTO v_admin_role FROM users WHERE id = p_admin_id;
  IF v_admin_role != 'admin' THEN RAISE EXCEPTION 'Unauthorized: Admin role required'; END IF;
  IF p_admin_id = p_target_user_id THEN RAISE EXCEPTION 'Cannot block yourself'; END IF;

  IF p_blocked THEN
    SELECT role INTO v_target_role FROM users WHERE id = p_target_user_id;
    IF v_target_role = 'admin' THEN
      SELECT count(*) INTO v_unblocked_admin_count
      FROM users
      WHERE role = 'admin' AND blocked = FALSE
      FOR UPDATE;
      IF v_unblocked_admin_count <= 1 THEN
        RAISE EXCEPTION 'Cannot block the only remaining unblocked admin';
      END IF;
    END IF;
  END IF;

  UPDATE users SET
    blocked = p_blocked,
    blocked_reason = CASE WHEN p_blocked THEN p_reason ELSE NULL END,
    blocked_at = CASE WHEN p_blocked THEN NOW() ELSE NULL END,
    blocked_by = CASE WHEN p_blocked THEN p_admin_id ELSE NULL END,
    token_version = COALESCE(token_version, 0) + 1
  WHERE id = p_target_user_id;

  RETURN TRUE;
END;
$$;


-- ---- 008_code_attempts.sql ----

-- ============================================================================
-- C15H/M4 — DB-backed code-attempt counter
-- ============================================================================
--
-- The in-memory Map in lib/code-verification.ts didn't survive serverless
-- restarts or scale across instances, so an attacker could iterate codes by
-- triggering a new function instance per attempt. This table moves the
-- counter into Postgres.
--
-- key shape: 'verify:<email>' or 'reset:<email>' (already used by callers).
-- Free-form TEXT so callers don't need a new schema if we add more purposes.

CREATE TABLE IF NOT EXISTS code_attempts (
  key TEXT PRIMARY KEY,
  count INT NOT NULL DEFAULT 0,
  first_attempt TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS code_attempts_first_attempt_idx
  ON code_attempts(first_attempt);

GRANT SELECT, INSERT, UPDATE, DELETE ON code_attempts TO service_role;

-- Atomic increment + check. Returns the new count and whether the caller
-- should proceed (count <= p_max within the window). On a window rollover
-- (first_attempt older than window) the counter resets to 1.
CREATE OR REPLACE FUNCTION incr_code_attempt(
  p_key TEXT,
  p_window_seconds INT DEFAULT 900,
  p_max INT DEFAULT 5
)
RETURNS TABLE (
  allowed BOOLEAN,
  current_count INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := NOW();
  v_cutoff TIMESTAMPTZ;
  v_row RECORD;
  v_new_count INT;
BEGIN
  v_cutoff := v_now - (p_window_seconds || ' seconds')::INTERVAL;

  INSERT INTO code_attempts (key, count, first_attempt)
  VALUES (p_key, 1, v_now)
  ON CONFLICT (key) DO UPDATE
    SET count = CASE
                  WHEN code_attempts.first_attempt < v_cutoff THEN 1
                  ELSE code_attempts.count + 1
                END,
        first_attempt = CASE
                          WHEN code_attempts.first_attempt < v_cutoff THEN v_now
                          ELSE code_attempts.first_attempt
                        END
  RETURNING code_attempts.count INTO v_new_count;

  -- Opportunistic cleanup of unrelated stale rows on every write
  IF random() < 0.05 THEN
    DELETE FROM code_attempts WHERE first_attempt < v_now - INTERVAL '1 day';
  END IF;

  SELECT * INTO v_row FROM (SELECT TRUE AS dummy) AS d; -- noop, satisfies plpgsql
  RETURN QUERY SELECT (v_new_count <= p_max), v_new_count;
END;
$$;

GRANT EXECUTE ON FUNCTION incr_code_attempt(TEXT, INT, INT) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION clear_code_attempt(p_key TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  DELETE FROM code_attempts WHERE key = p_key;
END;
$$;

GRANT EXECUTE ON FUNCTION clear_code_attempt(TEXT) TO authenticated, service_role;


-- ---- 009_atomic_mutations.sql ----

-- ============================================================================
-- C17H/M6 — Single-RPC mutations for createPermit, reviewPermit, deleteDocument
-- ============================================================================
--
-- B7 already covered submit/revise. C17H wraps the remaining multi-write
-- actions in transactional RPCs so a crash between writes can't leave the
-- DB inconsistent (e.g. permit row inserted but no status_history audit, or
-- chunks deleted but document_registry row stuck pointing to them).
--
-- Notification side-effects stay in the app layer per B8 — a failed in-app
-- notification surfaces a non-blocking warning instead of rolling back the
-- DB state change.

-- ---------------------------------------------------------------------------
-- create_permit_atomic: insert the application + the initial status_history
-- row in one transaction.
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS create_permit_atomic(UUID, TEXT, TEXT, TEXT, TEXT, TEXT);

-- DB-H-6 / v1.0.0 Part A: in-body identity guard. service_role calls have
-- auth.uid() = NULL → bypass. PostgREST authenticated callers can only attribute
-- a permit to themselves (auth.uid() = p_user_id) unless they are admin.
CREATE OR REPLACE FUNCTION create_permit_atomic(
  p_user_id UUID,
  p_project_name TEXT,
  p_project_type TEXT,
  p_project_address TEXT,
  p_plot_number TEXT,
  p_project_description TEXT
)
RETURNS TABLE (permit_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id UUID;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    IF NOT EXISTS (
      SELECT 1 FROM users
       WHERE id = auth.uid() AND role = 'admin' AND blocked = FALSE
    ) THEN
      RAISE EXCEPTION 'Unauthorized: cannot create permit for another user' USING ERRCODE = '42501';
    END IF;
  END IF;

  INSERT INTO permit_applications (
    user_id, status, project_name, project_type, project_address,
    plot_number, project_description
  )
  VALUES (
    p_user_id, 'draft', p_project_name, p_project_type, p_project_address,
    p_plot_number, p_project_description
  )
  RETURNING id INTO v_id;

  INSERT INTO permit_status_history (permit_id, from_status, to_status, changed_by, comment)
  VALUES (v_id, NULL, 'draft', p_user_id, 'Permit application created');

  RETURN QUERY SELECT v_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- review_permit_atomic: status update + history insert in one transaction.
-- Notification stays in the app layer (see B8).
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS review_permit_atomic(UUID, UUID, TEXT, TEXT);

CREATE OR REPLACE FUNCTION review_permit_atomic(
  p_permit_id UUID,
  p_admin_id UUID,
  p_new_status TEXT,
  p_comments TEXT
)
RETURNS TABLE (
  status_changed BOOLEAN,
  prev_status TEXT,
  project_name TEXT,
  permit_user_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_prev_status TEXT;
  v_project_name TEXT;
  v_user_id UUID;
BEGIN
  IF p_new_status NOT IN ('approved', 'rejected', 'revision_requested') THEN
    RAISE EXCEPTION 'Invalid review status' USING ERRCODE = 'P0002';
  END IF;

  SELECT pa.status, pa.project_name, pa.user_id
    INTO v_prev_status, v_project_name, v_user_id
  FROM permit_applications pa
  WHERE pa.id = p_permit_id
  FOR UPDATE;

  IF v_prev_status IS NULL THEN
    RAISE EXCEPTION 'PERMIT_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF v_prev_status NOT IN ('submitted', 'under_review') THEN
    RETURN QUERY SELECT FALSE, v_prev_status, v_project_name, v_user_id;
    RETURN;
  END IF;

  UPDATE permit_applications
     SET status = p_new_status,
         reviewed_by = p_admin_id,
         reviewed_at = NOW(),
         review_comments = p_comments,
         revision_notes = CASE WHEN p_new_status = 'revision_requested' THEN p_comments ELSE revision_notes END,
         updated_at = NOW()
   WHERE id = p_permit_id;

  INSERT INTO permit_status_history (permit_id, from_status, to_status, changed_by, comment)
  VALUES (p_permit_id, v_prev_status, p_new_status, p_admin_id, p_comments);

  RETURN QUERY SELECT TRUE, v_prev_status, v_project_name, v_user_id;
END;
$$;

GRANT EXECUTE ON FUNCTION review_permit_atomic(UUID, UUID, TEXT, TEXT) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- delete_document_atomic: registry deactivate / hard-delete + cascade
-- cleanup of chunks, parent_chunks, document_trees in one transaction.
-- p_clear_chunks=false → soft delete (is_active=false, keep chunks).
-- p_clear_chunks=true → hard delete (registry row + all child data).
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS delete_document_atomic(TEXT, BOOLEAN);

-- DB-C-3 / v1.0.0 Part A: in-body admin guard. With p_clear_chunks=TRUE this
-- wipes every chunk and registry row for a document — catastrophic if any
-- logged-in user could call it via PostgREST. service_role bypass:
-- auth.uid() = NULL.
CREATE OR REPLACE FUNCTION delete_document_atomic(
  p_document_id TEXT,
  p_clear_chunks BOOLEAN DEFAULT FALSE
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM users
       WHERE id = auth.uid() AND role = 'admin' AND blocked = FALSE
    ) THEN
      RAISE EXCEPTION 'Unauthorized: admin role required' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF p_clear_chunks THEN
    DELETE FROM dubai_code_chunks WHERE document_name = p_document_id;
    DELETE FROM parent_chunks WHERE document_name = p_document_id;
    DELETE FROM document_trees WHERE document_name = p_document_id;
    DELETE FROM document_registry WHERE id = p_document_id;
  ELSE
    UPDATE document_registry
       SET is_active = FALSE, updated_at = NOW()
     WHERE id = p_document_id;
  END IF;
END;
$$;


-- ---- 010_drop_max_requests_param.sql ----

-- ============================================================================
-- C22H/M20 — Move per-endpoint rate-limit thresholds into the RPC body
-- ============================================================================
--
-- Previously each call site could pass its own p_window_seconds /
-- p_max_requests / p_min_interval_ms, which meant a careless client could
-- effectively disable the cap (e.g. p_max_requests=99999). Per-endpoint
-- limits now live in a CASE inside the function — callers can only pick the
-- endpoint label.
--
-- p_endpoint is still required (defaults to 'default'). For backwards compat
-- the old window/max/interval parameters remain in the signature but are
-- accepted only when endpoint='default'; for any named endpoint they are
-- ignored and the hardcoded values win.

DROP FUNCTION IF EXISTS check_rate_limit(UUID, TEXT, INT, INT, INT);

CREATE OR REPLACE FUNCTION check_rate_limit(
  p_user_id UUID,
  p_endpoint TEXT DEFAULT 'default',
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
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_window_start TIMESTAMPTZ;
  v_last_request TIMESTAMPTZ;
  v_request_count INT;
  v_ms_since_last INT;
  v_endpoint TEXT;
  v_window_seconds INT;
  v_max_requests INT;
  v_min_interval_ms INT;
BEGIN
  v_endpoint := COALESCE(p_endpoint, 'default');

  -- Per-endpoint limits. Anything not listed falls back to the default bucket
  -- (10 req / 60s, 2s minimum interval). To add a new endpoint, add a WHEN
  -- branch here; callers don't get to pick their own cap anymore.
  CASE v_endpoint
    WHEN 'chat'                                 THEN v_window_seconds := 60;   v_max_requests := 20; v_min_interval_ms := 1500;
    WHEN 'permit_certificate'                   THEN v_window_seconds := 60;   v_max_requests := 5;  v_min_interval_ms := 1000;
    WHEN 'pdf_ingest'                           THEN v_window_seconds := 300;  v_max_requests := 3;  v_min_interval_ms := 5000;
    WHEN 'createPermit'                         THEN v_window_seconds := 60;   v_max_requests := 10; v_min_interval_ms := 1000;
    WHEN 'updatePermitBuildingDetails'          THEN v_window_seconds := 60;   v_max_requests := 30; v_min_interval_ms := 500;
    WHEN 'updatePermitComplianceRequirements'   THEN v_window_seconds := 60;   v_max_requests := 30; v_min_interval_ms := 500;
    WHEN 'runComplianceCheck'                   THEN v_window_seconds := 300;  v_max_requests := 5;  v_min_interval_ms := 10000;
    WHEN 'reviewPermit'                         THEN v_window_seconds := 60;   v_max_requests := 30; v_min_interval_ms := 500;
    WHEN 'setPermitUnderReview'                 THEN v_window_seconds := 60;   v_max_requests := 30; v_min_interval_ms := 500;
    WHEN 'blockUser'                            THEN v_window_seconds := 60;   v_max_requests := 20; v_min_interval_ms := 500;
    WHEN 'updateUserRole'                       THEN v_window_seconds := 60;   v_max_requests := 20; v_min_interval_ms := 500;
    WHEN 'adminCreateUser'                      THEN v_window_seconds := 60;   v_max_requests := 10; v_min_interval_ms := 1000;
    WHEN 'adminDeleteUser'                      THEN v_window_seconds := 60;   v_max_requests := 10; v_min_interval_ms := 1000;
    WHEN 'adminResetPassword'                   THEN v_window_seconds := 60;   v_max_requests := 10; v_min_interval_ms := 1000;
    WHEN 'default'                              THEN v_window_seconds := COALESCE(p_window_seconds, 60);
                                                      v_max_requests := COALESCE(p_max_requests, 10);
                                                      v_min_interval_ms := COALESCE(p_min_interval_ms, 2000);
    ELSE                                              v_window_seconds := 60;  v_max_requests := 10; v_min_interval_ms := 2000;
  END CASE;

  -- C10H + C11H: per-(user, endpoint) advisory lock, transaction-scoped.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_user_id::text, 0),
    hashtextextended(v_endpoint, 0)
  );

  v_window_start := NOW() - (v_window_seconds || ' seconds')::INTERVAL;

  SELECT COUNT(*), MAX(request_timestamp)
  INTO v_request_count, v_last_request
  FROM rate_limits
  WHERE user_id = p_user_id
    AND endpoint = v_endpoint
    AND request_timestamp > v_window_start;

  IF v_last_request IS NOT NULL THEN
    v_ms_since_last := EXTRACT(EPOCH FROM (NOW() - v_last_request)) * 1000;
    IF v_ms_since_last < v_min_interval_ms THEN
      RETURN QUERY SELECT FALSE, (v_min_interval_ms - v_ms_since_last)::INT, v_request_count::INT;
      RETURN;
    END IF;
  END IF;

  IF v_request_count >= v_max_requests THEN
    RETURN QUERY SELECT FALSE, (v_window_seconds * 1000)::INT, v_request_count::INT;
    RETURN;
  END IF;

  INSERT INTO rate_limits (user_id, endpoint, request_timestamp)
  VALUES (p_user_id, v_endpoint, NOW());

  DELETE FROM rate_limits
  WHERE user_id = p_user_id
    AND endpoint = v_endpoint
    AND request_timestamp < NOW() - INTERVAL '1 hour';

  RETURN QUERY SELECT TRUE, 0, (v_request_count + 1)::INT;
END;
$$;

GRANT EXECUTE ON FUNCTION check_rate_limit(UUID, TEXT, INT, INT, INT) TO authenticated, service_role;


-- ---- 011_get_all_users_admin_join.sql ----

-- ============================================================================
-- D1/H14 — Replace correlated subqueries in get_all_users_admin with a
-- single JOIN aggregation.
-- ============================================================================
--
-- The original implementation ran two correlated subqueries per user row:
--
--   (SELECT COUNT(*) FROM chat_sessions WHERE user_id = u.id)
--   (SELECT COUNT(*) FROM chat_messages cm
--      JOIN chat_sessions cs ON cm.session_id = cs.id
--      WHERE cs.user_id = u.id)
--
-- That fanned out to N * 2 subqueries (where N = page size, up to 100). On a
-- realistic dataset with 100+ users this was O(N) seq-scans of chat_messages.
--
-- Rewrite: pre-aggregate session counts and message counts per user with two
-- LEFT JOIN LATERAL grouped subqueries, then join those once. Each aggregate
-- subquery runs once total, not once per row.
--
-- Contract is unchanged (same parameters, same returned columns).

DROP FUNCTION IF EXISTS get_all_users_admin(UUID, INT, INT, TEXT);

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
SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin_role TEXT;
BEGIN
  SELECT users.role INTO v_admin_role FROM users WHERE users.id = p_admin_id;
  IF v_admin_role != 'admin' THEN RAISE EXCEPTION 'Unauthorized: Admin role required'; END IF;

  RETURN QUERY
  WITH session_stats AS (
    SELECT cs.user_id,
           COUNT(*)::BIGINT AS session_count,
           COUNT(cm.id)::BIGINT AS message_count
    FROM chat_sessions cs
    LEFT JOIN chat_messages cm ON cm.session_id = cs.id
    GROUP BY cs.user_id
  )
  SELECT
    u.id, u.username, u.full_name, u.role, u.blocked, u.blocked_reason,
    u.created_at, u.last_login,
    COALESCE(s.session_count, 0)::BIGINT AS session_count,
    COALESCE(s.message_count, 0)::BIGINT AS message_count
  FROM users u
  LEFT JOIN session_stats s ON s.user_id = u.id
  WHERE (p_search IS NULL OR u.username ILIKE '%' || p_search || '%' OR u.full_name ILIKE '%' || p_search || '%')
  ORDER BY u.created_at DESC
  LIMIT LEAST(p_limit, 100) OFFSET p_offset;
END;
$$;

GRANT EXECUTE ON FUNCTION get_all_users_admin(UUID, INT, INT, TEXT) TO service_role;
REVOKE EXECUTE ON FUNCTION get_all_users_admin(UUID, INT, INT, TEXT) FROM anon, authenticated;


-- ---- 012_message_activity_from_mv.sql ----

-- ============================================================================
-- D2/H15+H16 — Wire admin dashboard to read from analytics_daily MV
-- ============================================================================
--
-- The materialized view analytics_daily already pre-aggregates message
-- activity per day. Reading the dashboard from it (instead of recomputing
-- from chat_messages JOIN chat_sessions on every load) cuts query time
-- proportionally to data volume.
--
-- The MV is stale until refreshed, so today's bucket is computed live and
-- merged onto the MV's historic rows. The admin "Refresh" button calls
-- refresh_analytics() to update the MV.
--
-- Contract is unchanged: same return columns, same 30-day window with no
-- date gaps.

CREATE OR REPLACE FUNCTION get_message_activity_30d()
RETURNS TABLE (
  day DATE,
  user_count BIGINT,
  assistant_count BIGINT,
  total_count BIGINT,
  active_users BIGINT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH date_series AS (
    SELECT generate_series(
      (current_date - interval '29 days')::date,
      current_date,
      '1 day'::interval
    )::date AS day
  ),
  -- Historic days come from the MV. Cap at yesterday because today's row
  -- in the MV is stale until refresh_analytics() runs.
  historic AS (
    SELECT
      ad.date AS day,
      ad.user_messages AS user_count,
      ad.assistant_messages AS assistant_count,
      ad.total_messages AS total_count,
      ad.active_users
    FROM analytics_daily ad
    WHERE ad.date >= current_date - interval '29 days'
      AND ad.date < current_date
  ),
  -- Today is always computed live so the dashboard reflects in-progress
  -- activity without requiring a refresh after every message.
  today_live AS (
    SELECT
      current_date::date AS day,
      count(*) FILTER (WHERE cm.role = 'user') AS user_count,
      count(*) FILTER (WHERE cm.role = 'assistant') AS assistant_count,
      count(*) AS total_count,
      count(DISTINCT cs.user_id) AS active_users
    FROM chat_messages cm
    JOIN chat_sessions cs ON cs.id = cm.session_id
    WHERE cm.created_at >= current_date
  ),
  merged AS (
    SELECT * FROM historic
    UNION ALL
    SELECT * FROM today_live WHERE total_count > 0
  )
  SELECT
    ds.day,
    COALESCE(m.user_count, 0),
    COALESCE(m.assistant_count, 0),
    COALESCE(m.total_count, 0),
    COALESCE(m.active_users, 0)
  FROM date_series ds
  LEFT JOIN merged m ON m.day = ds.day
  ORDER BY ds.day;
$$;

GRANT EXECUTE ON FUNCTION get_message_activity_30d() TO service_role;
REVOKE EXECUTE ON FUNCTION get_message_activity_30d() FROM anon, authenticated;


-- ---- 013_content_trgm_index.sql ----

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


-- ---- 014_section_text_pattern_index.sql ----

-- ============================================================================
-- D8/M15 — Functional index supporting find_chunks_by_section's LIKE patterns
-- ============================================================================
--
-- find_chunks_by_section runs three predicates on (metadata->>'section'):
--
--   1) d.metadata->>'section' = section_number
--   2) d.metadata->>'section' LIKE section_number || '.%'         (child)
--   3) section_number LIKE (d.metadata->>'section') || '.%'       (parent)
--
-- The existing idx_chunks_section is a default-collation b-tree over
-- (metadata->>'section'); it handles equality (1) but not the LIKE-with-
-- right-wildcard patterns (2) and (3) under non-C collations. A
-- text_pattern_ops index supports left-anchored LIKE regardless of
-- locale, so the planner can pick it for `'1.2.%'`-style predicates.
--
-- We keep the existing idx_chunks_section index for equality lookups
-- (cheaper than gin) and add a parallel text_pattern_ops one specifically
-- for the prefix LIKE branch.

CREATE INDEX IF NOT EXISTS idx_chunks_section_pattern
  ON dubai_code_chunks ((metadata->>'section') text_pattern_ops);


-- ---- 015_code_columns_char6.sql ----

-- ============================================================================
-- D9/M17 — Tighten users.verification_code / reset_code to CHAR(6)
-- ============================================================================
--
-- Both columns are only ever written via generateSixDigitCode() in
-- lib/email.ts, which produces exactly 6 numeric characters. The
-- columns were TEXT, which accepted arbitrarily long values (e.g. via
-- a future code path that forgot to validate). CHAR(6) enforces the
-- length at the type level.
--
-- Existing values are 6 chars by construction, so no truncation is
-- needed in practice. The LEFT(_, 6) below is defensive: if any stale
-- row has a longer value it'll be trimmed; NULLs are preserved.
--
-- CHAR(6) values are returned without padding when the stored value
-- already fills the column (always the case here), so safeEqual() in
-- the verification flow continues to work without changes.

UPDATE users
   SET verification_code = LEFT(verification_code, 6)
 WHERE verification_code IS NOT NULL
   AND LENGTH(verification_code) <> 6;

UPDATE users
   SET reset_code = LEFT(reset_code, 6)
 WHERE reset_code IS NOT NULL
   AND LENGTH(reset_code) <> 6;

ALTER TABLE users
  ALTER COLUMN verification_code TYPE CHAR(6) USING verification_code::CHAR(6),
  ALTER COLUMN reset_code        TYPE CHAR(6) USING reset_code::CHAR(6);


-- ---- 016_audit_logs_bounded.sql ----

-- ============================================================================
-- D10/M18 — Bound audit_logs.ip_address (45) and user_agent (512)
-- ============================================================================
--
-- ip_address is at most 45 chars (IPv6 with embedded IPv4, e.g.
--   "0000:0000:0000:0000:0000:ffff:255.255.255.255" = 45 chars).
-- user_agent strings rarely exceed 256 chars; 512 leaves headroom for
-- unusual browsers without inviting log-bloat attacks (we already trim
-- on the app side, but the DB constraint is defense in depth).
--
-- Existing rows are truncated defensively before the type change so
-- the ALTER TYPE cast can't fail.

UPDATE audit_logs
   SET ip_address = LEFT(ip_address, 45)
 WHERE ip_address IS NOT NULL
   AND LENGTH(ip_address) > 45;

UPDATE audit_logs
   SET user_agent = LEFT(user_agent, 512)
 WHERE user_agent IS NOT NULL
   AND LENGTH(user_agent) > 512;

ALTER TABLE audit_logs
  ALTER COLUMN ip_address TYPE VARCHAR(45)  USING ip_address::VARCHAR(45),
  ALTER COLUMN user_agent TYPE VARCHAR(512) USING user_agent::VARCHAR(512);


-- ---- 017_document_registry_bounded.sql ----

-- ============================================================================
-- D11/M19 — Bound document_registry.id / display_name / badge_color
-- ============================================================================
--
-- - id is sanitized to lowercase alphanumeric + hyphens in the app
--   layer (actions/documents.ts). It's used as a storage path segment
--   (documents/{id}/file.pdf) and an FK target (D18); 64 chars is well
--   inside any filesystem / btree limit and matches the worst case
--   a user is likely to type.
-- - display_name shows in headers and select dropdowns; 128 chars is
--   generous (typical: ~30 chars).
-- - badge_color stores a Tailwind class string (~50 chars in practice);
--   128 is plenty of headroom for future variants.
--
-- The defensive UPDATEs below truncate any pre-existing oversize row so
-- the ALTER TYPE casts can't fail.

UPDATE document_registry
   SET id = LEFT(id, 64)
 WHERE LENGTH(id) > 64;

UPDATE document_registry
   SET display_name = LEFT(display_name, 128)
 WHERE LENGTH(display_name) > 128;

UPDATE document_registry
   SET badge_color = LEFT(badge_color, 128)
 WHERE badge_color IS NOT NULL
   AND LENGTH(badge_color) > 128;

ALTER TABLE document_registry
  ALTER COLUMN id           TYPE VARCHAR(64)  USING id::VARCHAR(64),
  ALTER COLUMN display_name TYPE VARCHAR(128) USING display_name::VARCHAR(128),
  ALTER COLUMN badge_color  TYPE VARCHAR(128) USING badge_color::VARCHAR(128);


-- ---- 018_get_all_users_admin_keyset.sql ----

-- ============================================================================
-- D12/M21 — Keyset pagination on get_all_users_admin
-- ============================================================================
--
-- OFFSET pagination on a large users table is O(offset) — the planner has
-- to skip N rows before returning a page. Keyset pagination on
-- (created_at DESC, id DESC) is O(log N) per page and survives row
-- inserts during pagination without skipping or repeating rows.
--
-- New params: p_after_created_at and p_after_id form the cursor. The
-- caller passes the last row of the previous page; the function returns
-- the next page strictly after that cursor.
--
-- Backward compat: p_offset is still accepted and honored when the
-- cursor params are NULL. Existing callers (admin page passes offset=0)
-- behave identically. New keyset callers pass NULL for offset and
-- supply the cursor pair.

DROP FUNCTION IF EXISTS get_all_users_admin(UUID, INT, INT, TEXT);

CREATE OR REPLACE FUNCTION get_all_users_admin(
  p_admin_id UUID,
  p_limit INT DEFAULT 50,
  p_offset INT DEFAULT 0,
  p_search TEXT DEFAULT NULL,
  p_after_created_at TIMESTAMPTZ DEFAULT NULL,
  p_after_id UUID DEFAULT NULL
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
SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin_role TEXT;
  v_use_keyset BOOLEAN := (p_after_created_at IS NOT NULL AND p_after_id IS NOT NULL);
BEGIN
  SELECT users.role INTO v_admin_role FROM users WHERE users.id = p_admin_id;
  IF v_admin_role != 'admin' THEN RAISE EXCEPTION 'Unauthorized: Admin role required'; END IF;

  RETURN QUERY
  WITH session_stats AS (
    SELECT cs.user_id,
           COUNT(*)::BIGINT AS session_count,
           COUNT(cm.id)::BIGINT AS message_count
    FROM chat_sessions cs
    LEFT JOIN chat_messages cm ON cm.session_id = cs.id
    GROUP BY cs.user_id
  )
  SELECT
    u.id, u.username, u.full_name, u.role, u.blocked, u.blocked_reason,
    u.created_at, u.last_login,
    COALESCE(s.session_count, 0)::BIGINT AS session_count,
    COALESCE(s.message_count, 0)::BIGINT AS message_count
  FROM users u
  LEFT JOIN session_stats s ON s.user_id = u.id
  WHERE (p_search IS NULL OR u.username ILIKE '%' || p_search || '%' OR u.full_name ILIKE '%' || p_search || '%')
    -- Keyset: take rows strictly *after* the cursor in (created_at DESC, id DESC) order.
    AND (NOT v_use_keyset OR (u.created_at, u.id) < (p_after_created_at, p_after_id))
  ORDER BY u.created_at DESC, u.id DESC
  LIMIT LEAST(p_limit, 100)
  OFFSET CASE WHEN v_use_keyset THEN 0 ELSE GREATEST(p_offset, 0) END;
END;
$$;

GRANT EXECUTE ON FUNCTION get_all_users_admin(UUID, INT, INT, TEXT, TIMESTAMPTZ, UUID) TO service_role;
REVOKE EXECUTE ON FUNCTION get_all_users_admin(UUID, INT, INT, TEXT, TIMESTAMPTZ, UUID) FROM anon, authenticated;


-- ---- 019_chunks_document_name_fk.sql ----

-- ============================================================================
-- D18/P2-A8 — Real FK from dubai_code_chunks.document_name → document_registry.id
-- ============================================================================
--
-- The two tables were related by convention only — nothing in the schema
-- stopped an ingestion path from inserting chunks for a document_name
-- that didn't exist in the registry (or vice versa, an admin from
-- hard-deleting a registry row while chunks still pointed at it).
--
-- Steps:
--   1. Defensive cleanup — auto-create inactive registry stubs for any
--      orphan document_name found in dubai_code_chunks. This avoids
--      losing chunks but flags the row as inactive so the document
--      selector / dashboard ignore it until an admin fills in metadata.
--   2. ALTER COLUMN to match document_registry.id's VARCHAR(64) so the
--      FK type lines up (chunks.document_name was TEXT before).
--   3. Add FK with ON DELETE CASCADE. delete_document_atomic already
--      deletes child chunks before the registry row in the hard-delete
--      path; CASCADE is belt-and-braces for any future deletion path.

-- 1. Backfill orphan stubs.
INSERT INTO document_registry (id, display_name, short_name, file_name, is_active)
SELECT DISTINCT
       LEFT(c.document_name, 64),
       LEFT(c.document_name, 128),
       LEFT(c.document_name, 64),
       'unknown.pdf',
       FALSE
  FROM dubai_code_chunks c
 WHERE c.document_name IS NOT NULL
   AND c.document_name <> ''
   AND NOT EXISTS (
     SELECT 1 FROM document_registry r WHERE r.id = LEFT(c.document_name, 64)
   )
ON CONFLICT (id) DO NOTHING;

-- 1b. If any chunks still have an empty document_name, route them to the
-- 'unknown' stub. Create the stub if it doesn't exist.
INSERT INTO document_registry (id, display_name, short_name, file_name, is_active)
VALUES ('unknown', 'Unknown (orphan chunks)', 'UNK', 'unknown.pdf', FALSE)
ON CONFLICT (id) DO NOTHING;

UPDATE dubai_code_chunks
   SET document_name = 'unknown'
 WHERE document_name IS NULL OR document_name = '';

-- 1c. Truncate any document_name longer than 64 to match registry.id.
UPDATE dubai_code_chunks
   SET document_name = LEFT(document_name, 64)
 WHERE LENGTH(document_name) > 64;

-- 2. Bring the column type in line with document_registry.id.
ALTER TABLE dubai_code_chunks
  ALTER COLUMN document_name TYPE VARCHAR(64)
    USING document_name::VARCHAR(64);

-- 3. The FK itself.
ALTER TABLE dubai_code_chunks
  DROP CONSTRAINT IF EXISTS dubai_code_chunks_document_name_fkey;

ALTER TABLE dubai_code_chunks
  ADD CONSTRAINT dubai_code_chunks_document_name_fkey
  FOREIGN KEY (document_name) REFERENCES document_registry(id) ON DELETE CASCADE;


-- ---- 020_try_start_ingestion.sql ----

-- ============================================================================
-- D19/P2-A9 — Advisory-lock-guarded ingestion start
-- ============================================================================
--
-- Two parallel /api/ingest calls for the same document_id could both
-- pass the prior "is ingestion in progress?" check (or do no check at
-- all) and both insert chunks, producing duplicates. Supabase uses a
-- connection pool so we can't safely hold a session-level advisory
-- lock for the whole ingestion run.
--
-- Instead: this RPC takes a per-document pg_advisory_xact_lock (held
-- only for the duration of *this* transaction, then released),
-- atomically reads ingestion_state inside that lock, and either:
--   - returns FALSE if a run is already 'pending' (caller should bail)
--   - sets ingestion_state='pending' and returns TRUE (caller proceeds)
--
-- The lock serializes the read+write so two concurrent claims can't
-- both see "no pending run" and both proceed. The ingestion_state flag
-- carries the "in progress" signal forward across the rest of the run.
--
-- Callers MUST eventually flip ingestion_state out of 'pending' (either
-- to 'completed', 'failed', or 'aborted') — the existing
-- markIngestionState() helper in app/api/ingest/route.ts already does
-- this in the success/error/finally branches.

DROP FUNCTION IF EXISTS try_start_ingestion(TEXT);

CREATE OR REPLACE FUNCTION try_start_ingestion(p_document_id TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_current_state TEXT;
BEGIN
  -- Per-document advisory lock, transaction-scoped. Two concurrent
  -- callers for the same id will serialize here; for different ids the
  -- locks are independent so ingestion of doc-A doesn't block doc-B.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_document_id, 0));

  SELECT ingestion_state INTO v_current_state
    FROM document_registry
   WHERE id = p_document_id
   FOR UPDATE;

  -- A row that doesn't exist yet shouldn't be ingestable — the admin
  -- must register the document first. Refuse rather than auto-create.
  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  IF v_current_state = 'pending' THEN
    RETURN FALSE;
  END IF;

  UPDATE document_registry
     SET ingestion_state = 'pending',
         ingestion_started_at = NOW(),
         ingestion_finished_at = NULL,
         updated_at = NOW()
   WHERE id = p_document_id;

  RETURN TRUE;
END;
$$;

GRANT EXECUTE ON FUNCTION try_start_ingestion(TEXT) TO service_role;
REVOKE EXECUTE ON FUNCTION try_start_ingestion(TEXT) FROM anon, authenticated;


-- ---- 021_hybrid_filtered_no_cte.sql ----

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


-- ---- 022_permit_certificates_bucket.sql ----

-- ============================================================================
-- X4 / M8 (clickpath): cache permit-certificate PDFs in Supabase Storage
-- ============================================================================
-- Adds a `permit-certificates` bucket so the certificate route can serve a
-- cached PDF instead of regenerating it on every download. The bucket is
-- private; access goes through the API route which already checks ownership
-- + rate limits. permit_certificates.storage_path was already in the schema
-- (000_full_setup.sql) but was never populated — this migration is purely
-- the storage-bucket + RLS setup.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'permit-certificates',
  'permit-certificates',
  FALSE,
  10485760, -- 10 MB ceiling per cert (PDFKit output is ~50–200KB; cap is defensive)
  ARRAY['application/pdf']
)
ON CONFLICT (id) DO NOTHING;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'objects' AND policyname = 'Service role full access to permit-certificates'
  ) THEN
    CREATE POLICY "Service role full access to permit-certificates"
      ON storage.objects FOR ALL TO service_role
      USING (bucket_id = 'permit-certificates')
      WITH CHECK (bucket_id = 'permit-certificates');
  END IF;
END $$;


-- ---- 023_permit_applications_version.sql ----

-- ============================================================================
-- X17 / P2-A5: optimistic-locking version column on permit_applications
-- ============================================================================
-- Two tabs editing the same permit used to race: whichever tab saved last
-- silently overwrote the other's edits because every UPDATE only matched on
-- `id`. This adds a `version INT NOT NULL DEFAULT 0` column. The application
-- layer:
--   * reads `version` along with the permit on load
--   * sends it back on every UPDATE
--   * the UPDATE adds `WHERE version = :expected_version` and bumps `version`
--   * 0 rows affected → "permit changed externally, reload"
--
-- Existing rows seed at 0 so already-open editors don't get a phantom mismatch
-- on first save (their cached version 0 will match the seeded 0).

ALTER TABLE permit_applications
  ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 0;

-- The status-transition RPCs (submit_permit_atomic / revise_permit_atomic /
-- review_permit_atomic) already use their own atomic guard against
-- concurrent status changes. To keep them coherent with the version column,
-- have them bump `version` whenever they UPDATE the row so the application
-- layer's cached version on the editor's tab is invalidated.
--
-- DROP first because return-table shape changes between earlier migrations
-- (003/009) and this one — CREATE OR REPLACE can't change OUT/return type.

DROP FUNCTION IF EXISTS submit_permit_atomic(UUID, UUID);
DROP FUNCTION IF EXISTS revise_permit_atomic(UUID, UUID);
DROP FUNCTION IF EXISTS review_permit_atomic(UUID, UUID, TEXT, TEXT);

CREATE OR REPLACE FUNCTION submit_permit_atomic(
  p_permit_id UUID,
  p_user_id UUID
) RETURNS TABLE(status_changed BOOLEAN, project_name TEXT, prev_status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_prev_status TEXT;
  v_project_name TEXT;
BEGIN
  SELECT pa.status, pa.project_name
    INTO v_prev_status, v_project_name
  FROM permit_applications pa
  WHERE pa.id = p_permit_id AND pa.user_id = p_user_id
  FOR UPDATE;

  IF v_prev_status IS NULL THEN
    RAISE EXCEPTION 'PERMIT_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF v_prev_status NOT IN ('draft', 'revision_requested') THEN
    RETURN QUERY SELECT FALSE, v_project_name, v_prev_status;
    RETURN;
  END IF;

  UPDATE permit_applications
     SET status = 'submitted',
         submitted_at = NOW(),
         updated_at = NOW(),
         version = version + 1
   WHERE id = p_permit_id;

  INSERT INTO permit_status_history (permit_id, from_status, to_status, changed_by, comment)
  VALUES (p_permit_id, v_prev_status, 'submitted', p_user_id, NULL);

  RETURN QUERY SELECT TRUE, v_project_name, v_prev_status;
END;
$$;

CREATE OR REPLACE FUNCTION revise_permit_atomic(
  p_permit_id UUID,
  p_user_id UUID
) RETURNS TABLE(status_changed BOOLEAN, prev_status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_prev_status TEXT;
BEGIN
  SELECT pa.status
    INTO v_prev_status
  FROM permit_applications pa
  WHERE pa.id = p_permit_id AND pa.user_id = p_user_id
  FOR UPDATE;

  IF v_prev_status IS NULL THEN
    RAISE EXCEPTION 'PERMIT_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF v_prev_status NOT IN ('rejected', 'revision_requested') THEN
    RETURN QUERY SELECT FALSE, v_prev_status;
    RETURN;
  END IF;

  UPDATE permit_applications
     SET status = 'draft',
         updated_at = NOW(),
         version = version + 1
   WHERE id = p_permit_id;

  INSERT INTO permit_status_history (permit_id, from_status, to_status, changed_by, comment)
  VALUES (p_permit_id, v_prev_status, 'draft', p_user_id, NULL);

  RETURN QUERY SELECT TRUE, v_prev_status;
END;
$$;

CREATE OR REPLACE FUNCTION review_permit_atomic(
  p_permit_id UUID,
  p_admin_id UUID,
  p_new_status TEXT,
  p_comments TEXT
) RETURNS TABLE(status_changed BOOLEAN, project_name TEXT, permit_user_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_prev_status TEXT;
  v_project_name TEXT;
  v_user_id UUID;
BEGIN
  -- DB-C-2 / v1.0.0 Part A: defense-in-depth admin guard. service_role calls
  -- (the only legitimate caller) have auth.uid() = NULL → bypass. A direct
  -- PostgREST hit as authenticated must come from a non-blocked admin AND the
  -- p_admin_id parameter must match auth.uid() so attribution can't be forged.
  IF auth.uid() IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM users
       WHERE id = auth.uid() AND role = 'admin' AND blocked = FALSE
    ) THEN
      RAISE EXCEPTION 'Unauthorized: admin role required' USING ERRCODE = '42501';
    END IF;
    IF auth.uid() <> p_admin_id THEN
      RAISE EXCEPTION 'Unauthorized: p_admin_id must match caller' USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT pa.status, pa.project_name, pa.user_id
    INTO v_prev_status, v_project_name, v_user_id
  FROM permit_applications pa
  WHERE pa.id = p_permit_id
  FOR UPDATE;

  IF v_prev_status IS NULL THEN
    RAISE EXCEPTION 'PERMIT_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF v_prev_status NOT IN ('submitted', 'under_review') THEN
    RETURN QUERY SELECT FALSE, v_project_name, v_user_id;
    RETURN;
  END IF;

  UPDATE permit_applications
     SET status = p_new_status,
         reviewed_by = p_admin_id,
         reviewed_at = NOW(),
         review_comments = p_comments,
         updated_at = NOW(),
         version = version + 1
   WHERE id = p_permit_id;

  INSERT INTO permit_status_history (permit_id, from_status, to_status, changed_by, comment)
  VALUES (p_permit_id, v_prev_status, p_new_status, p_admin_id, p_comments);

  RETURN QUERY SELECT TRUE, v_project_name, v_user_id;
END;
$$;

GRANT EXECUTE ON FUNCTION submit_permit_atomic(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION revise_permit_atomic(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION review_permit_atomic(UUID, UUID, TEXT, TEXT) TO service_role;


-- ============================================================================
-- v1.0.0 "Auth Lockdown" (audit 2026-05-21)
-- ============================================================================
-- Closes DB-C-1 (RLS on code_attempts), DB-C-4 (REVOKE atomic RPCs from
-- authenticated), DB-C-5 (semantic_cache SELECT lockdown), DB-H-6/7/8 (in-body
-- guards above are belt; these REVOKEs are suspenders).
--
-- RPC ACL policy for this migration (apply per function below):
--   - anon         : only the public search/document-registry read RPCs
--   - authenticated: nothing in this block — every atomic mutation goes
--                    through service_role from a Next.js server action
--   - service_role : every block-listed function (used by createAdminClient)
-- ============================================================================

-- --------------------------------------------------------------------------
-- DB-C-4 / DB-H-6/7/8: REVOKE the atomic RPCs from authenticated. Body
-- guards above are defense in depth — these REVOKEs are the primary fix.
-- DROP FUNCTION earlier in this migration also removed grants but recreating
-- with `CREATE OR REPLACE FUNCTION` does NOT drop prior grants, so we issue
-- the REVOKEs explicitly here for any function that wasn't dropped.
-- --------------------------------------------------------------------------

REVOKE EXECUTE ON FUNCTION submit_permit_atomic(UUID, UUID) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION revise_permit_atomic(UUID, UUID) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION review_permit_atomic(UUID, UUID, TEXT, TEXT) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION create_permit_atomic(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION delete_document_atomic(TEXT, BOOLEAN) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION bump_user_token_version(UUID) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION incr_code_attempt(TEXT, INT, INT) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION clear_code_attempt(TEXT) FROM anon, authenticated, PUBLIC;

GRANT EXECUTE ON FUNCTION create_permit_atomic(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION delete_document_atomic(TEXT, BOOLEAN) TO service_role;
GRANT EXECUTE ON FUNCTION bump_user_token_version(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION incr_code_attempt(TEXT, INT, INT) TO service_role;
GRANT EXECUTE ON FUNCTION clear_code_attempt(TEXT) TO service_role;

-- --------------------------------------------------------------------------
-- DB-C-1: enable RLS on code_attempts. service_role bypasses RLS by design,
-- so legitimate server-action callers are unaffected. Without this any anon
-- key holder could enumerate the table to confirm whether an email is in a
-- pending verification/reset flow.
-- --------------------------------------------------------------------------

ALTER TABLE code_attempts ENABLE ROW LEVEL SECURITY;

-- No policies for anon/authenticated → table is invisible to them. The grant
-- in 008_code_attempts.sql already limited table privileges to service_role,
-- but RLS gives the deny path a second guarantee in case grants drift.
DROP POLICY IF EXISTS "Service role full access to code_attempts" ON code_attempts;
CREATE POLICY "Service role full access to code_attempts" ON code_attempts
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- --------------------------------------------------------------------------
-- DB-C-5: drop the "Allow read semantic_cache" policy that exposed every
-- user's query text + AI response to any authenticated caller. Cache hits
-- already go through service_role via createAdminClient, so reads stay
-- functional. Authenticated direct REST access now returns zero rows.
-- --------------------------------------------------------------------------

DROP POLICY IF EXISTS "Allow read semantic_cache" ON semantic_cache;

-- Same defense for parent_chunks — the LLM context fetcher uses service_role
-- via the parent-expansion path; no user-facing read happens at this layer.
DROP POLICY IF EXISTS "Allow read parent_chunks" ON parent_chunks;

-- Belt to the RLS-policy suspenders above: revoke EXECUTE on the wrapper RPCs
-- that wrap reads of these tables. Without this an authenticated PostgREST
-- caller can still hit the function (returns zero rows under the new RLS but
-- the function is callable). Surfaced by the v1.0.0 db re-audit.
REVOKE EXECUTE ON FUNCTION search_semantic_cache(VECTOR(768), FLOAT, INT) FROM anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION search_semantic_cache(VECTOR(768), FLOAT, INT) TO service_role;
REVOKE EXECUTE ON FUNCTION get_parent_chunks(BIGINT[]) FROM anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION get_parent_chunks(BIGINT[]) TO service_role;


-- ============================================================================

SELECT
  'Database setup complete!' AS status,
  (SELECT COUNT(*) FROM users) AS users_count,
  (SELECT COUNT(*) FROM dubai_code_chunks) AS chunks_count,
  (SELECT COUNT(*) FROM chat_sessions) AS sessions_count,
  (SELECT COUNT(*) FROM chat_messages) AS messages_count,
  (SELECT COUNT(*) FROM audit_logs) AS audit_logs_count,
  (SELECT COUNT(*) FROM permit_applications) AS permits_count,
  (SELECT COUNT(*) FROM notifications) AS notifications_count,
  EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'document_trees') AS tree_reasoning_enabled,
  EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'permit_certificates') AS certificates_enabled,
  (SELECT COUNT(*) FROM document_registry) AS registered_documents;
