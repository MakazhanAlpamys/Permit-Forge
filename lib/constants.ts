// ============================================================================
// PermitForge Constants & Configuration
// ============================================================================

import type { ComplianceStatus, PermitStatus } from '@/types';

// C30H/L12: keep this file Edge-Runtime-safe by storing icon names as strings.
// Components resolve them via lib/status-icons.tsx at render time. Importing
// lucide-react here used to drag the full icon catalog into any module that
// transitively imported a constant.
export type StatusIconName =
  | 'CheckCircle'
  | 'XCircle'
  | 'Clock'
  | 'FileEdit'
  | 'Send'
  | 'Eye'
  | 'CheckCircle2'
  | 'RotateCcw';

// ============================================================================
// Authentication Constants
// ============================================================================

export const SESSION_COOKIE_NAME = 'ef_token';
export const CSRF_COOKIE_NAME = 'ef_csrf';
export const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

/**
 * Get JWT secret as Uint8Array for jose library
 * Compatible with both Edge Runtime (middleware) and Node.js runtime
 */
export function getJWTSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters');
  }
  return new TextEncoder().encode(secret);
}

// ============================================================================
// Chat Constants
// ============================================================================

export const MAX_MESSAGE_LENGTH = 500;

/**
 * INPUT-H1 / v1.5.0 Part F — character budget for chat history sent to the
 * LLM. ~4 chars per token (English heuristic) → ~3000 tokens. The old code
 * capped at 10 rows, which let a single long user message (500 chars) ×
 * 10 + a long assistant reply blow past the model's input window. Walking
 * newest-first within this budget bounds the worst case regardless of how
 * verbose any individual turn was.
 */
export const MAX_CHAT_HISTORY_CHARS = 12_000;

// ============================================================================
// RAG & AI Configuration
// ============================================================================

/** Maximum context length in characters (~3000 tokens) */
export const MAX_CONTEXT_LENGTH = 12000;

/** Document tree cache TTL in milliseconds (5 minutes) */
export const TREE_CACHE_TTL_MS = 5 * 60 * 1000;

/** Semantic cache similarity threshold (cosine distance) */
export const CACHE_SIMILARITY_THRESHOLD = 0.95;

/** Semantic cache TTL in seconds (1 hour) */
export const CACHE_TTL_SECONDS = 3600;

/**
 * v1.3.0 Part B (A-C-2) — minimum response length to write into the semantic
 * cache. Below this threshold we treat the response as a partial / aborted
 * stream and skip the cache write so the next identical query doesn't get a
 * truncated "answer" served for an hour.
 */
export const MIN_CACHEABLE_RESPONSE_LENGTH = 50;

/** Keyword weight for hybrid search RRF */
export const KEYWORD_WEIGHT = 0.3;

/** Vector weight for hybrid search RRF */
export const VECTOR_WEIGHT = 0.7;

/**
 * v1.10.0 Part A — RRF (Reciprocal Rank Fusion) smoothing constant. Higher
 * values flatten the score curve so top-ranked hits don't dominate; lower
 * values steepen it. 60 is the canonical default (matches the SQL RPC
 * `rrf_k INT DEFAULT 60` so the JS call site and the DB stay in lockstep).
 */
export const HYBRID_SEARCH_RRF_K = 60;

/** v1.10.0 Part A — Signed-URL TTL for permit attachments (1 hour). */
export const PERMIT_ATTACHMENT_SIGNED_URL_TTL_SECONDS = 3600;

// ============================================================================
// Rate Limiting Configuration
// ============================================================================

/** Rate limit window duration in seconds */
export const RATE_LIMIT_WINDOW_SECONDS = 60;

/** Maximum requests allowed per rate limit window */
export const MAX_REQUESTS_PER_WINDOW = 10;

/** Minimum interval between requests in milliseconds */
export const MIN_REQUEST_INTERVAL_MS = 2000;

// ============================================================================
// Compliance Status Configuration
// ============================================================================

export interface StatusConfigItem {
  iconName: StatusIconName;
  label: string;
  /** Class for simple text color (used in dashboard) */
  textClassName: string;
  /** Class for badge styling (used in chat bubbles) */
  badgeClassName: string;
}

export const complianceStatusConfig: Record<ComplianceStatus, StatusConfigItem> = {
  'compliant': {
    iconName: 'CheckCircle',
    label: 'Compliant',
    textClassName: 'text-violet-400',
    badgeClassName: 'bg-violet-500/20 text-violet-400 border-violet-500/30',
  },
  'non-compliant': {
    iconName: 'XCircle',
    label: 'Non-Compliant',
    textClassName: 'text-red-400',
    badgeClassName: 'bg-red-500/20 text-red-400 border-red-500/30',
  },
  'pending': {
    iconName: 'Clock',
    label: 'Pending',
    textClassName: 'text-muted-foreground',
    badgeClassName: 'bg-muted text-muted-foreground border-muted',
  },
};

