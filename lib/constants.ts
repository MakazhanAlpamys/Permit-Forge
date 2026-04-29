// ============================================================================
// PermitForge Constants & Configuration
// ============================================================================
// L12: status configs that pull in lucide-react icons live in
// `lib/status-configs.ts`. This module stays import-cheap so middleware
// (Edge runtime) and small server actions don't pull React icons into
// their bundle.

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

/** Keyword weight for hybrid search RRF */
export const KEYWORD_WEIGHT = 0.3;

/** Vector weight for hybrid search RRF */
export const VECTOR_WEIGHT = 0.7;

// ============================================================================
// Rate Limiting Configuration
// ============================================================================

/** Rate limit window duration in seconds */
export const RATE_LIMIT_WINDOW_SECONDS = 60;

/** Maximum requests allowed per rate limit window */
export const MAX_REQUESTS_PER_WINDOW = 10;

/** Minimum interval between requests in milliseconds */
export const MIN_REQUEST_INTERVAL_MS = 2000;

// Status configs (with lucide-react icons) live in `lib/status-configs.ts`.
// Re-exported here for backwards compatibility — but new code should import
// from `lib/status-configs` directly.
export { complianceStatusConfig, permitStatusConfig } from '@/lib/status-configs';
export type { StatusConfigItem, PermitStatusConfigItem } from '@/lib/status-configs';

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
