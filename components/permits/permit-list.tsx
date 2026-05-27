'use client';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PermitCard } from './permit-card';
import { Button } from '@/components/ui/button';
import { ClipboardList } from 'lucide-react';
import type { PermitApplication, PermitStatus } from '@/types';
import { PERMIT_STATUS_FILTERS } from '@/lib/constants';

interface PermitListProps {
  permits: PermitApplication[];
  loading: boolean;
  onView: (id: string) => void;
  onDelete: (id: string) => void;
}

export function PermitList({ permits, loading, onView, onDelete }: PermitListProps) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<PermitStatus | 'all'>('all');

  const filterLabel = (value: string, fallback: string): string => {
    const map: Record<string, string> = {
      all: 'permits.list.filterAll',
      draft: 'permits.list.filterDraft',
      submitted: 'permits.list.filterSubmitted',
      under_review: 'permits.list.filterUnderReview',
      approved: 'permits.list.filterApproved',
      rejected: 'permits.list.filterRejected',
      revision_requested: 'permits.list.filterRevisionRequested',
    };
    return t(map[value] ?? '', { defaultValue: fallback });
  };

  const filteredPermits = filter === 'all'
    ? permits
    : permits.filter(p => p.status === filter);

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map(i => (
          <div key={i} className="h-24 rounded-lg bg-muted animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div>
      {/* Status filter pills */}
      <div className="flex flex-wrap gap-2 mb-4">
        {PERMIT_STATUS_FILTERS.map(sf => (
          <Button
            key={sf.value}
            variant={filter === sf.value ? 'default' : 'outline'}
            size="sm"
            onClick={() => setFilter(sf.value)}
            className="text-xs"
          >
            {filterLabel(sf.value, sf.label)}
            {sf.value !== 'all' && (
              <span className="ml-1 opacity-60">
                ({permits.filter(p => p.status === sf.value).length})
              </span>
            )}
          </Button>
        ))}
      </div>

      {/* Permit cards */}
      {filteredPermits.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
          <ClipboardList className="h-12 w-12 mb-3 opacity-30" />
          <p className="text-sm">
            {t('permits.list.empty')}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredPermits.map(permit => (
            <PermitCard
              key={permit.id}
              permit={permit}
              onView={onView}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}
