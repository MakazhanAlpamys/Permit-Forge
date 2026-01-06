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
// Enhanced RAG Types (Advanced RAG Pipeline)
// -----------------------------------------------------------------------------

export interface EnhancedCitation {
  chunkId: number;
  page: number;
  section?: string;
  chapter?: string;
  exactQuote: string;      // Direct quote from the document
  context: string;         // Surrounding context
  similarity: number;      // Vector similarity score
  confidence: number;      // Verification confidence (0-100)
}

export interface VerifiedAnswer {
  answer: string;
  isVerified: boolean;
  confidence: number;
  supportingQuotes: string[];
  unsupportedClaims: string[];
  citations: EnhancedCitation[];
}

export interface HybridSearchResult {
  id: number;
  content: string;
  metadata: ChunkMetadata;
  vectorSimilarity: number;
  keywordRank: number;
  hybridScore: number;
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

// -----------------------------------------------------------------------------
// PDF Ingestion Types (Enhanced)
// -----------------------------------------------------------------------------

export interface PageContent {
  pageNumber: number;
  text: string;
  chapter?: string;
  sections: string[];
}

export interface EnhancedChunkMetadata extends ChunkMetadata {
  paragraph?: number;
  startOffset?: number;
  endOffset?: number;
  headings?: string[];
  isTable?: boolean;
}

