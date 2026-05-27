'use client';

import { Badge } from '@/components/ui/badge';
import { useTranslation } from 'react-i18next';
import { permitStatusConfig } from '@/lib/constants';
import { getStatusIcon } from '@/lib/status-icons';
import type { PermitStatus } from '@/types';

interface PermitStatusBadgeProps {
  status: PermitStatus;
  className?: string;
}

export function PermitStatusBadge({ status, className = '' }: PermitStatusBadgeProps) {
  const { t } = useTranslation();
  const config = permitStatusConfig[status];
  if (!config) return null;

  const Icon = getStatusIcon(config.iconName);

  return (
    <Badge variant="outline" className={`${config.badgeClassName} ${className}`}>
      <Icon className="h-3 w-3 mr-1" />
      {t(`permits.status.${status}`, { defaultValue: config.label })}
    </Badge>
  );
}
