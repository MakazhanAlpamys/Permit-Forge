'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Bell, Check } from 'lucide-react';
import { getNotifications, markNotificationRead, markAllNotificationsRead } from '@/actions/notifications';
import { readCsrfCookie } from '@/lib/csrf-client';
import type { Notification, NotificationType } from '@/types';

const NOTIFICATION_COLORS: Record<NotificationType, string> = {
  permit_submitted: 'text-blue-400',
  permit_under_review: 'text-yellow-400',
  permit_approved: 'text-violet-400',
  permit_rejected: 'text-red-400',
  permit_revision_requested: 'text-orange-400',
};

function timeAgo(dateString: string, locale: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateString).getTime()) / 1000);
  const tag = locale === 'kk' ? 'kk-KZ' : locale;
  let rtf: Intl.RelativeTimeFormat;
  try {
    rtf = new Intl.RelativeTimeFormat(tag, { numeric: 'auto' });
  } catch {
    rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  }
  if (seconds < 60) return rtf.format(-Math.max(seconds, 1), 'second');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return rtf.format(-minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return rtf.format(-hours, 'hour');
  const days = Math.floor(hours / 24);
  return rtf.format(-days, 'day');
}

export function NotificationBell() {
  const { t, i18n } = useTranslation();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const csrfTokenRef = useRef<string | null>(null);
  // CP-D-2 (v1.2.0): per-id in-flight set so a triple-click on one
  // notification can't fire markNotificationRead three times in parallel
  // (each one would also try to undo the previous optimistic rollback).
  const markingInFlightRef = useRef<Set<string>>(new Set());
  const router = useRouter();

  const fetchNotifications = useCallback(async () => {
    try {
      const result = await getNotifications(20);
      if (!result.error) {
        setNotifications(result.data);
        setUnreadCount(result.unreadCount);
      }
    } catch {
      // Silent fail for polling
    }
  }, []);

  useEffect(() => {
    fetchNotifications();
    // Read the CSRF token straight from the (non-HttpOnly) cookie — no network
    // fetch that could fail and leave mark-as-read without a token.
    csrfTokenRef.current = readCsrfCookie();

    // X7: 30s base poll with ±5s jitter so a tab full of users opened at
    // the same time doesn't stampede the notifications endpoint at the
    // same instant. Reschedule recursively with setTimeout instead of a
    // setInterval so each tick re-randomizes.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      const jitterMs = 5_000;
      const delay = 30_000 + (Math.random() * 2 - 1) * jitterMs;
      timer = setTimeout(async () => {
        await fetchNotifications();
        schedule();
      }, delay);
    };
    schedule();

    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [fetchNotifications]);

  const handleMarkRead = async (notification: Notification) => {
    if (!notification.read) {
      // CP-D-2: short-circuit if a previous click for this notification is
      // still in flight. Without this, a rapid double-click optimistically
      // marks read twice, the second server response rolls the first one
      // back, and the badge ends up inconsistent.
      if (markingInFlightRef.current.has(notification.id)) {
        // Still navigate — see below comment about decoupling read-flag from nav.
      } else {
        markingInFlightRef.current.add(notification.id);

        // Snapshot pre-mutation state so we can roll back if the server rejects.
        const prevNotifications = notifications;
        const prevUnreadCount = unreadCount;

        // Optimistic local update — bell badge updates immediately.
        setNotifications(prev =>
          prev.map(n => n.id === notification.id ? { ...n, read: true } : n)
        );
        setUnreadCount(prev => Math.max(0, prev - 1));

        try {
          const result = await markNotificationRead(notification.id, csrfTokenRef.current || '');
          if (!result.success) {
            // Roll back — server refused (CSRF, auth, DB) and the badge would
            // otherwise stay incorrect until the next 30 s poll.
            setNotifications(prevNotifications);
            setUnreadCount(prevUnreadCount);
          }
        } finally {
          markingInFlightRef.current.delete(notification.id);
        }
      }
    }

    // Navigate to permit regardless of mark-read outcome — the click signaled
    // intent to view; a failed read flag is a separate concern surfaced by
    // the rolled-back badge.
    const permitId = notification.data?.permitId as string;
    if (permitId) {
      setIsOpen(false);
      router.push(`/permits/${permitId}`);
    }
  };

  const handleMarkAllRead = async () => {
    setLoading(true);
    const prevNotifications = notifications;
    const prevUnreadCount = unreadCount;

    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
    setUnreadCount(0);

    const result = await markAllNotificationsRead(csrfTokenRef.current || '');
    if (!result.success) {
      setNotifications(prevNotifications);
      setUnreadCount(prevUnreadCount);
    }
    setLoading(false);
  };

  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="icon"
        className="text-muted-foreground relative"
        onClick={() => setIsOpen(!isOpen)}
      >
        <Bell className="h-5 w-5" />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 h-4 w-4 rounded-full bg-red-500 text-[10px] font-bold text-white flex items-center justify-center">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </Button>

      {isOpen && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => setIsOpen(false)}
          />

          {/* Dropdown */}
          <div className="absolute right-0 top-full mt-2 w-80 max-h-96 z-50 rounded-lg border border-border bg-card shadow-lg overflow-hidden">
            <div className="flex items-center justify-between p-3 border-b border-border">
              <h3 className="text-sm font-medium">{t('notifications.title')}</h3>
              {unreadCount > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={handleMarkAllRead}
                  disabled={loading}
                >
                  <Check className="h-3 w-3 mr-1" />
                  {t('notifications.markAllRead')}
                </Button>
              )}
            </div>

            <div className="overflow-y-auto max-h-72">
              {notifications.length === 0 ? (
                <div className="p-6 text-center text-sm text-muted-foreground">
                  {t('notifications.empty')}
                </div>
              ) : (
                notifications.map(notification => (
                  <button
                    key={notification.id}
                    className={`w-full text-left p-3 border-b border-border/50 hover:bg-muted/50 transition-colors ${
                      !notification.read ? 'bg-primary/5' : ''
                    }`}
                    onClick={() => handleMarkRead(notification)}
                  >
                    <div className="flex items-start gap-2">
                      <span className={`text-xs font-medium mt-0.5 ${NOTIFICATION_COLORS[notification.type]}`}>
                        {t(`notifications.types.${notification.type}`)}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className={`text-sm ${!notification.read ? 'font-medium' : ''}`}>
                          {notification.title}
                        </p>
                        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                          {notification.body}
                        </p>
                        <p className="text-xs text-muted-foreground/70 mt-1">
                          {timeAgo(notification.createdAt, i18n.resolvedLanguage || i18n.language || 'en')}
                        </p>
                      </div>
                      {!notification.read && (
                        <span className="h-2 w-2 rounded-full bg-primary mt-1.5 shrink-0" />
                      )}
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
