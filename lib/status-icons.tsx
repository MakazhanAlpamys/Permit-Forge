// ============================================================================
// Status Icon Resolver (React layer)
// Lucide imports moved out of lib/constants.ts (C30H/L12) so constants stay
// Edge-Runtime-safe. This file is client-only and consumed by status badges.
// ============================================================================

import { CheckCircle, XCircle, Clock, FileEdit, Send, Eye, CheckCircle2, RotateCcw } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { StatusIconName } from '@/lib/constants';

const ICONS: Record<StatusIconName, LucideIcon> = {
  CheckCircle,
  XCircle,
  Clock,
  FileEdit,
  Send,
  Eye,
  CheckCircle2,
  RotateCcw,
};

export function getStatusIcon(name: StatusIconName): LucideIcon {
  return ICONS[name];
}
