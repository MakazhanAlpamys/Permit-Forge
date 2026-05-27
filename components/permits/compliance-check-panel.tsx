'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ShieldCheck, ShieldAlert, ShieldQuestion, ChevronDown, ChevronUp } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ComplianceCheckResult, ComplianceCheckItem } from '@/types';

interface ComplianceCheckPanelProps {
  result: ComplianceCheckResult;
}

const statusConfig = {
  compliant: {
    icon: ShieldCheck,
    labelKey: 'permits.compliance.compliant',
    badgeClass: 'bg-violet-500/20 text-violet-400 border-violet-500/30',
    borderClass: 'border-violet-500/30',
  },
  non_compliant: {
    icon: ShieldAlert,
    labelKey: 'permits.compliance.non_compliant',
    badgeClass: 'bg-red-500/20 text-red-400 border-red-500/30',
    borderClass: 'border-red-500/30',
  },
  requires_review: {
    icon: ShieldQuestion,
    labelKey: 'permits.compliance.requires_review',
    badgeClass: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
    borderClass: 'border-yellow-500/30',
  },
};

function CheckItem({ check }: { check: ComplianceCheckItem }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const config = statusConfig[check.status];
  const Icon = config.icon;

  return (
    <div className={`p-3 rounded-lg border ${config.borderClass} bg-card/50`}>
      <div
        className="flex items-center justify-between cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4" />
          <span className="text-sm font-medium">{check.category}</span>
          <Badge variant="outline" className={`text-xs ${config.badgeClass}`}>
            {t(config.labelKey)}
          </Badge>
        </div>
        {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
      </div>

      {expanded && (
        <div className="mt-3 space-y-2">
          <p className="text-sm text-muted-foreground">{check.details}</p>

          {check.codeReferences.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">{t('permits.compliance.codeReferences')}:</p>
              {check.codeReferences.map((ref, i) => (
                <div key={i} className="text-xs p-2 rounded bg-muted/50">
                  <span className="font-medium">{t('dashboard.chat.page', { page: ref.page })}{ref.section ? `, ${t('dashboard.chat.section', { section: ref.section })}` : ''}</span>
                  {ref.excerpt && (
                    <p className="text-muted-foreground mt-1 italic">&quot;{ref.excerpt}&quot;</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatCheckedAt(iso: string, locale: string): string {
  const tag = locale === 'kk' ? 'kk-KZ' : locale === 'ru' ? 'ru-RU' : 'en-US';
  try {
    return new Intl.DateTimeFormat(tag, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toISOString();
  }
}

export function ComplianceCheckPanel({ result }: ComplianceCheckPanelProps) {
  const { t, i18n } = useTranslation();
  const overallConfig = statusConfig[result.overallStatus];
  const OverallIcon = overallConfig.icon;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg flex items-center gap-2">
            <ShieldCheck className="h-5 w-5" />
            {t('permits.actions.runCompliance')}
          </CardTitle>
          <Badge variant="outline" className={overallConfig.badgeClass}>
            <OverallIcon className="h-3 w-3 mr-1" />
            {t(overallConfig.labelKey)}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">{result.summary}</p>

        <div className="space-y-2">
          {result.checks.map((check, i) => (
            <CheckItem key={i} check={check} />
          ))}
        </div>

        <p className="text-xs text-muted-foreground">
          {t('permits.compliance.checkedAt', { when: formatCheckedAt(result.checkedAt, i18n.resolvedLanguage || i18n.language || 'en') })}
        </p>
      </CardContent>
    </Card>
  );
}
