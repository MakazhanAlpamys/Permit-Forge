-- ============================================================================
-- Emirate Forge - Complete Database Setup (Advanced RAG with Hybrid Search)
-- Run this SQL in Supabase SQL Editor (https://supabase.com/dashboard)
-- ============================================================================

-- ============================================================================
-- 1. EXTENSIONS
-- ============================================================================

-- Enable pgvector extension for embeddings
CREATE EXTENSION IF NOT EXISTS vector;

-- Enable pg_trgm for fuzzy text matching (optional but useful)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

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
-- 2.2 KEYWORD SEARCH FUNCTION (Full-Text Search)
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
AS $$
DECLARE
  tsquery_val tsquery;
BEGIN
  -- Convert search query to tsquery with prefix matching
  -- Handle special characters and create a flexible query
  tsquery_val := plainto_tsquery('english', search_query);
  
  RETURN QUERY
  SELECT
    dubai_code_chunks.id,
    dubai_code_chunks.content,
    dubai_code_chunks.metadata,
    ts_rank_cd(dubai_code_chunks.fts, tsquery_val)::FLOAT AS rank
  FROM dubai_code_chunks
  WHERE dubai_code_chunks.fts @@ tsquery_val
  ORDER BY rank DESC
  LIMIT match_count;
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
-- 2.4 EXACT SECTION SEARCH (For precise lookups like "Section 4.2.1")
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
AS $$
BEGIN
  RETURN QUERY
  SELECT
    d.id,
    d.content,
    d.metadata,
    POSITION(LOWER(search_pattern) IN LOWER(d.content))::INT AS match_position
  FROM dubai_code_chunks d
  WHERE LOWER(d.content) LIKE '%' || LOWER(search_pattern) || '%'
  ORDER BY match_position
  LIMIT match_count;
END;
$$;

-- ============================================================================
-- 3. AUTHENTICATION SYSTEM
-- ============================================================================

-- Create users table
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT,
  role TEXT DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_login TIMESTAMP WITH TIME ZONE
);

-- Create index for faster username lookup
CREATE INDEX IF NOT EXISTS users_username_idx ON users(username);

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
-- 5. PERMISSIONS
-- ============================================================================

-- Grant permissions for RAG system (including new functions)
GRANT SELECT ON dubai_code_chunks TO anon, authenticated;
GRANT EXECUTE ON FUNCTION match_dubai_code TO anon, authenticated;
GRANT EXECUTE ON FUNCTION search_dubai_code_keywords TO anon, authenticated;
GRANT EXECUTE ON FUNCTION match_dubai_code_hybrid TO anon, authenticated;
GRANT EXECUTE ON FUNCTION search_dubai_code_exact TO anon, authenticated;

-- Grant permissions for auth and chat systems
GRANT ALL ON users TO anon, authenticated;
GRANT ALL ON chat_sessions TO anon, authenticated;
GRANT ALL ON chat_messages TO anon, authenticated;

-- ============================================================================
-- 6. DEFAULT USERS (Create via application script)
-- ============================================================================
-- 
-- IMPORTANT: bcrypt hashes cannot be generated in SQL.
-- After running this migration, create users via terminal:
--
--   npx tsx scripts/create-user.ts
--
-- Or programmatically:
--   import { hashPassword } from '@/lib/auth';
--   const hash = await hashPassword('your-password');
--
-- Default credentials to create:
--   Admin: username=admin, password=admin123, role=admin
--   User:  username=user,  password=user123,  role=user
--

-- ============================================================================
-- 7. VERIFICATION
-- ============================================================================

SELECT 
  'Database setup complete!' AS status,
  (SELECT COUNT(*) FROM dubai_code_chunks) AS chunks_count,
  (SELECT COUNT(*) FROM users) AS users_count,
  (SELECT COUNT(*) FROM chat_sessions) AS sessions_count,
  (SELECT COUNT(*) FROM chat_messages) AS messages_count;
