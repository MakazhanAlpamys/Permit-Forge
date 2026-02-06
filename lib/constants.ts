// ============================================================================
// Emirate Forge Constants & Configuration
// ============================================================================

import { CheckCircle, XCircle, Clock } from 'lucide-react';
import type { ComplianceStatus } from '@/types';

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
    textClassName: 'text-green-400',
    badgeClassName: 'bg-green-500/20 text-green-400 border-green-500/30',
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
