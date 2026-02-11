'use client';

// ============================================================================
// Message Bubble Component
// ============================================================================

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { CitationsList } from './source-citation';
import { complianceStatusConfig } from '@/lib/constants';
import { User, Bot, Copy, Check } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import DOMPurify from 'isomorphic-dompurify';
import { useMemo, useState, useCallback } from 'react';
import type { ChatMessage } from '@/types';

// XSS Protection: Sanitize content before rendering
function sanitizeContent(content: string): string {
  return DOMPurify.sanitize(content, {
    ALLOWED_TAGS: ['b', 'i', 'em', 'strong', 'p', 'br', 'ul', 'ol', 'li', 'code', 'pre', 'h1', 'h2', 'h3', 'h4', 'a', 'blockquote'],
    ALLOWED_ATTR: ['href', 'title', 'target', 'rel'],
    ALLOW_DATA_ATTR: false,
  });
}

/**
 * Strip inline citation references from text for clean display.
 * Removes patterns like [Page 10, Section 2.1], (Page 45), [Pages 10-12], etc.
 * The actual sources are shown separately in the citations section.
 */
function stripInlineCitations(text: string): string {
  return text
    // [Page 45, Section 3.2.1] or [Page 45-46, Section 3.2]
    .replace(/\[Pages?\s+\d+(?:\s*[-–,]\s*\d+)?,?\s*Section\s+[\d.]+\]/gi, '')
    // [Page 45, §3.2.1]
    .replace(/\[Pages?\s+\d+(?:\s*[-–,]\s*\d+)?,?\s*§\s*[\d.]+\]/gi, '')
    // [Page 45] or [Page 45-46] or [Pages 45-46]
    .replace(/\[Pages?\s+\d+(?:\s*[-–]\s*\d+)?\]/gi, '')
    // (Page 45, Section 3.2.1)
    .replace(/\(Pages?\s+\d+(?:\s*[-–,]\s*\d+)?,?\s*Section\s+[\d.]+\)/gi, '')
    // (Page 45) or (Page 45-46)
    .replace(/\(Pages?\s+\d+(?:\s*[-–]\s*\d+)?\)/gi, '')
    // Section 3.2.1, Page 45
    .replace(/Section\s+[\d.]+,?\s*Page\s+\d+/gi, '')
    // Clean up double spaces and extra whitespace left over
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,;:])/g, '$1')
    .trim();
}

interface MessageBubbleProps {
  message: ChatMessage;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const compliance = message.complianceStatus 
    ? complianceStatusConfig[message.complianceStatus] 
    : null;
  const [copied, setCopied] = useState(false);

  // Sanitize content to prevent XSS attacks
  const sanitizedContent = useMemo(() => sanitizeContent(message.content), [message.content]);

  // For assistant messages: strip inline citations for clean display
  const displayContent = useMemo(() => {
    if (isUser) return sanitizedContent;
    return stripInlineCitations(sanitizedContent);
  }, [sanitizedContent, isUser]);

  // Copy answer text to clipboard
  const handleCopy = useCallback(async () => {
    try {
      // Copy the clean text (without citations markers)
      const textToCopy = stripInlineCitations(message.content);
      await navigator.clipboard.writeText(textToCopy);
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
          {!isUser && compliance && message.complianceStatus !== 'pending' && (
            <div className="mb-2">
              <Badge variant="outline" className={`${compliance.badgeClassName} text-xs`}>
                <compliance.icon className="h-3 w-3 mr-1" />
                {compliance.label}
              </Badge>
            </div>
          )}

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
                  // Sanitize links to prevent javascript: URLs
                  a: ({ href, children }) => {
                    const safeHref = href && !href.startsWith('javascript:') ? href : '#';
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
                title="Copy answer"
              >
                {copied ? (
                  <>
                    <Check className="h-3.5 w-3.5 text-violet-500" />
                    <span className="text-violet-500">Copied!</span>
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" />
                    <span>Copy answer</span>
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
          {formatTimestamp(message.timestamp)}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Helper Functions
// ============================================================================

function formatTimestamp(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: 'numeric',
    hour12: true,
  }).format(date);
}

// ============================================================================
// Loading Message Component - Premium Skeleton Style
// ============================================================================

export function LoadingMessage() {
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
            <span className="text-xs text-muted-foreground">Analyzing Dubai Building Code...</span>
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
  // Strip inline citations during streaming for clean display
  const displayContent = useMemo(() => stripInlineCitations(content), [content]);

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
