'use client';

// ============================================================================
// Top Active Users Table
// ============================================================================

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Trophy, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TopActiveUser } from '@/actions/analytics';

interface TopUsersTableProps {
  data: TopActiveUser[];
  loading?: boolean;
}

function formatTimeAgo(dateStr: string, locale: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const tag = locale === 'kk' ? 'kk-KZ' : locale;

  let rtf: Intl.RelativeTimeFormat;
  try {
    rtf = new Intl.RelativeTimeFormat(tag, { numeric: 'auto' });
  } catch {
    rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  }
  if (diff < 60000) return rtf.format(0, 'second');
  if (diff < 3600000) return rtf.format(-Math.floor(diff / 60000), 'minute');
  if (diff < 86400000) return rtf.format(-Math.floor(diff / 3600000), 'hour');
  if (diff < 604800000) return rtf.format(-Math.floor(diff / 86400000), 'day');
  try {
    return date.toLocaleDateString(tag, { month: 'short', day: 'numeric' });
  } catch {
    return date.toLocaleDateString();
  }
}

const RANK_COLORS = ['text-yellow-500', 'text-gray-400', 'text-amber-600'];

export function TopUsersTable({ data, loading }: TopUsersTableProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage || i18n.language || 'en';
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Trophy className="h-5 w-5 text-yellow-500" />
          {t('admin.overview.topUsers')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="h-[200px] flex items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        ) : data.length === 0 ? (
          <div className="h-[200px] flex items-center justify-center text-muted-foreground">
            {t('common.none')}
          </div>
        ) : (
          <div className="space-y-3">
            {data.map((user, index) => (
              <div
                key={user.userId}
                className="flex items-center gap-3 p-2.5 rounded-lg border border-border bg-card/50 hover:bg-card transition-colors"
              >
                <span className={`text-lg font-bold w-6 text-center ${RANK_COLORS[index] || 'text-muted-foreground'}`}>
                  {index + 1}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">
                    {user.fullName || user.username}
                  </p>
                  {user.fullName && (
                    <p className="text-xs text-muted-foreground truncate">
                      @{user.username}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className="text-xs">
                    {user.messageCount} {t('admin.overview.messages')}
                  </Badge>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    {formatTimeAgo(user.lastActive, locale)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
