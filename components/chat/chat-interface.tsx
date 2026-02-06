'use client';

// ============================================================================
// Chat Interface Component with Streaming Support
// ============================================================================

import { useState, useRef, useEffect, useCallback } from 'react';
import { createChatSession, saveMessageToSession, getSessionMessages } from '@/actions/chat-history';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { MessageBubble, LoadingMessage, StreamingMessage } from './message-bubble';
import { 
  Send, 
  Sparkles,
  RotateCcw,
  Square
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
  onSessionCreated?: (sessionId: string) => void;
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
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastRequestRef = useRef<number>(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const isMountedRef = useRef(true);
  const isCancelledRef = useRef(false);

  // Load messages when session changes
  useEffect(() => {
    if (sessionId) {
      loadSessionMessages(sessionId);
      setCurrentSessionId(sessionId);
    } else {
      setMessages([]);
      setCurrentSessionId(null);
    }
  }, [sessionId]);

  const loadSessionMessages = async (sid: string) => {
    const { messages: loadedMessages } = await getSessionMessages(sid);
    setMessages(loadedMessages);
  };

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
      if (newSessionId) {
        activeSessionId = newSessionId;
        setCurrentSessionId(newSessionId);
        if (onSessionCreated) {
          onSessionCreated(newSessionId);
        }
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

    try {
      // Use streaming API with the current controller's signal
      const response = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          message: text,
          sessionId: activeSessionId,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      // Switch to streaming mode
      setIsLoading(false);
      setIsStreaming(true);

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let rawContent = '';
      let fullContent = '';
      let citations: Citation[] = [];
      let streamTextDone = false;

      if (reader) {
        while (true) {
          if (isCancelledRef.current) break;
          const { done, value } = await reader.read();
          if (done) break;
          
          const chunk = decoder.decode(value, { stream: true });
          rawContent += chunk;
          
          // Extract display text (everything before __CITATIONS__ marker)
          const citationMarkerIdx = rawContent.indexOf('__CITATIONS__');
          if (citationMarkerIdx !== -1) {
            fullContent = rawContent.slice(0, citationMarkerIdx);
          } else {
            fullContent = rawContent;
          }
          
          if (isMountedRef.current) {
            setStreamingContent(fullContent);

            // Detect when text is done but citations haven't arrived yet
            // The marker may appear across chunk boundaries, so also check for the
            // trailing newlines that precede it.
            if (!streamTextDone && citationMarkerIdx === -1 && rawContent.includes('\n\n__CIT')) {
              streamTextDone = true;
            }
          }
        }

        // Show "Verifying sources..." while parsing citations
        if (isMountedRef.current && !isCancelledRef.current) {
          setIsVerifyingSources(true);
        }

        // After stream ends, parse citations from accumulated raw content
        const citationMarkerIdx = rawContent.indexOf('__CITATIONS__');
        if (citationMarkerIdx !== -1) {
          fullContent = rawContent.slice(0, citationMarkerIdx);
          const citationsJson = rawContent.slice(citationMarkerIdx + '__CITATIONS__'.length);
          try {
            citations = JSON.parse(citationsJson);
          } catch {
            console.error('Failed to parse citations JSON');
          }
        }

        if (isMountedRef.current) {
          setIsVerifyingSources(false);
        }
      }

      // Check if cancelled
      if (!isMountedRef.current || isCancelledRef.current) return;

      // Create final assistant message
      const assistantMessage: ChatMessage = {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: fullContent,
        citations: citations,
        complianceStatus: 'pending',
        timestamp: new Date(),
      };

      setMessages(prev => [...prev, assistantMessage]);
      setStreamingContent('');

      // Save assistant message to database
      if (activeSessionId) {
        await saveMessageToSession({
          sessionId: activeSessionId,
          role: 'assistant',
          content: fullContent,
          citations: citations,
          complianceStatus: 'pending',
        });
      }
    } catch (error) {
      // Don't show error if cancelled or unmounted
      if (!isMountedRef.current) return;
      
      // Create error message only if not cancelled
      if (!isCancelledRef.current && !(error instanceof DOMException && error.name === 'AbortError')) {
        const errorMessage: ChatMessage = {
          id: `error-${Date.now()}`,
          role: 'assistant',
          content: 'Sorry, I encountered an error while processing your request. Please try again.',
          timestamp: new Date(),
          complianceStatus: 'pending',
        };

        setMessages(prev => [...prev, errorMessage]);
      }
      console.error('Chat error:', error);
    } finally {
      if (isMountedRef.current) {
        setIsLoading(false);
        setIsStreaming(false);
        setIsVerifyingSources(false);
        setStreamingContent('');
      }
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

  // Clear chat history
  const handleClearChat = () => {
    setMessages([]);
    setCurrentSessionId(null);
    if (onSessionCreated) {
      onSessionCreated(null!);
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
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                </div>
                Verifying sources...
              </div>
            )}
          </div>
        )}
      </ScrollArea>

      {/* Input Area */}
      <div className="border-t border-border bg-card/50 p-4">
        <div className="max-w-3xl mx-auto">
          {/* Clear Chat Button (when messages exist) */}
          {messages.length > 0 && !isLoading && !isStreaming && (
            <div className="flex justify-center mb-3">
              <Button 
                variant="ghost" 
                size="sm" 
                onClick={handleClearChat}
                className="text-xs text-muted-foreground"
              >
                <RotateCcw className="h-3 w-3 mr-1" />
                Clear Chat
              </Button>
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
                placeholder="Ask about Dubai Building Code compliance..."
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
            Emirate Forge provides guidance based on Dubai Building Code 2021. 
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
    question: "How does the DBC modify the seismic hazard assessment of ASCE/SEI 7-16 for Dubai, and why is the USA's 'two-thirds' factor excluded?",
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
      <div className="mb-6 p-4 rounded-full bg-gradient-to-br from-emerald-500/20 to-blue-500/20 border border-emerald-500/20">
        <Sparkles className="h-8 w-8 text-emerald-500" />
      </div>

      {/* Title */}
      <h2 className="text-2xl font-semibold text-foreground mb-2">
        Dubai Building Code Assistant
      </h2>
      <p className="text-muted-foreground max-w-md mb-8">
        Ask me anything about Dubai Building Code compliance, parking requirements, 
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
              className="group flex items-start gap-3 p-4 rounded-xl border border-border bg-card/50 hover:bg-card hover:border-emerald-500/50 hover:shadow-lg hover:shadow-emerald-500/5 transition-all duration-200 text-left"
            >
              <span className="text-2xl">{item.icon}</span>
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm text-foreground group-hover:text-emerald-500 transition-colors">
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
