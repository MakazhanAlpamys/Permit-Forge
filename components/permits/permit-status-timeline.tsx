'use client';

import { permitStatusConfig } from '@/lib/constants';
import { getStatusIcon } from '@/lib/status-icons';
import { useTranslation } from 'react-i18next';
import type { PermitStatusHistoryEntry, PermitStatus } from '@/types';

interface PermitStatusTimelineProps {
  history: PermitStatusHistoryEntry[];
}

function formatTime(dateStr: string, locale: string): string {
  const date = new Date(dateStr);
  const tag = locale === 'kk' ? 'kk-KZ' : locale === 'ru' ? 'ru-RU' : 'en-US';
  try {
    return date.toLocaleString(tag, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return date.toISOString();
  }
}

export function PermitStatusTimeline({ history }: PermitStatusTimelineProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage || i18n.language || 'en';
  if (history.length === 0) return null;

  return (
    <div className="space-y-0">
      {history.map((entry, index) => {
        const status = entry.toStatus as PermitStatus;
        const config = permitStatusConfig[status];
        const Icon = config ? getStatusIcon(config.iconName) : null;
        const isLast = index === history.length - 1;
        const label = t(`permits.status.${status}`, { defaultValue: config?.label || entry.toStatus });

        return (
          <div key={entry.id} className="flex gap-3">
            {/* Timeline line + dot */}
            <div className="flex flex-col items-center">
              <div className={`flex items-center justify-center h-8 w-8 rounded-full border-2 ${
                isLast ? 'border-primary bg-primary/10' : 'border-muted bg-muted'
              }`}>
                {Icon && <Icon className={`h-3.5 w-3.5 ${isLast ? 'text-primary' : 'text-muted-foreground'}`} />}
              </div>
              {index < history.length - 1 && (
                <div className="w-0.5 h-8 bg-muted" />
              )}
            </div>

            {/* Content */}
            <div className="pb-6">
              <p className="text-sm font-medium">
                {label}
              </p>
              {entry.comment && (
                <p className="text-xs text-muted-foreground mt-0.5">{entry.comment}</p>
              )}
              <p className="text-xs text-muted-foreground mt-0.5">
                {formatTime(entry.createdAt, locale)}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
