'use client';

// ============================================================================
// Chat Interface Component with Chat History Support
// ============================================================================

import { useState, useRef, useEffect, useCallback } from 'react';
import { sendChatMessage } from '@/actions/chat';
import { createChatSession, saveMessageToSession, getSessionMessages } from '@/actions/chat-history';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { MessageBubble, LoadingMessage } from './message-bubble';
import { 
  Send, 
  Sparkles,
  RotateCcw,
  Square
} from 'lucide-react';
import type { ChatMessage } from '@/types';

// ============================================================================
// Anti-Spam Configuration
// ============================================================================

const MIN_REQUEST_INTERVAL = 2000; // 2 seconds between requests
const MAX_MESSAGE_LENGTH = 500;

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
  const [cooldown, setCooldown] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [isCancelled, setIsCancelled] = useState(false);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastRequestRef = useRef<number>(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const isMountedRef = useRef(true);

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

  // Cleanup on unmount
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
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
  }, [messages, isLoading, scrollToBottom]);

  // Handle sending a message with anti-spam protection
  const handleSendMessage = async (messageText?: string) => {
    const text = (messageText || inputValue).trim().slice(0, MAX_MESSAGE_LENGTH);
    
    // Prevent empty or duplicate requests
    if (!text || isLoading || cooldown) return;

    // Rate limiting check
    const now = Date.now();
    if (now - lastRequestRef.current < MIN_REQUEST_INTERVAL) {
      setCooldown(true);
      setTimeout(() => setCooldown(false), MIN_REQUEST_INTERVAL);
      return;
    }
    lastRequestRef.current = now;

    // Cancel any pending request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();
    setIsCancelled(false);

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

    // Save user message to database
    if (activeSessionId) {
      await saveMessageToSession({
        sessionId: activeSessionId,
        role: 'user',
        content: text,
      });
    }

    try {
      // Call the chat action with sessionId for conversation history
      const response = await sendChatMessage({ 
        message: text,
        sessionId: activeSessionId || undefined,
      });

      // Check if request was aborted or cancelled or component unmounted
      if (abortControllerRef.current?.signal.aborted || !isMountedRef.current) return;

      // Create assistant message
      const assistantMessage: ChatMessage = {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: response.message,
        citations: response.citations,
        complianceStatus: response.complianceStatus,
        timestamp: new Date(),
      };

      if (isMountedRef.current) {
        setMessages(prev => [...prev, assistantMessage]);
      }

      // Save assistant message to database
      if (activeSessionId) {
        await saveMessageToSession({
          sessionId: activeSessionId,
          role: 'assistant',
          content: response.message,
          citations: response.citations,
          complianceStatus: response.complianceStatus,
        });
      }
    } catch (error) {
      // Don't show error if cancelled or unmounted
      if (!isMountedRef.current) return;
      
      // Create error message only if not cancelled
      if (!isCancelled) {
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
      }
    }
  };

  // Handle stop generation
  const handleStopGeneration = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      setIsCancelled(true);
      setIsLoading(false);
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

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Chat Messages Area - Maximum height for more chat space */}
      <ScrollArea ref={scrollAreaRef} className="h-[calc(100vh-200px)] px-4 py-4">
        {messages.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="space-y-6 max-w-3xl mx-auto">
            {messages.map(message => (
              <MessageBubble key={message.id} message={message} />
            ))}
            {isLoading && <LoadingMessage />}
          </div>
        )}
      </ScrollArea>

      {/* Input Area */}
      <div className="border-t border-border bg-card/50 p-4">
        <div className="max-w-3xl mx-auto">
          {/* Clear Chat Button (when messages exist) */}
          {messages.length > 0 && (
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
                disabled={isLoading}
              />
              {isLoading ? (
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
// Empty State Component
// ============================================================================

function EmptyState() {
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
      <p className="text-muted-foreground max-w-md">
        Ask me anything about Dubai Building Code compliance, parking requirements, 
        fire safety, or other regulatory requirements.
      </p>
    </div>
  );
}
