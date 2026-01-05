// ============================================================================
// Emirate Forge Type Definitions
// ============================================================================

// -----------------------------------------------------------------------------
// Database Types (matching Supabase schema)
// -----------------------------------------------------------------------------

export interface ChunkMetadata {
  page: number;
  chapter?: string;
  section?: string;
  tableId?: string;
  tableName?: string;
}

export interface MatchedChunk {
  id: number;
  content: string;
  metadata: ChunkMetadata;
  similarity: number;
}

// -----------------------------------------------------------------------------
// RAG Types
// -----------------------------------------------------------------------------

export interface RAGQuery {
  query: string;
  matchThreshold?: number;
  matchCount?: number;
}

export interface RAGResult {
  chunks: MatchedChunk[];
  context: string;
}

// -----------------------------------------------------------------------------
// Chat Types
// -----------------------------------------------------------------------------

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations?: Citation[];
  timestamp: Date;
  complianceStatus?: ComplianceStatus;
}

export interface Citation {
  chunkId: number;
  page: number;
  section?: string;
  excerpt: string;
  similarity: number;
}

export type ComplianceStatus = 'compliant' | 'non-compliant' | 'pending';

export interface ChatRequest {
  message: string;
  sessionId?: string;
}

export interface ChatResponse {
  message: string;
  citations: Citation[];
  complianceStatus: ComplianceStatus;
}

// -----------------------------------------------------------------------------
// Chat History Types
// -----------------------------------------------------------------------------

export interface ChatSession {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

// -----------------------------------------------------------------------------
// Ingestion Types
// -----------------------------------------------------------------------------

export interface IngestionResult {
  success: boolean;
  chunksProcessed: number;
  error?: string;
}
