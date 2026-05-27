'use client';

// ============================================================================
// Sidebar Component with Chat History
// ============================================================================

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { getChatSessions, deleteChatSession, searchChatHistory } from '@/actions/chat-history';
import { getCSRFTokenAction } from '@/actions/auth';
import { Input } from '@/components/ui/input';
import { ResultDialog } from '@/components/ui/confirm-dialog';
import { useServerAction } from '@/hooks/use-server-action';
import type { ChatSession } from '@/types';
import {
  MessageSquare,
  ChevronRight,
  Trash2,
  Plus,
  ClipboardList,
  Search,
  X,
  UserCircle,
  Loader2,
} from 'lucide-react';

interface SidebarProps {
  isOpen?: boolean;
  onClose?: () => void;
  currentSessionId?: string | null;
  /**
   * X1: bumped by the parent whenever a real session-list change happens
   * (create / delete). The sidebar refetches the list when this value changes
   * instead of refetching every time the *active* session id flips, which used
   * to fire on every chat-tab switch.
   */
  sessionsVersion?: number;
  onNewChat?: () => void;
  onSelectSession?: (sessionId: string) => void;
}

// Helper function to format time ago
function formatTimeAgo(date: Date, locale: string): string {
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  // Map our internal locale codes (e.g. "kk") to BCP 47 tags
  // accepted by Intl.RelativeTimeFormat. "kk" is fine as-is.
  const tag = locale === 'kk' ? 'kk-KZ' : locale;
  let rtf: Intl.RelativeTimeFormat;
  try {
    rtf = new Intl.RelativeTimeFormat(tag, { numeric: 'auto' });
  } catch {
    rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  }

  if (days > 7) {
    try {
      return date.toLocaleDateString(tag);
    } catch {
      return date.toLocaleDateString();
    }
  } else if (days > 0) {
    return rtf.format(-days, 'day');
  } else if (hours > 0) {
    return rtf.format(-hours, 'hour');
  } else if (minutes > 0) {
    return rtf.format(-minutes, 'minute');
  } else {
    return rtf.format(-Math.max(seconds, 1), 'second');
  }
}

