'use client';

// ============================================================================
// Admin Dashboard - Audit Logs Component
// ============================================================================

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useTranslation } from 'react-i18next';
import { ScrollArea } from '@/components/ui/scroll-area';
import { 
  History,
  LogIn,
  LogOut,
  UserPlus,
  UserX,
  Shield,
  Key,
  FileText,
  Trash2,
  AlertTriangle,
  Loader2
} from 'lucide-react';
import type { AuditLogEntry } from '@/actions/admin';

interface AuditLogsProps {
  logs: AuditLogEntry[];
  loading?: boolean;
}

const actionIcons: Record<string, React.ComponentType<{ className?: string }>> = {
  login_success: LogIn,
  login_failed: AlertTriangle,
  logout: LogOut,
  user_created: UserPlus,
  user_blocked: UserX,
  user_unblocked: UserPlus,
  role_changed: Shield,
  password_reset: Key,
  pdf_ingested: FileText,
  chunks_cleared: Trash2,
  session_deleted: Trash2,
};

const actionColors: Record<string, string> = {
  login_success: 'text-violet-600 dark:text-violet-300 bg-violet-500/10',
  login_failed: 'text-red-600 dark:text-red-300 bg-red-500/10',
  logout: 'text-gray-600 dark:text-gray-300 bg-gray-500/10',
  user_created: 'text-blue-600 dark:text-blue-300 bg-blue-500/10',
  user_blocked: 'text-red-600 dark:text-red-300 bg-red-500/10',
  user_unblocked: 'text-violet-600 dark:text-violet-300 bg-violet-500/10',
  role_changed: 'text-purple-600 dark:text-purple-300 bg-purple-500/10',
  password_reset: 'text-orange-600 dark:text-orange-300 bg-orange-500/10',
  pdf_ingested: 'text-cyan-600 dark:text-cyan-300 bg-cyan-500/10',
  chunks_cleared: 'text-red-600 dark:text-red-300 bg-red-500/10',
  session_deleted: 'text-gray-600 dark:text-gray-300 bg-gray-500/10',
};

export function AuditLogs({ logs, loading }: AuditLogsProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage || i18n.language || 'en';
  const tag = locale === 'kk' ? 'kk-KZ' : locale === 'ru' ? 'ru-RU' : 'en-US';
  const formatTime = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    if (diff < 60000) return t('common.today');
    if (diff < 3600000) return t('common.time.minutesAgo', { count: Math.floor(diff / 60000) });
    if (diff < 86400000) return t('common.time.hoursAgo', { count: Math.floor(diff / 3600000) });
    try {
      return date.toLocaleDateString(tag, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return date.toLocaleDateString();
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <History className="h-5 w-5 text-primary" />
          {t('admin.audit.title')}
        </CardTitle>
        <CardDescription>
          {t('admin.tabs.audit')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : logs.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            {t('admin.audit.noLogs')}
          </div>
        ) : (
          <ScrollArea className="h-[400px] pr-4">
            <div className="space-y-4">
              {logs.map((log) => {
                const IconComponent = actionIcons[log.action] || History;
                const colorClass = actionColors[log.action] || 'text-gray-500 bg-gray-500/10';
                const label = t(`admin.audit.events.${log.action}`, { defaultValue: log.action });
                
                return (
                  <div 
                    key={log.id} 
                    className="flex items-start gap-3 p-3 rounded-lg border border-border bg-card/50 hover:bg-card transition-colors"
                  >
                    <div className={`p-2 rounded-lg ${colorClass}`}>
                      <IconComponent className="h-4 w-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant="outline" className="text-xs">
                          {label}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {formatTime(log.createdAt)}
                        </span>
                      </div>
                      <p className="text-sm mt-1">
                        {log.username ? (
                          <span className="font-medium">{log.username}</span>
                        ) : (
                          <span className="text-muted-foreground">{t('common.notAvailable')}</span>
                        )}
                        {log.targetUsername && (
                          <>
                            <span className="text-muted-foreground"> → </span>
                            <span className="font-medium">{log.targetUsername}</span>
                          </>
                        )}
                      </p>
                      {log.metadata && Object.keys(log.metadata).length > 0 && (
                        <p className="text-xs text-muted-foreground mt-1 break-all line-clamp-2">
                          {JSON.stringify(log.metadata)}
                        </p>
                      )}
                      {log.ipAddress && (
                        <p className="text-xs text-muted-foreground mt-1 break-all">
                          {t('admin.audit.ipAddress')}: {log.ipAddress}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}
