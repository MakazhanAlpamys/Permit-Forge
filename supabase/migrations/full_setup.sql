-- ============================================================================
-- Emirate Forge - Complete Database Setup
-- Run this SQL in Supabase SQL Editor (https://supabase.com/dashboard)
-- ============================================================================

-- ============================================================================
-- 1. EXTENSIONS
-- ============================================================================

-- Enable pgvector extension for embeddings
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================================
-- 2. RAG SYSTEM (Dubai Code Chunks)
-- ============================================================================

-- Create the chunks table
CREATE TABLE IF NOT EXISTS dubai_code_chunks (
  id BIGSERIAL PRIMARY KEY,
  content TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  embedding VECTOR(768), -- Gemini text-embedding-004 dimensions
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create index for fast similarity search
CREATE INDEX IF NOT EXISTS dubai_code_chunks_embedding_idx 
ON dubai_code_chunks 
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);

-- Create the match_dubai_code RPC function (LangChain compatible)
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
  WHERE 1 - (dubai_code_chunks.embedding <=> query_embedding) > 0.7
  ORDER BY dubai_code_chunks.embedding <=> query_embedding
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

-- Grant permissions for RAG system
GRANT SELECT ON dubai_code_chunks TO anon, authenticated;
GRANT EXECUTE ON FUNCTION match_dubai_code TO anon, authenticated;

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
