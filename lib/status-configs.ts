// ============================================================================
// Status configurations with lucide-react icons
// ============================================================================
// Split out from `lib/constants.ts` so middleware (Edge runtime) and small
// server-side modules can import constants without pulling in lucide-react.
// (audit ID L12)

import { CheckCircle, XCircle, Clock, FileEdit, Send, Eye, CheckCircle2, RotateCcw } from 'lucide-react';
import type { ComplianceStatus, PermitStatus } from '@/types';

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
