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
      'get_all_documents', 'upsert_document', 'delete_document'
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
  email TEXT,
  role TEXT DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  blocked BOOLEAN DEFAULT FALSE,
  blocked_reason TEXT,
  blocked_at TIMESTAMP WITH TIME ZONE,
  blocked_by UUID,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_login TIMESTAMP WITH TIME ZONE
);

ALTER TABLE users ADD CONSTRAINT users_blocked_by_fkey
  FOREIGN KEY (blocked_by) REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX users_username_idx ON users(username);
CREATE INDEX users_blocked_idx ON users(blocked) WHERE blocked = TRUE;

-- ---------------------------------------------------------------------------
-- 2.2 DUBAI CODE CHUNKS (RAG)
-- ---------------------------------------------------------------------------

CREATE TABLE dubai_code_chunks (
  id BIGSERIAL PRIMARY KEY,
  content TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  embedding VECTOR(768),
  document_name TEXT NOT NULL DEFAULT 'dubai-building-code-2021',
  parent_id BIGINT,  -- References parent_chunks for parent-child chunking (v2)
  fts tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
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
CREATE INDEX idx_chunks_content_type ON dubai_code_chunks ((metadata->>'contentType'));
CREATE INDEX idx_chunks_document_name ON dubai_code_chunks(document_name);
CREATE INDEX idx_chunks_doc_pages
  ON dubai_code_chunks(document_name, ((metadata->>'startPage')::INT), ((metadata->>'endPage')::INT));

-- ---------------------------------------------------------------------------
-- 2.3 DOCUMENT TREES (Tree Reasoning)
-- ---------------------------------------------------------------------------

CREATE TABLE document_trees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_name TEXT NOT NULL UNIQUE,
  total_pages INT NOT NULL DEFAULT 0,
  tree_data JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_document_trees_name ON document_trees(document_name);

-- ---------------------------------------------------------------------------
-- 2.4 CHAT SESSIONS & MESSAGES
-- ---------------------------------------------------------------------------

CREATE TABLE chat_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  citations JSONB DEFAULT '[]',
  compliance_status TEXT CHECK (compliance_status IN ('compliant', 'non-compliant', 'requires-review', 'pending')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
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
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
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
  request_timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW()
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
  reviewed_at TIMESTAMP WITH TIME ZONE,
  review_comments TEXT,
  revision_count INTEGER NOT NULL DEFAULT 0,
  revision_notes TEXT,
  submitted_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
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
  from_status TEXT,
  to_status TEXT NOT NULL,
  changed_by UUID NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  comment TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX permit_history_permit_id_idx  ON permit_status_history(permit_id);
CREATE INDEX permit_history_created_at_idx ON permit_status_history(created_at DESC);

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
  uploaded_by UUID NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
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
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
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
  generated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX permit_certificates_permit_id_idx ON permit_certificates(permit_id);
CREATE UNIQUE INDEX permit_certificates_number_idx ON permit_certificates(certificate_number);

-- ---------------------------------------------------------------------------
-- 2.12 PARENT CHUNKS (v2 Pipeline - Parent-Child Chunking)
-- ---------------------------------------------------------------------------

CREATE TABLE parent_chunks (
  id BIGSERIAL PRIMARY KEY,
  content TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  document_name TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
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
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  ttl_seconds INT NOT NULL DEFAULT 3600  -- 1 hour default
);

CREATE INDEX semantic_cache_embedding_idx
  ON semantic_cache USING hnsw (query_embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX semantic_cache_created_at_idx ON semantic_cache(created_at DESC);

-- ---------------------------------------------------------------------------
-- 2.14 DOCUMENT REGISTRY (Dynamic document management)
-- ---------------------------------------------------------------------------

CREATE TABLE document_registry (
  id TEXT PRIMARY KEY,                          -- e.g. 'dubai-building-code-2021'
  display_name TEXT NOT NULL,
  short_name TEXT NOT NULL,
  file_name TEXT NOT NULL,                      -- PDF filename (stored in public/ or uploads/)
  source_url TEXT DEFAULT '',
  authority TEXT DEFAULT 'Dubai Municipality',
  description TEXT DEFAULT '',
  badge_color TEXT DEFAULT 'bg-gray-500/20 text-gray-400 border-gray-500/30',
  keywords TEXT[] DEFAULT '{}',                 -- For document selector scoring
  categories TEXT[] DEFAULT '{}',               -- Category tags
  is_active BOOLEAN DEFAULT TRUE,               -- Soft delete / disable
  keywords_auto_generated BOOLEAN DEFAULT TRUE,  -- FALSE if admin manually edited keywords
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_document_registry_active ON document_registry(is_active) WHERE is_active = TRUE;

-- Seed with the 5 default documents (keywords_auto_generated=false because these are hand-curated)
INSERT INTO document_registry (id, display_name, short_name, file_name, source_url, authority, description, badge_color, keywords, categories, keywords_auto_generated)
VALUES
  ('dubai-building-code-2021', 'Dubai Building Code 2021', 'DBC', 'dubai-code.pdf',
   'https://dm.gov.ae/wp-content/uploads/2021/12/Dubai%20Building%20Code_English_2021%20Edition_compressed.pdf',
   'Dubai Municipality', 'Comprehensive building regulations for construction in Dubai',
   'bg-blue-500/20 text-blue-400 border-blue-500/30',
   ARRAY['building','code','construction','parking','height','setback','floor','area','ratio','plot','structural','foundation','concrete','steel','load','seismic','occupancy','classification','permit','inspection','glazing','facade','cladding','roofing','insulation','waterproofing','balcony','basement','podium','tower','corridor','stairway','ramp','high-rise','low-rise','residential','commercial','industrial','mixed-use','villa','apartment','office','retail','hotel','warehouse'],
   ARRAY['structural','general','parking','construction'], false),
  ('code-of-safety', 'Dubai Code of Safety', 'Safety', 'code_of_safety_EN.pdf',
   'https://www.dm.gov.ae/wp-content/uploads/2022/04/code_of_safety_EN.pdf',
   'Dubai Municipality', 'Safety regulations and requirements for buildings in Dubai',
   'bg-red-500/20 text-red-400 border-red-500/30',
   ARRAY['safety','fire','egress','exit','stair','alarm','smoke','sprinkler','detector','extinguisher','evacuation','emergency','firewall','fire-resistance','fire-rated','fire-separation','escape','refuge','hazard','flammable','combustible','fire-fighting','hydrant','hose','suppression','compartment'],
   ARRAY['safety','fire','emergency'], false),
  ('al-safat-green-building', 'Al Sa''fat Green Building System (2nd Ed, 2023)', 'Al Sa''fat', 'Al-Safat-–-Dubai-Green-Building-System-2nd-editionJan2023.pdf',
   'https://www.dm.gov.ae/wp-content/uploads/2023/01/Al-Safat-%E2%80%93-Dubai-Green-Building-System-2nd-editionJan2023.pdf',
   'Dubai Municipality', 'Mandatory green building rating system with Silver, Gold, and Platinum tiers',
   'bg-violet-500/20 text-violet-400 border-violet-500/30',
   ARRAY['green','safat','energy','efficiency','solar','renewable','sustainability','environment','carbon','emission','water','conservation','recycling','waste','landscape','vegetation','thermal','insulation','hvac','cooling','lighting','daylight','silver','gold','platinum','rating','tier','indoor','air quality','material','leed'],
   ARRAY['environmental','energy','green'], false),
  ('universal-design-code', 'Dubai Universal Design Code', 'UDC', 'Dubai-Guide-for-Built-Environment-Universal-Design-1_compressed.pdf',
   'https://www.dm.gov.ae/wp-content/uploads/2020/11/Dubai-Guide-for-Built-Environment-Universal-Design-1_compressed.pdf',
   'Dubai Municipality', 'Accessibility and universal design requirements for the built environment',
   'bg-purple-500/20 text-purple-400 border-purple-500/30',
   ARRAY['accessibility','universal','design','disability','wheelchair','ramp','handrail','tactile','braille','signage','elevator','lift','restroom','toilet','washroom','door','width','clearance','reach','grab bar','accessible','determination','inclusive','mobility','visual','hearing','impairment'],
   ARRAY['accessibility','universal-design'], false),
  ('sewerage-stormwater-guidelines', 'Sewerage & Stormwater Design Guidelines (2025)', 'Sewerage', 'comp-DM_Sewerage-Guidelines-F.24.01.25.pdf',
   'https://www.dm.gov.ae/wp-content/uploads/2025/01/comp-DM_Sewerage-Guidelines-F.24.01.25.pdf',
   'Dubai Municipality', 'Technical guidelines for sewerage and stormwater drainage design',
   'bg-cyan-500/20 text-cyan-400 border-cyan-500/30',
   ARRAY['sewerage','sewer','stormwater','drainage','plumbing','pipe','manhole','pumping','station','wastewater','effluent','grease','trap','interceptor','backflow','valve','vent','fixture','sanitary','rainwater','runoff','catchment','flood','retention','infiltration','outfall','tss'],
   ARRAY['mep','plumbing','drainage'], false)
ON CONFLICT (id) DO NOTHING;

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
GROUP BY DATE(cm.created_at)
ORDER BY date DESC;

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
  IF sanitized_query = '' THEN sanitized_query := query_text; END IF;

  tsquery_val := plainto_tsquery('english', sanitized_query);

  RETURN QUERY
  WITH page_filtered AS (
    SELECT d.*
    FROM dubai_code_chunks d
    WHERE EXISTS (
      SELECT 1
      FROM jsonb_array_elements(page_ranges) AS r
      WHERE
        COALESCE((d.metadata->>'startPage')::INT, (d.metadata->>'page')::INT, 0) <= (r->>'end_page')::INT
        AND COALESCE((d.metadata->>'endPage')::INT, (d.metadata->>'page')::INT, 9999) >= (r->>'start_page')::INT
    )
    AND (filter_document IS NULL OR d.document_name = filter_document)
  ),
  vector_results AS (
    SELECT
      pf.id, pf.content, pf.metadata,
      (1 - (pf.embedding <=> query_embedding))::FLOAT AS v_similarity,
      ROW_NUMBER() OVER (ORDER BY pf.embedding <=> query_embedding) AS v_rank
    FROM page_filtered pf
    WHERE 1 - (pf.embedding <=> query_embedding) > 0.35
    ORDER BY pf.embedding <=> query_embedding
    LIMIT 30
  ),
  keyword_results AS (
    SELECT
      pf.id, pf.content, pf.metadata,
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
-- 5.9 Tree Helper Functions
-- ---------------------------------------------------------------------------

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
  DELETE FROM dubai_code_chunks WHERE document_name = target_document;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
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
AS $$
DECLARE
  v_window_start TIMESTAMP WITH TIME ZONE;
  v_last_request TIMESTAMP WITH TIME ZONE;
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
SET search_path = public
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
AS $$
  WITH date_series AS (
    SELECT generate_series(
      (current_date - interval '29 days')::date,
      current_date,
      '1 day'::interval
    )::date AS day
  ),
  daily_messages AS (
    SELECT
      date_trunc('day', cm.created_at)::date AS day,
      count(*) FILTER (WHERE cm.role = 'user') AS user_count,
      count(*) FILTER (WHERE cm.role = 'assistant') AS assistant_count,
      count(*) AS total_count,
      count(DISTINCT cs.user_id) AS active_users
    FROM chat_messages cm
    JOIN chat_sessions cs ON cs.id = cm.session_id
    WHERE cm.created_at >= current_date - interval '29 days'
    GROUP BY 1
  )
  SELECT
    ds.day,
    COALESCE(dm.user_count, 0),
    COALESCE(dm.assistant_count, 0),
    COALESCE(dm.total_count, 0),
    COALESCE(dm.active_users, 0)
  FROM date_series ds
  LEFT JOIN daily_messages dm ON dm.day = ds.day
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
BEGIN
  SELECT role INTO v_admin_role FROM users WHERE id = p_admin_id;
  IF v_admin_role != 'admin' THEN RAISE EXCEPTION 'Unauthorized: Admin role required'; END IF;
  IF p_admin_id = p_target_user_id THEN RAISE EXCEPTION 'Cannot block yourself'; END IF;

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
BEGIN
  IF p_new_role NOT IN ('admin', 'user') THEN RAISE EXCEPTION 'Invalid role'; END IF;
  SELECT role INTO v_admin_role FROM users WHERE id = p_admin_id;
  IF v_admin_role != 'admin' THEN RAISE EXCEPTION 'Unauthorized: Admin role required'; END IF;

  UPDATE users SET role = p_new_role WHERE id = p_target_user_id;
  RETURN TRUE;
END;
$$;

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
  SELECT users.role INTO v_admin_role FROM users WHERE users.id = p_admin_id;
  IF v_admin_role != 'admin' THEN RAISE EXCEPTION 'Unauthorized: Admin role required'; END IF;

  RETURN QUERY
  SELECT
    u.id, u.username, u.full_name, u.role, u.blocked, u.blocked_reason,
    u.created_at, u.last_login,
    (SELECT COUNT(*) FROM chat_sessions cs WHERE cs.user_id = u.id)::BIGINT,
    (SELECT COUNT(*) FROM chat_messages cm
     JOIN chat_sessions cs ON cm.session_id = cs.id
     WHERE cs.user_id = u.id)::BIGINT
  FROM users u
  WHERE (p_search IS NULL OR u.username ILIKE '%' || p_search || '%' OR u.full_name ILIKE '%' || p_search || '%')
  ORDER BY u.created_at DESC
  LIMIT LEAST(p_limit, 100) OFFSET p_offset;
END;
$$;

-- ============================================================================
-- 9. PERMISSIONS
-- ============================================================================

-- RAG system
GRANT SELECT, INSERT, DELETE, UPDATE ON dubai_code_chunks TO anon, authenticated, service_role;
GRANT USAGE, SELECT ON SEQUENCE dubai_code_chunks_id_seq TO anon, authenticated, service_role;

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

-- dubai_code_chunks: full access (RAG + ingestion)
CREATE POLICY "Allow all chunks operations" ON dubai_code_chunks
  FOR ALL TO anon, authenticated, service_role USING (true) WITH CHECK (true);

-- document_trees: read for all, write for service_role
CREATE POLICY "Allow read document trees" ON document_trees
  FOR SELECT TO anon, authenticated, service_role USING (true);
CREATE POLICY "Service role full access to document trees" ON document_trees
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- chat_sessions: full access (auth in app layer)
CREATE POLICY "Allow all sessions operations" ON chat_sessions
  FOR ALL TO anon, authenticated, service_role USING (true) WITH CHECK (true);

-- chat_messages: full access (auth in app layer)
CREATE POLICY "Allow all messages operations" ON chat_messages
  FOR ALL TO anon, authenticated, service_role USING (true) WITH CHECK (true);

-- audit_logs: full access (auth in app layer)
CREATE POLICY "Allow all audit operations" ON audit_logs
  FOR ALL TO anon, authenticated, service_role USING (true) WITH CHECK (true);

-- rate_limits: full access
CREATE POLICY "Allow all rate limits operations" ON rate_limits
  FOR ALL TO anon, authenticated, service_role USING (true) WITH CHECK (true);

-- permit_applications: full access (auth in app layer)
CREATE POLICY "Allow all permit_applications operations" ON permit_applications
  FOR ALL TO anon, authenticated, service_role USING (true) WITH CHECK (true);

-- permit_status_history: full access
CREATE POLICY "Allow all permit_status_history operations" ON permit_status_history
  FOR ALL TO anon, authenticated, service_role USING (true) WITH CHECK (true);

-- permit_attachments: full access
CREATE POLICY "Allow all permit_attachments operations" ON permit_attachments
  FOR ALL TO anon, authenticated, service_role USING (true) WITH CHECK (true);

-- notifications: full access
CREATE POLICY "Allow all notifications operations" ON notifications
  FOR ALL TO anon, authenticated, service_role USING (true) WITH CHECK (true);

-- permit_certificates: full access
CREATE POLICY "Allow all permit_certificates operations" ON permit_certificates
  FOR ALL TO anon, authenticated, service_role USING (true) WITH CHECK (true);

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
  source_url TEXT,
  authority TEXT,
  description TEXT,
  badge_color TEXT,
  keywords TEXT[],
  categories TEXT[],
  is_active BOOLEAN,
  keywords_auto_generated BOOLEAN,
  created_at TIMESTAMP WITH TIME ZONE,
  updated_at TIMESTAMP WITH TIME ZONE
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT dr.id, dr.display_name, dr.short_name, dr.file_name,
         dr.source_url, dr.authority, dr.description, dr.badge_color,
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
  p_authority TEXT DEFAULT 'Dubai Municipality',
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

REVOKE ALL ON FUNCTION search_semantic_cache(VECTOR(768), FLOAT, INT) FROM public, anon;
GRANT EXECUTE ON FUNCTION search_semantic_cache(VECTOR(768), FLOAT, INT) TO authenticated;
REVOKE ALL ON FUNCTION insert_semantic_cache(TEXT, VECTOR(768), TEXT, JSONB, INT) FROM public, anon;
GRANT EXECUTE ON FUNCTION insert_semantic_cache(TEXT, VECTOR(768), TEXT, JSONB, INT) TO authenticated;
REVOKE ALL ON FUNCTION cleanup_semantic_cache() FROM public, anon;
GRANT EXECUTE ON FUNCTION cleanup_semantic_cache() TO authenticated;
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
GRANT EXECUTE ON FUNCTION cleanup_old_sessions(INT) TO authenticated;

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
GRANT EXECUTE ON FUNCTION cleanup_old_audit_logs(INT) TO authenticated;

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
GRANT EXECUTE ON FUNCTION cleanup_expired_rate_limits() TO authenticated;

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
GRANT EXECUTE ON FUNCTION run_all_cleanup(INT, INT) TO authenticated;

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
-- VERIFICATION
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
