'use client';

// ============================================================================
// Message Bubble Component
// ============================================================================

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { CitationsList } from './source-citation';
import { complianceStatusConfig } from '@/lib/constants';
import { User, Bot } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import type { ChatMessage } from '@/types';

interface MessageBubbleProps {
  message: ChatMessage;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const compliance = message.complianceStatus 
    ? complianceStatusConfig[message.complianceStatus] 
    : null;

  return (
    <div className={`flex gap-3 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
      {/* Avatar */}
      <Avatar className={`h-8 w-8 shrink-0 ${isUser ? 'bg-primary' : 'bg-emerald-600'}`}>
        <AvatarFallback className={isUser ? 'bg-primary text-primary-foreground' : 'bg-emerald-600 text-white'}>
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
              <span className="whitespace-pre-wrap">{message.content}</span>
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
                }}
              >
                {message.content}
              </ReactMarkdown>
            )}
          </div>
        </div>

        {/* Citations (only for assistant messages) */}
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
// Loading Message Component
// ============================================================================

export function LoadingMessage() {
  return (
    <div className="flex gap-3">
      <Avatar className="h-8 w-8 shrink-0 bg-emerald-600">
        <AvatarFallback className="bg-emerald-600 text-white">
          <Bot className="h-4 w-4" />
        </AvatarFallback>
      </Avatar>
      <div className="flex-1 max-w-[85%]">
        <div className="rounded-2xl rounded-tl-sm bg-muted px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="flex gap-1">
              <span className="w-2 h-2 bg-muted-foreground/50 rounded-full animate-bounce [animation-delay:-0.3s]" />
              <span className="w-2 h-2 bg-muted-foreground/50 rounded-full animate-bounce [animation-delay:-0.15s]" />
              <span className="w-2 h-2 bg-muted-foreground/50 rounded-full animate-bounce" />
            </div>
            <span className="text-sm text-muted-foreground">Analyzing Dubai Building Code...</span>
          </div>
        </div>
      </div>
    </div>
  );
}
