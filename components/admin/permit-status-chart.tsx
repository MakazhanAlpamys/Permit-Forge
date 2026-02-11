'use client';

// ============================================================================
// Permit Status Chart — Donut/Pie Chart
// ============================================================================

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ClipboardCheck, Loader2 } from 'lucide-react';
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
  { key: 'draft', label: 'Draft', color: '#6b7280' },
  { key: 'submitted', label: 'Submitted', color: '#eab308' },
  { key: 'underReview', label: 'Under Review', color: '#3b82f6' },
  { key: 'approved', label: 'Approved', color: '#7c3aed' },
  { key: 'rejected', label: 'Rejected', color: '#ef4444' },
  { key: 'revisionRequested', label: 'Revision', color: '#f97316' },
] as const;

export function PermitStatusChart({ data, loading }: PermitStatusChartProps) {
  const chartData = data
    ? STATUS_CONFIG
        .map((s) => ({
          name: s.label,
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
          Permit Status
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="h-[250px] flex items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        ) : chartData.length === 0 ? (
          <div className="h-[250px] flex items-center justify-center text-muted-foreground">
            No permit data
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
                  {chartData.map((entry, index) => (
                    <Cell key={index} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'hsl(var(--card))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: '8px',
                    fontSize: '12px',
                  }}
                  formatter={(value) => [`${value} permits`, '']}
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
                <p className="text-xs text-muted-foreground">Total</p>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
