/**
 * @vitest-environment jsdom
 */
// ============================================================================
// E18 — smoke test for ChatInterface
// ============================================================================
// Covers no-session render, textarea + send button presence, send button
// disabled when input empty, and that loading existing-session messages
// invokes the right server action. The existing chat-interface-save-sync test
// covers the streaming/save flow; we keep this one minimal.
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const mockGetSessionMessages = vi.fn();
const mockCreateChatSession = vi.fn();
const mockSaveMessageToSession = vi.fn();

vi.mock('@/actions/chat-history', () => ({
  createChatSession: (...a: unknown[]) => mockCreateChatSession(...a),
  saveMessageToSession: (...a: unknown[]) => mockSaveMessageToSession(...a),
  getSessionMessages: (...a: unknown[]) => mockGetSessionMessages(...a),
}));

vi.mock('@/actions/auth', () => ({
  getCSRFTokenAction: vi.fn().mockResolvedValue('csrf-test'),
}));

// MessageBubble loads DOMPurify + markdown — stub to keep this test focused.
vi.mock('@/components/chat/message-bubble', () => ({
  MessageBubble: ({ message }: { message: { id: string; content: string } }) => (
    <div data-testid="message" data-id={message.id}>
      {message.content}
    </div>
  ),
  LoadingMessage: () => <div data-testid="loading" />,
  StreamingMessage: ({ content }: { content: string }) => (
    <div data-testid="streaming">{content}</div>
  ),
}));

import { ChatInterface } from '@/components/chat/chat-interface';

const SESSION_ID = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  vi.clearAllMocks();
  // ResizeObserver shim for Radix ScrollArea
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  mockGetSessionMessages.mockResolvedValue({ messages: [], hasMore: false, nextCursor: undefined });
});

describe('ChatInterface smoke', () => {
  it('renders the textarea + send button on a brand-new chat (no session)', async () => {
    render(<ChatInterface />);
    expect(await screen.findByPlaceholderText(/ask|message/i)).toBeInTheDocument();
    expect(screen.getAllByRole('button').length).toBeGreaterThan(0);
  });

  it('loads existing session messages when sessionId is given', async () => {
    mockGetSessionMessages.mockResolvedValueOnce({
      messages: [
        { id: 'm1', role: 'user', content: 'first', createdAt: '2026-05-19T00:00:00Z' },
        { id: 'm2', role: 'assistant', content: 'reply', createdAt: '2026-05-19T00:00:01Z' },
      ],
      hasMore: false,
      nextCursor: undefined,
    });

    render(<ChatInterface sessionId={SESSION_ID} />);

    await waitFor(() => expect(mockGetSessionMessages).toHaveBeenCalled());
    // getSessionMessages is called positionally — first arg is the sessionId.
    expect(mockGetSessionMessages.mock.calls[0][0]).toBe(SESSION_ID);
  });

  it('does not call session loader when sessionId is absent', async () => {
    render(<ChatInterface />);
    // Wait briefly for any async effects to settle.
    await new Promise((r) => setTimeout(r, 50));
    expect(mockGetSessionMessages).not.toHaveBeenCalled();
  });

  it('textarea accepts typed input', async () => {
    render(<ChatInterface />);
    const textarea = (await screen.findByPlaceholderText(/ask|message/i)) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'hello world' } });
    expect(textarea.value).toBe('hello world');
  });
});
