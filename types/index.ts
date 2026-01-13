// ============================================================================
// Emirate Forge Type Definitions
// ============================================================================

// -----------------------------------------------------------------------------
// Database Types (matching Supabase schema)
// -----------------------------------------------------------------------------

export interface ChunkMetadata {
  page: number;              // Primary page (for backwards compatibility)
  startPage: number;         // First page of chunk
  endPage: number;           // Last page of chunk (same as startPage if single page)
  chapter?: string;
  section?: string;          // Section number like "3.2.1"
  sectionTitle?: string;     // Full section title
  sectionPath?: string[];    // Hierarchy: ["Chapter 3", "3.2 Fire Safety", "3.2.1 Requirements"]
  tableId?: string;
  tableName?: string;
  isTable?: boolean;
  contentType?: 'text' | 'table' | 'list' | 'heading';
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
  startPage?: number;       // For page range display
  endPage?: number;         // For page range display
  section?: string;
  sectionTitle?: string;
  excerpt: string;
  similarity: number;
  isVerified?: boolean;     // Was this citation actually used in the answer?
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
  startPage?: number;
  endPage?: number;
  section?: string;
  sectionTitle?: string;
  chapter?: string;
  exactQuote: string;      // Direct quote from the document
  context: string;         // Surrounding context
  similarity: number;      // Vector similarity score
  confidence: number;      // Verification confidence (0-100)
  isVerified?: boolean;    // Was this citation actually used?
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
  pagesProcessed?: number;
  tocExtracted?: boolean;
  error?: string;
}

// -----------------------------------------------------------------------------
// PDF Ingestion Types (Enhanced with PDF.js)
// -----------------------------------------------------------------------------

/**
 * Table of Contents entry extracted from PDF bookmarks/outlines
 */
export interface TOCEntry {
  title: string;           // "3.2.1 Fire Safety Requirements"
  pageNumber: number;      // Destination page
  level: number;           // Nesting level (0 = chapter, 1 = section, etc.)
  section?: string;        // Extracted section number "3.2.1"
  children?: TOCEntry[];   // Nested entries
}

/**
 * Document structure with TOC for section mapping
 */
export interface DocumentStructure {
  totalPages: number;
  toc: TOCEntry[];
  flatTOC: TOCEntry[];     // Flattened for easy lookup
}

/**
 * Page content with precise tracking
 */
export interface PDFPageContent {
  pageNumber: number;
  text: string;
  textItems: TextItem[];   // Individual text items with positions
}

/**
 * Text item with position info from PDF.js
 */
export interface TextItem {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontName?: string;
  fontSize?: number;
}

/**
 * Chunk with full page tracking
 */
export interface ChunkWithPageRange {
  content: string;
  startPage: number;
  endPage: number;
  section?: string;
  sectionTitle?: string;
  sectionPath?: string[];
  isTable: boolean;
  contentType: 'text' | 'table' | 'list' | 'heading';
}

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
}