// ============================================================================
// Permit Status Configuration
// ============================================================================

export interface PermitStatusConfigItem {
  iconName: StatusIconName;
  label: string;
  textClassName: string;
  badgeClassName: string;
}

export const permitStatusConfig: Record<PermitStatus, PermitStatusConfigItem> = {
  'draft': {
    iconName: 'FileEdit',
    label: 'Draft',
    textClassName: 'text-muted-foreground',
    badgeClassName: 'bg-muted text-muted-foreground border-muted',
  },
  'submitted': {
    iconName: 'Send',
    label: 'Submitted',
    textClassName: 'text-blue-400',
    badgeClassName: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  },
  'under_review': {
    iconName: 'Eye',
    label: 'Under Review',
    textClassName: 'text-yellow-400',
    badgeClassName: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  },
  'approved': {
    iconName: 'CheckCircle2',
    label: 'Approved',
    textClassName: 'text-violet-400',
    badgeClassName: 'bg-violet-500/20 text-violet-400 border-violet-500/30',
  },
  'rejected': {
    iconName: 'XCircle',
    label: 'Rejected',
    textClassName: 'text-red-400',
    badgeClassName: 'bg-red-500/20 text-red-400 border-red-500/30',
  },
  'revision_requested': {
    iconName: 'RotateCcw',
    label: 'Revision Requested',
    textClassName: 'text-orange-400',
    badgeClassName: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
  },
};

/**
 * Filter pills used by both the user-facing permit list and the admin
 * permit management screen. Order matters — it's the visual order of the
 * filter row. (F25 / Simplify #25)
 */
export interface PermitStatusFilterItem {
  value: PermitStatus | 'all';
  label: string;
}

export const PERMIT_STATUS_FILTERS: PermitStatusFilterItem[] = [
  { value: 'all', label: 'All' },
  { value: 'draft', label: 'Drafts' },
  { value: 'submitted', label: 'Submitted' },
  { value: 'under_review', label: 'Under Review' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'revision_requested', label: 'Revision Requested' },
];

export const PROJECT_TYPES = [
  { value: 'residential', label: 'Residential' },
  { value: 'commercial', label: 'Commercial' },
  { value: 'industrial', label: 'Industrial' },
  { value: 'mixed_use', label: 'Mixed Use' },
  { value: 'institutional', label: 'Institutional' },
] as const;

// ============================================================================
// File Upload Configuration
// ============================================================================

export const FILE_UPLOAD_LIMITS = {
  maxFileSize: 10 * 1024 * 1024,     // 10MB
  maxFilesPerPermit: 10,
  allowedExtensions: ['.pdf', '.png', '.jpg', '.jpeg', '.dwg', '.dxf'],
  allowedMimeTypes: [
    'application/pdf',
    'image/png',
    'image/jpeg',
  ],
  storageBucket: 'permit-attachments',
} as const;

export const DOCUMENT_PDF_LIMITS = {
  maxSizeBytes: 100 * 1024 * 1024,   // 100MB
  maxSizeMB: 100,
  allowedMimeTypes: ['application/pdf'],
  storageBucket: 'document-pdfs',
} as const;

// ============================================================================
// Document Badge Colors (F20 / Simplify #20)
// ============================================================================

export interface BadgeColorOption {
  label: string;
  value: string;
}

export const DOCUMENT_BADGE_COLORS: readonly BadgeColorOption[] = [
  { label: 'Blue', value: 'bg-blue-500/20 text-blue-400 border-blue-500/30' },
  { label: 'Red', value: 'bg-red-500/20 text-red-400 border-red-500/30' },
  { label: 'Violet', value: 'bg-violet-500/20 text-violet-400 border-violet-500/30' },
  { label: 'Purple', value: 'bg-purple-500/20 text-purple-400 border-purple-500/30' },
  { label: 'Cyan', value: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30' },
  { label: 'Green', value: 'bg-green-500/20 text-green-400 border-green-500/30' },
  { label: 'Orange', value: 'bg-orange-500/20 text-orange-400 border-orange-500/30' },
  { label: 'Yellow', value: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30' },
  { label: 'Gray', value: 'bg-gray-500/20 text-gray-400 border-gray-500/30' },
] as const;
