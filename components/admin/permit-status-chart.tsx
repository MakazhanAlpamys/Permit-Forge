'use client';

// ============================================================================
// Permit Status Chart — Donut/Pie Chart
// ============================================================================

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ClipboardCheck, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import type { PermitStatusBreakdown } from '@/actions/analytics';

interface PermitStatusChartProps {
  data: PermitStatusBreakdown | null;
  loading?: boolean;
}

const STATUS_CONFIG = [
  { key: 'draft', i18nKey: 'permits.status.draft', color: '#6b7280' },
  { key: 'submitted', i18nKey: 'permits.status.submitted', color: '#eab308' },
  { key: 'underReview', i18nKey: 'permits.status.under_review', color: '#3b82f6' },
  { key: 'approved', i18nKey: 'permits.status.approved', color: '#7c3aed' },
  { key: 'rejected', i18nKey: 'permits.status.rejected', color: '#ef4444' },
  { key: 'revisionRequested', i18nKey: 'permits.status.revision_requested', color: '#f97316' },
] as const;

export function PermitStatusChart({ data, loading }: PermitStatusChartProps) {
  const { t } = useTranslation();
  const chartData = data
    ? STATUS_CONFIG
        .map((s) => ({
          name: t(s.i18nKey),
          value: data[s.key] || 0,
          color: s.color,
        }))
        .filter((d) => d.value > 0)
    : [];

  const total = data?.total ?? 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ClipboardCheck className="h-5 w-5 text-primary" />
          {t('admin.overview.permitStatus')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="h-[250px] flex items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        ) : chartData.length === 0 ? (
          <div className="h-[250px] flex items-center justify-center text-muted-foreground">
            {t('common.none')}
          </div>
        ) : (
          <div className="relative">
            <ResponsiveContainer width="100%" height={250}>
              <PieChart>
                <Pie
                  data={chartData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={90}
                  paddingAngle={2}
                  dataKey="value"
                >
                  {chartData.map((entry) => (
                    <Cell key={entry.name} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'hsl(var(--card))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: '8px',
                    fontSize: '12px',
                  }}
                  formatter={(value) => [`${value}`, '']}
                />
                <Legend
                  wrapperStyle={{ fontSize: '11px' }}
                  formatter={(value: string) => (
                    <span className="text-muted-foreground">{value}</span>
                  )}
                />
              </PieChart>
            </ResponsiveContainer>
            {/* Center label */}
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none" style={{ marginBottom: '30px' }}>
              <div className="text-center">
                <p className="text-2xl font-bold">{total}</p>
                <p className="text-xs text-muted-foreground">{t('common.all')}</p>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
