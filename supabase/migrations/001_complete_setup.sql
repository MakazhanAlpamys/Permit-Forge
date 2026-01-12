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

-- Grant RPC function permissions
GRANT EXECUTE ON FUNCTION match_dubai_code TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION search_dubai_code_keywords TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION match_dubai_code_hybrid TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION search_dubai_code_exact TO anon, authenticated, service_role;

-- Grant permissions for auth and chat systems
GRANT ALL ON users TO anon, authenticated, service_role;
GRANT ALL ON chat_sessions TO anon, authenticated, service_role;
GRANT ALL ON chat_messages TO anon, authenticated, service_role;

-- Grant permissions for rate limiting
GRANT ALL ON rate_limits TO anon, authenticated, service_role;
GRANT USAGE, SELECT ON SEQUENCE rate_limits_id_seq TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION check_rate_limit TO anon, authenticated, service_role;

-- Grant permissions for admin functions
GRANT EXECUTE ON FUNCTION get_admin_stats TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_weekly_activity TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_recent_audit_logs TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION admin_block_user TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION admin_update_user_role TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_all_users_admin TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION refresh_analytics TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION update_session_timestamp TO anon, authenticated, service_role;

-- Grant access to audit_logs table
GRANT ALL ON audit_logs TO anon, authenticated, service_role;
GRANT USAGE, SELECT ON SEQUENCE audit_logs_id_seq TO anon, authenticated, service_role;

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

-- -----------------------------------------------------------------------------
-- USERS TABLE POLICIES
-- -----------------------------------------------------------------------------
-- Service role bypasses RLS automatically, but we need policies for app access

-- Drop all existing policies first
DROP POLICY IF EXISTS "Service role full access to users" ON users;
DROP POLICY IF EXISTS "Users can view own profile" ON users;
DROP POLICY IF EXISTS "Allow username lookup for login" ON users;
DROP POLICY IF EXISTS "Allow update for login" ON users;
DROP POLICY IF EXISTS "Allow insert users" ON users;
DROP POLICY IF EXISTS "Allow delete users" ON users;
DROP POLICY IF EXISTS "Allow all users operations" ON users;

-- FULL ACCESS: Allow all operations on users table (admin check done in application layer)
-- This is needed because we use service_role key for admin operations
CREATE POLICY "Allow all users operations" ON users
  FOR ALL
  TO anon, authenticated, service_role
  USING (true)
  WITH CHECK (true);

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
-- 12. DEFAULT ADMIN USER
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
  EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'blocked') AS blocked_column_exists;
