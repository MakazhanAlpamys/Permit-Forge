'use client';

// ============================================================================
// Document Usage Chart — Horizontal Bar Chart per Document
// ============================================================================

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Database, Loader2 } from 'lucide-react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts';
import { getDocumentById } from '@/lib/document-registry';
import type { DocumentUsageStat } from '@/actions/analytics';

interface DocumentUsageChartProps {
  data: DocumentUsageStat[];
  loading?: boolean;
}

const DOCUMENT_COLORS: Record<string, string> = {
  'dubai-building-code-2021': '#3b82f6',
  'code-of-safety': '#ef4444',
  'al-safat-green-building': '#7c3aed',
  'universal-design-code': '#a855f7',
  'sewerage-stormwater-guidelines': '#06b6d4',
};

const DEFAULT_COLOR = '#6b7280';

export function DocumentUsageChart({ data, loading }: DocumentUsageChartProps) {
  const chartData = data.map((d) => ({
    name: getDocumentById(d.documentName)?.shortName || d.documentName,
    chunks: d.chunkCount,
    pages: `pp. ${d.minPage}-${d.maxPage}`,
    id: d.documentName,
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Database className="h-5 w-5 text-primary" />
          Document Chunks
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="h-[250px] flex items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        ) : data.length === 0 ? (
          <div className="h-[250px] flex items-center justify-center text-muted-foreground">
            No documents ingested
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={250}>
            <BarChart
              data={chartData}
              layout="vertical"
              margin={{ top: 5, right: 30, left: 10, bottom: 5 }}
            >
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" horizontal={false} />
              <XAxis
                type="number"
                tick={{ fontSize: 11 }}
                className="fill-muted-foreground"
                allowDecimals={false}
              />
              <YAxis
                dataKey="name"
                type="category"
                tick={{ fontSize: 11 }}
                className="fill-muted-foreground"
                width={70}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'hsl(var(--card))',
                  border: '1px solid hsl(var(--border))',
                  borderRadius: '8px',
                  fontSize: '12px',
                }}
                formatter={(value) => [`${value} chunks`, 'Chunks']}
              />
              <Bar dataKey="chunks" radius={[0, 4, 4, 0]} barSize={24}>
                {chartData.map((entry) => (
                  <Cell
                    key={entry.id}
                    fill={DOCUMENT_COLORS[entry.id] || DEFAULT_COLOR}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}
