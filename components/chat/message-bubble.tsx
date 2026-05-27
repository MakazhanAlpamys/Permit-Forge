'use client';

// ============================================================================
// Message Bubble Component
// ============================================================================

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { useTranslation } from 'react-i18next';
import { CitationsList } from './source-citation';
import { complianceStatusConfig } from '@/lib/constants';
import { getStatusIcon } from '@/lib/status-icons';
import { User, Bot, Copy, Check } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { useState, useCallback } from 'react';
import type { ChatMessage } from '@/types';

// XSS NOTE: DOMPurify is NOT applied before ReactMarkdown.
// ReactMarkdown (without rehype-raw) escapes raw HTML in markdown by default.
// Applying DOMPurify to the markdown source mangles valid markdown syntax (e.g. strips
// characters like > used in blockquotes, or < in text). Link URLs are sanitized via
// the custom `a` component below (http/https protocol allow-list).

interface MessageBubbleProps {
  message: ChatMessage;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const { t, i18n } = useTranslation();
  const isUser = message.role === 'user';
  const compliance = message.complianceStatus 
    ? complianceStatusConfig[message.complianceStatus] 
    : null;
  const [copied, setCopied] = useState(false);

  const displayContent = message.content;

  // Copy answer text to clipboard
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      console.error('Failed to copy text');
    }
  }, [message.content]);

  return (
    <div className={`flex gap-3 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
      {/* Avatar */}
      <Avatar className={`h-8 w-8 shrink-0 ${isUser ? 'bg-primary' : 'bg-violet-600'}`}>
        <AvatarFallback className={isUser ? 'bg-primary text-primary-foreground' : 'bg-violet-600 text-white'}>
          {isUser ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
        </AvatarFallback>
      </Avatar>

      {/* Message Content */}
      <div className={`flex-1 max-w-[85%] ${isUser ? 'items-end' : 'items-start'}`}>
        <div
          className={`rounded-2xl px-4 py-3 ${
            isUser
              ? 'bg-primary text-primary-foreground rounded-tr-sm'
              : 'bg-muted text-foreground rounded-tl-sm'
          }`}
        >
          {/* Compliance Badge for Assistant Messages */}
          {!isUser && compliance && message.complianceStatus !== 'pending' && (() => {
            const ComplianceIcon = getStatusIcon(compliance.iconName);
            return (
              <div className="mb-2">
                <Badge variant="outline" className={`${compliance.badgeClassName} text-xs`}>
                  <ComplianceIcon className="h-3 w-3 mr-1" />
                  {compliance.label}
                </Badge>
              </div>
            );
          })()}

          {/* Message Text */}
          <div className={`text-sm leading-relaxed ${isUser ? '' : 'prose prose-sm dark:prose-invert max-w-none'}`}>
            {isUser ? (
              <span className="whitespace-pre-wrap">{displayContent}</span>
            ) : (
              <ReactMarkdown
                components={{
                  // Customize markdown rendering
                  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                  ul: ({ children }) => <ul className="list-disc ml-4 mb-2">{children}</ul>,
                  ol: ({ children }) => <ol className="list-decimal ml-4 mb-2">{children}</ol>,
                  li: ({ children }) => <li className="mb-1">{children}</li>,
                  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
                  em: ({ children }) => <em className="italic">{children}</em>,
                  code: ({ children }) => <code className="bg-muted px-1 py-0.5 rounded text-xs">{children}</code>,
                  h1: ({ children }) => <h1 className="text-lg font-bold mb-2">{children}</h1>,
                  h2: ({ children }) => <h2 className="text-base font-semibold mb-2">{children}</h2>,
                  h3: ({ children }) => <h3 className="text-sm font-semibold mb-1">{children}</h3>,
                  // Sanitize links — only allow http: and https: protocols
                  a: ({ href, children }) => {
                    let safeHref = '#';
                    if (href) {
                      try {
                        const url = new URL(href, 'https://placeholder.invalid');
                        if (url.protocol === 'http:' || url.protocol === 'https:') {
                          safeHref = href;
                        }
                      } catch {
                        // Invalid URL — keep as '#'
                      }
                    }
                    return (
                      <a
                        href={safeHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline"
                      >
                        {children}
                      </a>
                    );
                  },
                }}
              >
                {displayContent}
              </ReactMarkdown>
            )}
          </div>

          {/* Copy button for assistant messages - inside the bubble at bottom */}
          {!isUser && (
            <div className="flex items-center justify-end mt-2 pt-2 border-t border-border/30">
              <button
                onClick={handleCopy}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded-md hover:bg-background/50"
                title={t('dashboard.chat.copy')}
              >
                {copied ? (
                  <>
                    <Check className="h-3.5 w-3.5 text-violet-500" />
                    <span className="text-violet-500">{t('dashboard.chat.copied')}</span>
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" />
                    <span>{t('dashboard.chat.copy')}</span>
                  </>
                )}
              </button>
            </div>
          )}
        </div>

        {/* Citations Section (only for assistant messages) */}
        {!isUser && message.citations && message.citations.length > 0 && (
          <CitationsList citations={message.citations} />
        )}

        {/* Timestamp */}
        <div className={`mt-1 text-xs text-muted-foreground ${isUser ? 'text-right' : 'text-left'}`}>
          {formatTimestamp(message.timestamp, i18n.resolvedLanguage || i18n.language || 'en')}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Helper Functions
// ============================================================================

function formatTimestamp(date: Date | string, locale: string): string {
  const tag = locale === 'kk' ? 'kk-KZ' : locale === 'ru' ? 'ru-RU' : 'en-US';
  try {
    return new Intl.DateTimeFormat(tag, {
      hour: 'numeric',
      minute: 'numeric',
    }).format(new Date(date));
  } catch {
    return new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: 'numeric',
      hour12: true,
    }).format(new Date(date));
  }
}

// ============================================================================
// Loading Message Component - Premium Skeleton Style
// ============================================================================

export function LoadingMessage() {
  const { t } = useTranslation();
  return (
    <div className="flex gap-3">
      <Avatar className="h-8 w-8 shrink-0 bg-violet-600">
        <AvatarFallback className="bg-violet-600 text-white">
          <Bot className="h-4 w-4" />
        </AvatarFallback>
      </Avatar>
      <div className="flex-1 max-w-[85%]">
        <div className="rounded-2xl rounded-tl-sm bg-muted px-4 py-4 space-y-3">
          {/* Skeleton lines - mimics text loading */}
          <div className="space-y-2.5">
            <div className="h-4 bg-muted-foreground/20 rounded-md w-[90%] animate-pulse" />
            <div className="h-4 bg-muted-foreground/20 rounded-md w-[75%] animate-pulse [animation-delay:75ms]" />
            <div className="h-4 bg-muted-foreground/20 rounded-md w-[85%] animate-pulse [animation-delay:150ms]" />
          </div>
          
          {/* Skeleton for potential list items */}
          <div className="space-y-2 pt-1">
            <div className="flex items-center gap-2">
              <div className="h-3 w-3 bg-muted-foreground/20 rounded-full animate-pulse [animation-delay:200ms]" />
              <div className="h-3.5 bg-muted-foreground/20 rounded-md w-[60%] animate-pulse [animation-delay:200ms]" />
            </div>
            <div className="flex items-center gap-2">
              <div className="h-3 w-3 bg-muted-foreground/20 rounded-full animate-pulse [animation-delay:275ms]" />
              <div className="h-3.5 bg-muted-foreground/20 rounded-md w-[50%] animate-pulse [animation-delay:275ms]" />
            </div>
          </div>

          {/* Status indicator */}
          <div className="flex items-center gap-2 pt-2 border-t border-muted-foreground/10">
            <div className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-violet-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-violet-500"></span>
            </div>
            <span className="text-xs text-muted-foreground">{t('dashboard.chat.thinking')}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Streaming Message Component - For real-time text display
// ============================================================================

interface StreamingMessageProps {
  content: string;
  isComplete: boolean;
}

export function StreamingMessage({ content, isComplete }: StreamingMessageProps) {
  // LLM no longer writes inline citations
  const displayContent = content;

  return (
    <div className="flex gap-3">
      <Avatar className="h-8 w-8 shrink-0 bg-violet-600">
        <AvatarFallback className="bg-violet-600 text-white">
          <Bot className="h-4 w-4" />
        </AvatarFallback>
      </Avatar>
      <div className="flex-1 max-w-[85%]">
        <div className="rounded-2xl rounded-tl-sm bg-muted px-4 py-3">
          <div className="text-sm leading-relaxed prose prose-sm dark:prose-invert max-w-none">
            <ReactMarkdown
              components={{
                p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                ul: ({ children }) => <ul className="list-disc ml-4 mb-2">{children}</ul>,
                ol: ({ children }) => <ol className="list-decimal ml-4 mb-2">{children}</ol>,
                li: ({ children }) => <li className="mb-1">{children}</li>,
                strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
                code: ({ children }) => <code className="bg-muted px-1 py-0.5 rounded text-xs">{children}</code>,
              }}
            >
              {displayContent}
            </ReactMarkdown>
            {!isComplete && (
              <span className="inline-block w-2 h-4 bg-violet-500 animate-pulse ml-0.5 align-middle" />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
