// ============================================================================
// Emirate Forge Constants & Configuration
// ============================================================================

import { CheckCircle, XCircle, Clock } from 'lucide-react';
import type { ComplianceStatus } from '@/types';

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
