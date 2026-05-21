'use client';

// ============================================================================
// Chat Interface Component with Streaming Support
// ============================================================================

import { useState, useRef, useEffect, useCallback } from 'react';
import { createChatSession, saveMessageToSession, getSessionMessages } from '@/actions/chat-history';
import { getCSRFTokenAction } from '@/actions/auth';
import { useChatStream } from '@/hooks/use-chat-stream';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { MessageBubble, LoadingMessage, StreamingMessage } from './message-bubble';
import { 
  Send,
  Sparkles,
  RotateCcw,
  Square,
  ChevronUp,
  Loader2,
  Download
} from 'lucide-react';
import type { ChatMessage, Citation } from '@/types';
import { MAX_MESSAGE_LENGTH } from '@/lib/constants';

// ============================================================================
// Anti-Spam Configuration
// ============================================================================

const MIN_REQUEST_INTERVAL = 2000; // 2 seconds between requests

// ============================================================================
// Main Chat Interface
// ============================================================================

interface ChatInterfaceProps {
  sessionId?: string | null;
  onSessionCreated?: (sessionId: string | null) => void;
}

export function ChatInterface({ sessionId, onSessionCreated }: ChatInterfaceProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [cooldown, setCooldown] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [isVerifyingSources, setIsVerifyingSources] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [messageCursor, setMessageCursor] = useState<string | undefined>(undefined);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  // B17: when the assistant message persists locally but the DB save fails,
  // the in-memory transcript is ahead of the stored session. Surface that drift
  // so the user knows reloading will reconcile (and that they shouldn't trust
  // the chat-export endpoint for the latest reply yet).
  const [saveSyncFailed, setSaveSyncFailed] = useState(false);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastRequestRef = useRef<number>(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const isMountedRef = useRef(true);
  const isCancelledRef = useRef(false);
  const csrfTokenRef = useRef<string | null>(null);
  const isInternalSessionCreateRef = useRef(false);
  const { streamMessage } = useChatStream();

  // Load messages when session changes
  useEffect(() => {
    if (sessionId) {
      // Skip reloading messages if this session was just created internally
      // (avoids race condition where DB reload overwrites locally-added messages)
      if (isInternalSessionCreateRef.current) {
        isInternalSessionCreateRef.current = false;
        setCurrentSessionId(sessionId);
      } else {
        // Switching to a different session — abort any in-flight stream from
        // the previous session, otherwise its setMessages will race with the
        // loadSessionMessages call below and mix messages across sessions.
        if (abortControllerRef.current) {
          abortControllerRef.current.abort();
          abortControllerRef.current = null;
        }
        isCancelledRef.current = true;
        setIsLoading(false);
        setIsStreaming(false);
        setStreamingContent('');
        setIsVerifyingSources(false);
        // B17: switching session refetches from DB, which is the reconcile step.
        setSaveSyncFailed(false);
        loadSessionMessages(sessionId);
        setCurrentSessionId(sessionId);
      }
    } else {
      // "New Chat" — abort any ongoing stream and reset all state
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      isCancelledRef.current = true;
      setMessages([]);
      setCurrentSessionId(null);
      setIsLoading(false);
      setIsStreaming(false);
      setStreamingContent('');
      setIsVerifyingSources(false);
      setHasMoreMessages(false);
      setMessageCursor(undefined);
      setSaveSyncFailed(false);
    }
  }, [sessionId]);

  const loadSessionMessages = async (sid: string) => {
    const result = await getSessionMessages(sid);
    setMessages(result.messages);
    setHasMoreMessages(result.hasMore);
    setMessageCursor(result.nextCursor);
  };

  const loadEarlierMessages = async () => {
    if (!currentSessionId || !hasMoreMessages || isLoadingMore) return;
    setIsLoadingMore(true);

    // Save scroll position to restore after prepending
    const scrollContainer = scrollAreaRef.current?.querySelector('[data-radix-scroll-area-viewport]');
    const prevScrollHeight = scrollContainer?.scrollHeight || 0;

    try {
      const result = await getSessionMessages(currentSessionId, messageCursor);
      if (result.messages.length > 0) {
        setMessages(prev => [...result.messages, ...prev]);
        setHasMoreMessages(result.hasMore);
        setMessageCursor(result.nextCursor);

        // Restore scroll position so view doesn't jump
        requestAnimationFrame(() => {
          if (scrollContainer) {
            scrollContainer.scrollTop = scrollContainer.scrollHeight - prevScrollHeight;
          }
        });
      }
    } catch (err) {
      console.error('Failed to load earlier messages:', err);
    } finally {
      setIsLoadingMore(false);
    }
  };

  // Fetch CSRF token on mount
  useEffect(() => {
    getCSRFTokenAction().then(token => { csrfTokenRef.current = token; });
  }, []);

  // Cleanup on unmount - properly abort any pending requests
  useEffect(() => {
    isMountedRef.current = true;
    
    // Store a reference to clean up on unmount
    const cleanupAbortController = () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
    };
    
    return () => {
      isMountedRef.current = false;
      cleanupAbortController();
    };
  }, []);

  // Auto-scroll to bottom when new messages arrive
  const scrollToBottom = useCallback(() => {
    if (scrollAreaRef.current) {
      const scrollContainer = scrollAreaRef.current.querySelector('[data-radix-scroll-area-viewport]');
      if (scrollContainer) {
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
      }
    }
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, isLoading, isStreaming, streamingContent, isVerifyingSources, scrollToBottom]);

  // Handle sending a message with streaming
  const handleSendMessage = async (messageText?: string) => {
    const text = (messageText || inputValue).trim().slice(0, MAX_MESSAGE_LENGTH);
    
    // Prevent empty or duplicate requests
    if (!text || isLoading || isStreaming || cooldown) return;

    // Rate limiting check
    const now = Date.now();
    if (now - lastRequestRef.current < MIN_REQUEST_INTERVAL) {
      setCooldown(true);
      setTimeout(() => setCooldown(false), MIN_REQUEST_INTERVAL);
      return;
    }
    lastRequestRef.current = now;

    // Cancel any pending request and clean up previous controller
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    
    // Create new AbortController for this request
    const controller = new AbortController();
    abortControllerRef.current = controller;
    isCancelledRef.current = false;

    // Create or use existing session
    let activeSessionId = currentSessionId;
    if (!activeSessionId) {
      const { sessionId: newSessionId } = await createChatSession(text.substring(0, 50));
      if (!newSessionId) {
        // Session creation failed — abort streaming to avoid a detached request
        setIsLoading(false);
        return;
      }
      activeSessionId = newSessionId;
      setCurrentSessionId(newSessionId);
      if (onSessionCreated) {
        isInternalSessionCreateRef.current = true;
        onSessionCreated(newSessionId);
      }
    }

    // Create user message
    const userMessage: ChatMessage = {
      id: `user-${now}`,
      role: 'user',
      content: text,
      timestamp: new Date(),
    };

    setMessages(prev => [...prev, userMessage]);
    setInputValue('');
    setIsLoading(true);
    setStreamingContent('');

    // Save user message to database
    if (activeSessionId) {
      await saveMessageToSession({
        sessionId: activeSessionId,
        role: 'user',
        content: text,
      });
    }

    // Switch to streaming mode and hand the work to the hook.
    setIsLoading(false);
    setIsStreaming(true);

    let finalContent = '';
    let finalCitations: Citation[] = [];
    let streamErrored = false;

    await streamMessage(
      { message: text, sessionId: activeSessionId },
      {
        csrfToken: csrfTokenRef.current,
        signal: controller.signal,
        isCancelled: () => isCancelledRef.current,
        callbacks: {
          onContent: (content) => {
            if (isMountedRef.current) setStreamingContent(content);
          },
          onTextDone: () => {
            if (isMountedRef.current && !isCancelledRef.current) {
              setIsVerifyingSources(true);
            }
          },
          onComplete: ({ content, citations }) => {
            finalContent = content;
            finalCitations = citations;
            if (isMountedRef.current) setIsVerifyingSources(false);
          },
          onError: (error) => {
            streamErrored = true;
            if (!isMountedRef.current) return;
            const errorMessage: ChatMessage = {
              id: `error-${Date.now()}`,
              role: 'assistant',
              content: 'Sorry, I encountered an error while processing your request. Please try again.',
              timestamp: new Date(),
              complianceStatus: 'pending',
            };
            setMessages((prev) => [...prev, errorMessage]);
            console.error('Chat error:', error);
          },
          onAbort: () => {
            // Cancellation; the UI cleanup is handled in the finally block below.
          },
        },
      },
    );

    if (!isMountedRef.current) {
      return;
    }

    if (!streamErrored && !isCancelledRef.current) {
      const assistantMessage: ChatMessage = {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: finalContent,
        citations: finalCitations,
        complianceStatus: 'pending',
        timestamp: new Date(),
      };

      setMessages((prev) => [...prev, assistantMessage]);
      setStreamingContent('');

      // B17: persist the assistant reply best-effort. If the save throws or
      // returns success:false, the on-screen transcript is ahead of the DB.
      if (activeSessionId) {
        try {
          const saveResult = await saveMessageToSession({
            sessionId: activeSessionId,
            role: 'assistant',
            content: finalContent,
            citations: finalCitations,
            complianceStatus: 'pending',
          });
          if (!saveResult.success && isMountedRef.current) {
            setSaveSyncFailed(true);
          }
        } catch (saveError) {
          console.error('Failed to save assistant message:', saveError);
          if (isMountedRef.current) {
            setSaveSyncFailed(true);
          }
        }
      }
    }

    if (isMountedRef.current) {
      setIsLoading(false);
      setIsStreaming(false);
      setIsVerifyingSources(false);
      setStreamingContent('');
    }
  };

  // Handle stop generation
  const handleStopGeneration = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      isCancelledRef.current = true;
      setIsLoading(false);
      setIsStreaming(false);
      setIsVerifyingSources(false);
      setStreamingContent('');
    }
  };

  // Handle keyboard shortcuts
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  // Clear chat — equivalent to clicking "New Chat"
  const handleClearChat = () => {
    // Abort any ongoing stream
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    isCancelledRef.current = true;
    setMessages([]);
    setCurrentSessionId(null);
    setIsLoading(false);
    setIsStreaming(false);
    setStreamingContent('');
    setIsVerifyingSources(false);
    if (onSessionCreated) {
      onSessionCreated(null);
    }
  };

  // Handle selecting an example question
  const handleSelectQuestion = (question: string) => {
    setInputValue(question);
    textareaRef.current?.focus();
  };

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Chat Messages Area - Maximum height for more chat space */}
      <ScrollArea ref={scrollAreaRef} className="h-[calc(100vh-200px)] px-4 py-4">
        {messages.length === 0 && !isLoading && !isStreaming ? (
          <EmptyState onSelectQuestion={handleSelectQuestion} />
        ) : (
          <div className="space-y-6 max-w-3xl mx-auto">
            {hasMoreMessages && (
              <div className="flex justify-center pt-2 pb-4">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={loadEarlierMessages}
                  disabled={isLoadingMore}
                  className="text-xs text-muted-foreground"
                >
                  {isLoadingMore ? (
                    <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                  ) : (
                    <ChevronUp className="h-3 w-3 mr-1" />
                  )}
                  Load earlier messages
                </Button>
              </div>
            )}
            {messages.map(message => (
              <MessageBubble key={message.id} message={message} />
            ))}
            {isLoading && <LoadingMessage />}
            {isStreaming && streamingContent && (
              <StreamingMessage content={streamingContent} isComplete={false} />
            )}
            {isVerifyingSources && (
              <div className="flex items-center gap-2 px-4 py-2 text-xs text-muted-foreground animate-pulse">
                <div className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-violet-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-violet-500"></span>
                </div>
                Verifying sources...
              </div>
            )}
          </div>
        )}
      </ScrollArea>

      {/* B17: surface drift between in-memory transcript and the DB session.
          Refreshing the page or switching sessions will refetch from DB. */}
      {saveSyncFailed && (
        <div className="border-t border-yellow-500/30 bg-yellow-500/10 text-yellow-700 px-4 py-2 text-xs text-center">
          Save failed — last reply isn&apos;t synced. Refresh to reconcile this session.
        </div>
      )}

      {/* Input Area */}
      <div className="border-t border-border bg-card/50 p-4">
        <div className="max-w-3xl mx-auto">
          {/* Action Buttons (when messages exist) */}
          {messages.length > 0 && !isLoading && !isStreaming && (
            <div className="flex justify-center gap-2 mb-3">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleClearChat}
                className="text-xs text-muted-foreground"
              >
                <RotateCcw className="h-3 w-3 mr-1" />
                Clear Chat
              </Button>
              {currentSessionId && (
                // X10: Export pulls messages from the DB. If clicked while the
                // very first message is still being saved (or while a stream
                // is in flight), the user gets a partial export. Gate the
                // button on streaming state + on having at least one finalised
                // message in the transcript.
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={isLoading || isStreaming || messages.length === 0}
                  onClick={() => {
                    window.open(`/api/chat/export?sessionId=${currentSessionId}`, '_blank');
                  }}
                  className="text-xs text-muted-foreground"
                  title={
                    isLoading || isStreaming
                      ? 'Wait for the current response to finish'
                      : messages.length === 0
                        ? 'Send at least one message to export'
                        : undefined
                  }
                >
                  <Download className="h-3 w-3 mr-1" />
                  Export
                </Button>
              )}
            </div>
          )}

          {/* Input Form */}
          <div className="relative flex items-end gap-2">
            <div className="relative flex-1">
              <Textarea
                ref={textareaRef}
                value={inputValue}
                onChange={e => setInputValue(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask about building code compliance..."
                className="min-h-[52px] max-h-[200px] pr-12 resize-none bg-background"
                rows={1}
                disabled={isLoading || isStreaming}
              />
              {(isLoading || isStreaming) ? (
                <Button
                  onClick={handleStopGeneration}
                  size="icon"
                  variant="destructive"
                  className="absolute right-2 bottom-2 h-8 w-8"
                  title="Stop generation"
                >
                  <Square className="h-4 w-4" />
                </Button>
              ) : (
                <Button
                  onClick={() => handleSendMessage()}
                  disabled={!inputValue.trim()}
                  size="icon"
                  className="absolute right-2 bottom-2 h-8 w-8"
                >
                  <Send className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>

          {/* Disclaimer - minimal spacing for maximum chat area */}
          <p className="text-xs text-muted-foreground text-center mt-2 mb-1">
            PermitForge provides guidance based on your ingested building codes.
            Always verify with official authorities for final compliance decisions.
          </p>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Example Questions
// ============================================================================

const EXAMPLE_QUESTIONS = [
  {
    title: "Building Height",
    question: "How is the maximum allowable building height determined when specific plot-limitations are not defined in the Development Control Regulations (DCR)?",
    icon: "🏗️",
  },
  {
    title: "Window-to-Wall Ratio",
    question: "What are the specific constraints for Window-to-Wall Ratio (WWR) under the Elemental Method, and how does building orientation affect allowable glazing?",
    icon: "🪟",
  },
  {
    title: "Vertical Transportation",
    question: "Under what conditions is a performance-based Vertical Transportation design (Method 2) mandatory instead of the prescriptive Method 1?",
    icon: "🛗",
  },
  {
    title: "Seismic Requirements",
    question: "How does the building code modify the seismic hazard assessment of ASCE/SEI 7-16, and why is the 'two-thirds' factor excluded?",
    icon: "🌍",
  },
];

// ============================================================================
// Empty State Component with Example Questions
// ============================================================================

interface EmptyStateProps {
  onSelectQuestion: (question: string) => void;
}

function EmptyState({ onSelectQuestion }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center h-full min-h-[400px] text-center px-4">
      {/* Logo/Icon */}
      <div className="mb-6 p-4 rounded-full bg-gradient-to-br from-violet-500/20 to-blue-500/20 border border-violet-500/20">
        <Sparkles className="h-8 w-8 text-violet-500" />
      </div>

      {/* Title */}
      <h2 className="text-2xl font-semibold text-foreground mb-2">
        Building Code Assistant
      </h2>
      <p className="text-muted-foreground max-w-md mb-8">
        Ask me anything about building code compliance, parking requirements,
        fire safety, or other regulatory requirements.
      </p>

      {/* Example Questions Grid */}
      <div className="w-full max-w-2xl">
        <p className="text-sm text-muted-foreground mb-3">Try asking:</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {EXAMPLE_QUESTIONS.map((item, index) => (
            <button
              key={index}
              onClick={() => onSelectQuestion(item.question)}
              className="group flex items-start gap-3 p-4 rounded-xl border border-border bg-card/50 hover:bg-card hover:border-violet-500/50 hover:shadow-lg hover:shadow-violet-500/5 transition-all duration-200 text-left"
            >
              <span className="text-2xl">{item.icon}</span>
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm text-foreground group-hover:text-violet-500 transition-colors">
                  {item.title}
                </p>
                <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                  {item.question}
                </p>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
