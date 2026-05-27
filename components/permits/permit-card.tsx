'use client';

import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useTranslation } from 'react-i18next';
import { PermitStatusBadge } from './permit-status-badge';
import { PROJECT_TYPES } from '@/lib/constants';
import { MapPin, Building2, Trash2, ChevronRight } from 'lucide-react';
import { isOperationAllowed } from '@/lib/permit-state-machine';
import type { PermitApplication } from '@/types';

interface PermitCardProps {
  permit: PermitApplication;
  onView: (id: string) => void;
  onDelete?: (id: string) => void;
}

function formatDate(dateStr: string, locale: string, t: (k: string) => string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  const tag = locale === 'kk' ? 'kk-KZ' : locale === 'ru' ? 'ru-RU' : 'en-US';

  if (diffDays === 0) return t('common.today');
  if (diffDays === 1) return t('common.yesterday');
  if (diffDays < 7) {
    try {
      return new Intl.RelativeTimeFormat(tag, { numeric: 'auto' }).format(-diffDays, 'day');
    } catch {
      return `${diffDays}d ago`;
    }
  }
  try {
    return date.toLocaleDateString(tag, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return date.toLocaleDateString();
  }
}

export function PermitCard({ permit, onView, onDelete }: PermitCardProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage || i18n.language || 'en';
  const typeLabel = t(`permits.step1.type.${permit.projectType}`, {
    defaultValue: PROJECT_TYPES.find(x => x.value === permit.projectType)?.label || permit.projectType,
  });

  return (
    <Card
      className="cursor-pointer hover:bg-muted/50 transition-colors"
      onClick={() => onView(permit.id)}
    >
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <h3 className="font-semibold text-sm truncate">{permit.projectName}</h3>
              <PermitStatusBadge status={permit.status} />
            </div>

            <div className="flex items-center gap-4 text-xs text-muted-foreground mt-2">
              <span className="flex items-center gap-1">
                <Building2 className="h-3 w-3" />
                {typeLabel}
              </span>
              <span className="flex items-center gap-1">
                <MapPin className="h-3 w-3" />
                <span className="truncate max-w-[200px]">{permit.projectAddress}</span>
              </span>
            </div>

            <div className="text-xs text-muted-foreground mt-1">
              {t('permits.card.updatedOn')} {formatDate(permit.updatedAt, locale, t)}
              {permit.submittedAt && ` · ${t('permits.card.submittedOn')} ${formatDate(permit.submittedAt, locale, t)}`}
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            {/* A-M-2 / v1.7.0 Part A: client-side hint backed by the same
                state-machine rule the server action enforces. A future
                status transition rule change is now picked up here
                automatically. */}
            {isOperationAllowed(permit.status, 'delete') && onDelete && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-red-500"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(permit.id);
                }}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
