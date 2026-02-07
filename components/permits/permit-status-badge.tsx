'use client';

import { Badge } from '@/components/ui/badge';
import { permitStatusConfig } from '@/lib/constants';
import type { PermitStatus } from '@/types';

interface PermitStatusBadgeProps {
  status: PermitStatus;
  className?: string;
}

export function PermitStatusBadge({ status, className = '' }: PermitStatusBadgeProps) {
  const config = permitStatusConfig[status];
  if (!config) return null;

  const Icon = config.icon;

  return (
    <Badge variant="outline" className={`${config.badgeClassName} ${className}`}>
      <Icon className="h-3 w-3 mr-1" />
      {config.label}
    </Badge>
  );
}
