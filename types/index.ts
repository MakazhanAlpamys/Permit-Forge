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
  documentName?: string;     // Source document ID (e.g., "dubai-building-code-2021")
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
  confidence?: number;      // Verification confidence (0-100)
  contentType?: 'text' | 'table' | 'list' | 'heading';  // Type of content
  documentName?: string;    // Source document ID for multi-document RAG
}

export type ComplianceStatus = 'compliant' | 'non-compliant' | 'pending';

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

// -----------------------------------------------------------------------------
// Tree Reasoning Types (Structure-Aware RAG)
// -----------------------------------------------------------------------------

/**
 * Tree node for document structure (stored in database)
 * Each node represents a section/chapter in the document hierarchy
 */
export interface TreeNode {
  id: string;                    // Unique node ID (e.g., "0001", "0002")
  title: string;                 // Section title
  section?: string;              // Section number (e.g., "3.2.1")
  level: number;                 // Hierarchy level (0 = root, 1 = chapter, etc.)
  startPage: number;             // First page of this section
  endPage: number;               // Last page of this section
  parentId?: string;             // Parent node ID
  path: string;                  // Full path (e.g., "Chapter 3 > Fire Safety > Requirements")
}

/**
 * Result from Tree Reasoner Agent
 */
export interface TreeReasoningResult {
  selectedNodes: string[];       // Node IDs to search within
  reasoning: string;             // LLM's explanation of why these nodes
  confidence: number;            // 0-100 confidence score
  searchScope: 'narrow' | 'medium' | 'wide';  // How focused the search should be
}

/**
 * Query classification for routing
 */
export interface QueryClassification {
  isStructural: boolean;         // Does query reference document structure?
  structuralHints: string[];     // Detected structural keywords
  suggestedPath: 'tree' | 'standard' | 'exact';
}

// -----------------------------------------------------------------------------
// Permit Application Types
// -----------------------------------------------------------------------------

export type PermitStatus = 'draft' | 'submitted' | 'under_review' | 'approved' | 'rejected' | 'revision_requested';

export type ProjectType = 'residential' | 'commercial' | 'industrial' | 'mixed_use' | 'institutional';

export interface BuildingDetails {
  numberOfFloors: number;
  totalBuiltUpArea: number;     // sq meters
  plotArea: number;             // sq meters
  buildingHeight: number;       // meters
  numberOfUnits: number;
  numberOfParkingSpaces: number;
  occupancyType: string;
  constructionType: string;
}

export interface ComplianceRequirements {
  fireSafety: boolean;
  accessibility: boolean;
  parkingCompliance: boolean;
  structuralSafety: boolean;
  mepSystems: boolean;
  energyEfficiency: boolean;
  additionalNotes?: string;
}

export interface ComplianceCheckReference {
  page: number;
  section: string;
  excerpt: string;
}

export interface ComplianceCheckItem {
  category: string;
  status: 'compliant' | 'non_compliant' | 'requires_review';
  details: string;
  codeReferences: ComplianceCheckReference[];
}

export interface ComplianceCheckResult {
  overallStatus: 'compliant' | 'non_compliant' | 'requires_review';
  checks: ComplianceCheckItem[];
  summary: string;
  checkedAt: string;
}

export interface PermitApplication {
  id: string;
  userId: string;
  status: PermitStatus;
  projectName: string;
  projectType: ProjectType;
  projectAddress: string;
  plotNumber?: string;
  projectDescription?: string;
  buildingDetails: BuildingDetails;
  complianceRequirements: ComplianceRequirements;
  complianceCheckResult?: ComplianceCheckResult | null;
  reviewedBy?: string | null;
  reviewedAt?: string | null;
  reviewComments?: string | null;
  submittedAt?: string | null;
  revisionCount: number;
  revisionNotes?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PermitStatusHistoryEntry {
  id: string;
  permitId: string;
  fromStatus: string | null;
  toStatus: string;
  changedBy: string;
  changedByUsername?: string;
  comment?: string;
  createdAt: string;
}

export interface PermitStats {
  totalPermits: number;
  draftCount: number;
  submittedCount: number;
  underReviewCount: number;
  approvedCount: number;
  rejectedCount: number;
  revisionRequestedCount: number;
  permitsToday: number;
}

// -----------------------------------------------------------------------------
// Permit Attachment Types
// -----------------------------------------------------------------------------

export interface PermitAttachment {
  id: string;
  permitId: string;
  fileName: string;
  fileSize: number;
  fileType: string;
  storagePath: string;
  uploadedBy: string;
  uploadedAt: string;
  signedUrl?: string;
}

// -----------------------------------------------------------------------------
// Notification Types
// -----------------------------------------------------------------------------

export type NotificationType =
  | 'permit_submitted'
  | 'permit_under_review'
  | 'permit_approved'
  | 'permit_rejected'
  | 'permit_revision_requested';

export interface Notification {
  id: string;
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  data: Record<string, unknown>;
  read: boolean;
  createdAt: string;
}

// -----------------------------------------------------------------------------
// Permit Certificate Types
// -----------------------------------------------------------------------------

export interface PermitCertificate {
  id: string;
  permitId: string;
  certificateNumber: string;
  generatedBy: string;
  storagePath?: string;
  generatedAt: string;
}

