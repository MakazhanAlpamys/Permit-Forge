'use client';

// ============================================================================
// Enhanced Stats Cards with Trend Indicators
// ============================================================================

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useTranslation } from 'react-i18next';
import {
  Users,
  Activity,
  MessageSquare,
  ClipboardCheck,
  UserPlus,
  Database,
  TrendingUp,
  TrendingDown,
  Minus,
} from 'lucide-react';
import type { AnalyticsDashboardStats } from '@/actions/analytics';

interface EnhancedStatsCardsProps {
  stats: AnalyticsDashboardStats | null;
  loading?: boolean;
}

function getTrend(today: number, yesterday: number): { percent: number; direction: 'up' | 'down' | 'neutral' } {
  if (yesterday === 0 && today === 0) return { percent: 0, direction: 'neutral' };
  if (yesterday === 0) return { percent: 100, direction: 'up' };
  const percent = Math.round(((today - yesterday) / yesterday) * 100);
  if (percent > 0) return { percent, direction: 'up' };
  if (percent < 0) return { percent: Math.abs(percent), direction: 'down' };
  return { percent: 0, direction: 'neutral' };
}

function TrendBadge({ today, yesterday }: { today: number; yesterday: number }) {
  const { percent, direction } = getTrend(today, yesterday);

  if (direction === 'neutral') {
    return (
      <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-5 text-muted-foreground border-muted">
        <Minus className="h-3 w-3 mr-0.5" />
        0%
      </Badge>
    );
  }

  if (direction === 'up') {
    return (
      <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-5 text-violet-700 dark:text-violet-300 border-violet-500/30 bg-violet-500/10">
        <TrendingUp className="h-3 w-3 mr-0.5" />
        +{percent}%
      </Badge>
    );
  }

  return (
    <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-5 text-red-700 dark:text-red-300 border-red-500/30 bg-red-500/10">
      <TrendingDown className="h-3 w-3 mr-0.5" />
      -{percent}%
    </Badge>
  );
}

export function EnhancedStatsCards({ stats, loading }: EnhancedStatsCardsProps) {
  const { t } = useTranslation();
  const cards = [
    {
      title: t('admin.overview.totalUsers'),
      value: stats?.totalUsers ?? 0,
      icon: Users,
      color: 'text-blue-600 dark:text-blue-400',
      bgColor: 'bg-blue-500/10',
      hasTrend: false,
    },
    {
      title: t('admin.overview.activeUsers'),
      value: stats?.activeUsersToday ?? 0,
      icon: Activity,
      color: 'text-violet-600 dark:text-violet-400',
      bgColor: 'bg-violet-500/10',
      hasTrend: true,
      today: stats?.activeUsersToday ?? 0,
      yesterday: stats?.activeUsersYesterday ?? 0,
    },
    {
      title: t('admin.overview.totalMessages'),
      value: stats?.messagesToday ?? 0,
      icon: MessageSquare,
      color: 'text-purple-600 dark:text-purple-400',
      bgColor: 'bg-purple-500/10',
      hasTrend: true,
      today: stats?.messagesToday ?? 0,
      yesterday: stats?.messagesYesterday ?? 0,
    },
    {
      title: t('admin.overview.totalPermits'),
      value: stats?.permitsToday ?? 0,
      icon: ClipboardCheck,
      color: 'text-orange-600 dark:text-orange-400',
      bgColor: 'bg-orange-500/10',
      hasTrend: true,
      today: stats?.permitsToday ?? 0,
      yesterday: stats?.permitsYesterday ?? 0,
    },
    {
      title: t('admin.users.createUser'),
      value: stats?.newUsersToday ?? 0,
      icon: UserPlus,
      color: 'text-cyan-600 dark:text-cyan-400',
      bgColor: 'bg-cyan-500/10',
      hasTrend: true,
      today: stats?.newUsersToday ?? 0,
      yesterday: stats?.newUsersYesterday ?? 0,
    },
    {
      title: t('admin.overview.totalChunks'),
      value: stats?.totalChunks ?? 0,
      icon: Database,
      color: 'text-yellow-600 dark:text-yellow-400',
      bgColor: 'bg-yellow-500/10',
      hasTrend: false,
    },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-3 xl:grid-cols-6 gap-4">
      {cards.map((card) => (
        <Card key={card.title} className="relative overflow-hidden">
          <CardHeader className="flex flex-row items-center justify-between pb-2 gap-2">
            <CardTitle className="text-sm font-medium text-muted-foreground min-w-0 truncate">
              {card.title}
            </CardTitle>
            <div className={`p-2 rounded-lg shrink-0 ${card.bgColor}`}>
              <card.icon className={`h-4 w-4 ${card.color}`} />
            </div>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="h-8 w-20 bg-muted animate-pulse rounded" />
            ) : (
              <div className="space-y-1">
                <p className="text-2xl font-bold">
                  {card.value.toLocaleString()}
                </p>
                {card.hasTrend && (
                  <TrendBadge
                    today={card.today ?? 0}
                    yesterday={card.yesterday ?? 0}
                  />
                )}
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
