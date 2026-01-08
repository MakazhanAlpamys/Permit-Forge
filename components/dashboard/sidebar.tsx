'use client';

// ============================================================================
// Sidebar Component with Chat History
// ============================================================================

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { getChatSessions, deleteChatSession } from '@/actions/chat-history';
import type { ChatSession } from '@/types';
import { 
  MessageSquare, 
  BookOpen,
  ChevronRight,
  ExternalLink,
  Trash2,
  Plus
} from 'lucide-react';

interface SidebarProps {
  isOpen?: boolean;
  onClose?: () => void;
  currentSessionId?: string | null;
  onNewChat?: () => void;
  onSelectSession?: (sessionId: string) => void;
}

// Navigation items
const navItems = [
  {
    title: 'Chat',
    href: '/',
    icon: MessageSquare,
    description: 'AI compliance assistant',
  },
];

// Helper function to format time ago
function formatTimeAgo(date: Date): string {
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 7) {
    return date.toLocaleDateString();
  } else if (days > 0) {
    return `${days}d ago`;
  } else if (hours > 0) {
    return `${hours}h ago`;
  } else if (minutes > 0) {
    return `${minutes}m ago`;
  } else {
    return 'Just now';
  }
}

export function Sidebar({ isOpen, onClose, currentSessionId, onNewChat, onSelectSession }: SidebarProps) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [sessionToDelete, setSessionToDelete] = useState<string | null>(null);
  const pathname = usePathname();

  // Load chat sessions
  useEffect(() => {
    loadSessions();
  }, []);

  // Reload when new session is created
  useEffect(() => {
    if (currentSessionId) {
      loadSessions();
    }
  }, [currentSessionId]);

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

  const confirmDelete = async () => {
    if (!sessionToDelete) return;
    
    const result = await deleteChatSession(sessionToDelete);
    if (result.success) {
      setSessions(prev => prev.filter(s => s.id !== sessionToDelete));
      if (currentSessionId === sessionToDelete && onNewChat) {
        onNewChat();
      }
    }
    setDeleteDialogOpen(false);
    setSessionToDelete(null);
  };

  const cancelDelete = () => {
    setDeleteDialogOpen(false);
    setSessionToDelete(null);
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
          <div className="px-3 space-y-6">
            {/* Main Navigation */}
            <div>
              <h3 className="px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                Main
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
                New Chat
              </Button>
            </div>

            <Separator />

            {/* Chat History */}
            <div className="flex-1 min-h-0">
              <h3 className="px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                Chat History
              </h3>
              {loading ? (
                <div className="px-3 py-4 text-sm text-muted-foreground">
                  Loading...
                </div>
              ) : sessions.length === 0 ? (
                <div className="px-3 py-4 text-sm text-muted-foreground">
                  No chat history yet
                </div>
              ) : (
                <ScrollArea className="h-[calc(100vh-550px)]">
                  <nav className="space-y-1 pr-3">
                    {sessions.map((session) => {
                      const isActive = currentSessionId === session.id;
                      const date = new Date(session.updated_at);
                      const timeAgo = formatTimeAgo(date);
                      
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
            </div>

            <Separator />

            {/* Resources */}
            <div>
              <h3 className="px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                Resources
              </h3>
              <nav className="space-y-1">
                <Button
                  variant="ghost"
                  className="w-full justify-start gap-3 h-auto py-2 px-3 text-muted-foreground hover:text-foreground"
                  asChild
                >
                  <a 
                    href="https://dm.gov.ae/wp-content/uploads/2021/12/Dubai%20Building%20Code_English_2021%20Edition_compressed.pdf" 
                    target="_blank" 
                    rel="noopener noreferrer"
                  >
                    <BookOpen className="h-4 w-4" />
                    <span className="text-sm flex-1">Dubai Building Code</span>
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </Button>
              </nav>
            </div>
          </div>

          {/* Footer */}
          <div className="absolute bottom-0 left-0 right-0 p-4 border-t border-border bg-card">
            <div className="text-xs text-muted-foreground">
              <p>Dubai Building Code 2021</p>
              <p className="mt-1">Powered by Gemini AI</p>
            </div>
          </div>
        </ScrollArea>
      </aside>

      {/* Delete Confirmation Dialog */}
      {deleteDialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="bg-card border border-border rounded-lg p-6 max-w-sm w-full mx-4 shadow-lg">
            <h3 className="text-lg font-semibold mb-2">Delete Chat</h3>
            <p className="text-sm text-muted-foreground mb-6">
              Are you sure you want to delete this chat? This action cannot be undone.
            </p>
            <div className="flex gap-3 justify-end">
              <Button variant="outline" onClick={cancelDelete}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={confirmDelete}>
                Delete
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