export function Sidebar({ isOpen, onClose, currentSessionId, sessionsVersion = 0, onNewChat, onSelectSession }: SidebarProps) {
  const { t, i18n } = useTranslation();
  const navItems = [
    {
      title: t('dashboard.header.newChat'),
      href: '/',
      icon: MessageSquare,
      description: t('dashboard.chat.welcomeSubtitle'),
    },
    {
      title: t('dashboard.header.permits'),
      href: '/permits',
      icon: ClipboardList,
      description: t('permits.list.subtitle'),
    },
  ];
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [sessionToDelete, setSessionToDelete] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Array<{ sessionId: string; sessionTitle: string; snippet: string }>>([]);
  const [isSearching, setIsSearching] = useState(false);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const csrfTokenRef = useRef<string | null>(null);
  const pathname = usePathname();

  // X1: Load chat sessions on mount and whenever the parent bumps
  // `sessionsVersion` (i.e. a real session was created or deleted). Previously
  // this re-ran on every `currentSessionId` flip, including plain tab switches
  // between existing sessions, which caused an extra unnecessary DB roundtrip.
  useEffect(() => {
    loadSessions();
    // TS-M-2 / v1.6.0 Part F: catch + log CSRF fetch failure.
    getCSRFTokenAction()
      .then(token => { csrfTokenRef.current = token; })
      .catch(err => console.error('CSRF token fetch failed:', err));
  }, [sessionsVersion]);

  // Clear pending debounce timeout on unmount to prevent state updates on unmounted component
  useEffect(() => {
    return () => {
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    };
  }, []);

  const loadSessions = async () => {
    setLoading(true);
    const { sessions: data } = await getChatSessions();
    setSessions(data);
    setLoading(false);
  };

  const handleDeleteSession = async (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSessionToDelete(sessionId);
    setDeleteDialogOpen(true);
  };

  // CP-C-2/CP-C-3 (v1.2.0 Part A): wrap deleteChatSession so failures surface
  // as a visible error dialog instead of letting the confirm modal close
  // silently and leaving the stale session in the list.
  const deleteSessionAction = useServerAction(deleteChatSession, {
    fallbackErrorMessage: t('errors.generic'),
    onSuccess: () => {
      setSessions(prev => prev.filter(s => s.id !== sessionToDelete));
      if (currentSessionId === sessionToDelete && onNewChat) {
        onNewChat();
      }
      setDeleteDialogOpen(false);
      setSessionToDelete(null);
    },
  });

  const confirmDelete = async () => {
    if (!sessionToDelete) return;
    await deleteSessionAction.run(sessionToDelete, csrfTokenRef.current || '');
  };

  const cancelDelete = () => {
    if (deleteSessionAction.isLoading) return;
    setDeleteDialogOpen(false);
    setSessionToDelete(null);
  };

  // Debounced search
  const handleSearchChange = (value: string) => {
    setSearchQuery(value);
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);

    if (!value.trim()) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }

    setIsSearching(true);
    searchTimeoutRef.current = setTimeout(async () => {
      const { results } = await searchChatHistory(value);
      setSearchResults(results);
      setIsSearching(false);
    }, 300);
  };

  const clearSearch = () => {
    setSearchQuery('');
    setSearchResults([]);
    setIsSearching(false);
  };

  const handleNewChat = () => {
    if (onNewChat) onNewChat();
    if (onClose) onClose();
  };

  const handleSelectSession = (sessionId: string) => {
    if (onSelectSession) onSelectSession(sessionId);
    if (onClose) onClose();
  };

  return (
    <>
      {/* Mobile Overlay */}
      {isOpen && (
        <div 
          className="fixed inset-0 z-40 bg-background/80 backdrop-blur-sm lg:hidden"
          onClick={onClose}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`
          fixed top-14 z-40 h-[calc(100vh-3.5rem)] w-64 border-r border-border bg-card
          transition-transform duration-300 ease-in-out
          lg:translate-x-0 lg:static
          ${isOpen ? 'translate-x-0' : '-translate-x-full'}
        `}
      >
        <ScrollArea className="h-full py-4">
          <div className="px-3 space-y-6 pb-20">
            {/* Main Navigation */}
            <div>
              <h3 className="px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                {t('common.actions')}
              </h3>
              <nav className="space-y-1">
                {navItems.map((item) => {
                  const isActive = pathname === item.href;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={onClose}
                      className={`
                        flex items-center gap-3 px-3 py-2 rounded-lg text-sm
                        transition-colors
                        ${isActive 
                          ? 'bg-primary/10 text-primary' 
                          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                        }
                      `}
                    >
                      <item.icon className="h-4 w-4" />
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          {item.title}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {item.description}
                        </p>
                      </div>
                      {isActive && <ChevronRight className="h-4 w-4" />}
                    </Link>
                  );
                })}
              </nav>
            </div>

            <Separator />

            {/* New Chat Button */}
            <div className="px-3">
              <Button
                onClick={handleNewChat}
                className="w-full justify-start gap-2"
                variant="outline"
              >
                <Plus className="h-4 w-4" />
                {t('dashboard.sidebar.newChat')}
              </Button>
            </div>

            <Separator />

            {/* Chat Search */}
            <div className="px-3">
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  placeholder={t('common.search')}
                  value={searchQuery}
                  onChange={e => handleSearchChange(e.target.value)}
                  className="h-8 pl-8 pr-8 text-xs"
                />
                {searchQuery && (
                  <button onClick={clearSearch} className="absolute right-2.5 top-2.5">
                    <X className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
                  </button>
                )}
              </div>
            </div>

            {/* Search Results */}
            {searchQuery && (
              <div className="flex-1 min-h-0">
                <h3 className="px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                  {t('common.search')}
                </h3>
                {isSearching ? (
                  <div className="px-3 py-2 text-xs text-muted-foreground">{t('common.loading')}</div>
                ) : searchResults.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-muted-foreground">{t('dashboard.sidebar.noSessions')}</div>
                ) : (
                  <nav className="space-y-1 px-3">
                    {searchResults.map(r => (
                      <div
                        key={r.sessionId}
                        className="flex flex-col px-3 py-2 rounded-lg text-sm cursor-pointer text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                        onClick={() => handleSelectSession(r.sessionId)}
                      >
                        <p className="font-medium text-xs truncate">{r.sessionTitle}</p>
                        <p className="text-xs text-muted-foreground truncate">{r.snippet}</p>
                      </div>
                    ))}
                  </nav>
                )}
              </div>
            )}

            {/* Chat History */}
            {!searchQuery && <div className="flex-1 min-h-0">
              <h3 className="px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                {t('dashboard.sidebar.title')}
              </h3>
              {loading ? (
                <div className="px-3 py-4 text-sm text-muted-foreground">
                  {t('common.loading')}
                </div>
              ) : sessions.length === 0 ? (
                <div className="px-3 py-4 text-sm text-muted-foreground">
                  {t('dashboard.sidebar.noSessions')}
                </div>
              ) : (
                <ScrollArea className="h-[calc(100vh-550px)]">
                  <nav className="space-y-1 pr-3">
                    {sessions.map((session) => {
                      const isActive = currentSessionId === session.id;
                      const date = new Date(session.updated_at);
                      const timeAgo = formatTimeAgo(date, i18n.resolvedLanguage || i18n.language || 'en');
                      
                      return (
                        <div
                          key={session.id}
                          className={`
                            group relative flex items-center gap-2 px-3 py-2 rounded-lg text-sm
                            transition-colors cursor-pointer overflow-hidden
                            ${isActive 
                              ? 'bg-primary/10 text-primary' 
                              : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                            }
                          `}
                          onClick={() => handleSelectSession(session.id)}
                        >
                          <MessageSquare className="h-4 w-4 flex-shrink-0" />
                          <div className="flex-1 min-w-0 overflow-hidden">
                            <p className="truncate font-medium text-ellipsis overflow-hidden whitespace-nowrap max-w-[140px]">
                              {session.title}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {timeAgo}
                            </p>
                          </div>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
                            onClick={(e) => handleDeleteSession(session.id, e)}
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      );
                    })}
                  </nav>
                </ScrollArea>
              )}
            </div>}

            <Separator />

            {/* Resources */}
            <div>
              <h3 className="px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                {t('common.more')}
              </h3>
              <p className="px-3 text-sm text-muted-foreground italic">{t('common.comingSoon')}</p>
            </div>
          </div>

          {/* Profile Link */}
          <div className="absolute bottom-0 left-0 right-0 p-3 border-t border-border bg-card">
            <Link
              href="/profile"
              onClick={onClose}
              className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            >
              <UserCircle className="h-5 w-5" />
              <span className="font-medium">{t('dashboard.header.profile')}</span>
            </Link>
          </div>
        </ScrollArea>
      </aside>

      {/* Delete Confirmation Dialog */}
      {deleteDialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="bg-card border border-border rounded-lg p-6 max-w-sm w-full mx-4 shadow-lg">
            <h3 className="text-lg font-semibold mb-2">{t('dashboard.sidebar.deleteSession')}</h3>
            <p className="text-sm text-muted-foreground mb-6">
              {t('permits.detail.deleteConfirm')}
            </p>
            <div className="flex gap-3 justify-end">
              <Button
                variant="outline"
                onClick={cancelDelete}
                disabled={deleteSessionAction.isLoading}
              >
                {t('common.cancel')}
              </Button>
              <Button
                variant="destructive"
                onClick={confirmDelete}
                disabled={deleteSessionAction.isLoading}
              >
                {deleteSessionAction.isLoading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                {t('common.delete')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* CP-C-2/CP-C-3: visible error feedback on delete failure. */}
      <ResultDialog
        open={!!deleteSessionAction.error}
        onOpenChange={(open) => { if (!open) deleteSessionAction.clearError(); }}
        variant="error"
        message={deleteSessionAction.error}
      />
    </>
  );
}
