// ============================================================================
// PermitForge Constants & Configuration
// ============================================================================

import { CheckCircle, XCircle, Clock, FileEdit, Send, Eye, CheckCircle2, RotateCcw } from 'lucide-react';
import type { ComplianceStatus, PermitStatus } from '@/types';

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

// ============================================================================
// Compliance Status Configuration
// ============================================================================

export interface StatusConfigItem {
  icon: typeof CheckCircle;
  label: string;
  /** Class for simple text color (used in dashboard) */
  textClassName: string;
  /** Class for badge styling (used in chat bubbles) */
  badgeClassName: string;
}

export const complianceStatusConfig: Record<ComplianceStatus, StatusConfigItem> = {
  'compliant': {
    icon: CheckCircle,
    label: 'Compliant',
    textClassName: 'text-violet-400',
    badgeClassName: 'bg-violet-500/20 text-violet-400 border-violet-500/30',
  },
  'non-compliant': {
    icon: XCircle,
    label: 'Non-Compliant',
    textClassName: 'text-red-400',
    badgeClassName: 'bg-red-500/20 text-red-400 border-red-500/30',
  },
  'pending': {
    icon: Clock,
    label: 'Pending',
    textClassName: 'text-muted-foreground',
    badgeClassName: 'bg-muted text-muted-foreground border-muted',
  },
};

// ============================================================================
// Permit Status Configuration
// ============================================================================

export interface PermitStatusConfigItem {
  icon: typeof CheckCircle;
  label: string;
  textClassName: string;
  badgeClassName: string;
}

export const permitStatusConfig: Record<PermitStatus, PermitStatusConfigItem> = {
  'draft': {
    icon: FileEdit,
    label: 'Draft',
    textClassName: 'text-muted-foreground',
    badgeClassName: 'bg-muted text-muted-foreground border-muted',
  },
  'submitted': {
    icon: Send,
    label: 'Submitted',
    textClassName: 'text-blue-400',
    badgeClassName: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  },
  'under_review': {
    icon: Eye,
    label: 'Under Review',
    textClassName: 'text-yellow-400',
    badgeClassName: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  },
  'approved': {
    icon: CheckCircle2,
    label: 'Approved',
    textClassName: 'text-violet-400',
    badgeClassName: 'bg-violet-500/20 text-violet-400 border-violet-500/30',
  },
  'rejected': {
    icon: XCircle,
    label: 'Rejected',
    textClassName: 'text-red-400',
    badgeClassName: 'bg-red-500/20 text-red-400 border-red-500/30',
  },
  'revision_requested': {
    icon: RotateCcw,
    label: 'Revision Requested',
    textClassName: 'text-orange-400',
    badgeClassName: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
  },
};

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
