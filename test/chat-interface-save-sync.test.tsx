/**
 * @vitest-environment jsdom
 */
// ============================================================================
// ChatInterface — B17: surface DB save failure of assistant message as a
// "not synced" indicator so the user knows the in-memory transcript drifted.
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mockCreateChatSession = vi.fn();
const mockSaveMessageToSession = vi.fn();
const mockGetSessionMessages = vi.fn();

vi.mock('@/actions/chat-history', () => ({
  createChatSession: (...args: unknown[]) => mockCreateChatSession(...args),
  saveMessageToSession: (...args: unknown[]) => mockSaveMessageToSession(...args),
  getSessionMessages: (...args: unknown[]) => mockGetSessionMessages(...args),
}));

vi.mock('@/actions/auth', () => ({
  getCSRFTokenAction: vi.fn().mockResolvedValue('csrf-test'),
}));

// MessageBubble depends on DOMPurify / heavy markdown rendering. Stub it so the
// test stays focused on the sync-indicator state machine.
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

function streamingResponse(body: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/plain' } });
}

describe('ChatInterface assistant-message save sync (B17)', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    originalFetch = globalThis.fetch;
    mockGetSessionMessages.mockResolvedValue({ messages: [], hasMore: false, nextCursor: undefined });
    // The assistant-save call is the second saveMessageToSession invocation
    // (after the user-message save). We resolve both to control them per-test.
    mockSaveMessageToSession.mockResolvedValue({ success: true });
    // ResizeObserver is required by Radix ScrollArea.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  async function sendMessage() {
    const textarea = await screen.findByPlaceholderText(/ask|message/i);
    fireEvent.change(textarea, { target: { value: 'tell me about fire safety' } });
    // The Send button is the only Button rendered next to the textarea; it has
    // no aria-label, so we grab it as the sibling button that isn't disabled.
    const buttons = screen.getAllByRole('button').filter(b => !(b as HTMLButtonElement).disabled);
    const sendButton = buttons[buttons.length - 1];
    fireEvent.click(sendButton);
  }

  it('shows the save-failed indicator when assistant-message save returns success:false', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      streamingResponse('The fire safety code requires...\n\n__CITATIONS__[]'),
    ) as typeof globalThis.fetch;

    // First call (user message save) succeeds; second (assistant save) fails.
    mockSaveMessageToSession
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, error: 'DB error' });

    render(<ChatInterface sessionId={SESSION_ID} />);

    await waitFor(() => expect(mockGetSessionMessages).toHaveBeenCalled());

    await sendMessage();

    await waitFor(() => {
      expect(screen.getByText(/Save failed/i)).toBeInTheDocument();
    });
  });

  it('does not show the indicator when the assistant save succeeds', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      streamingResponse('All good\n\n__CITATIONS__[]'),
    ) as typeof globalThis.fetch;

    mockSaveMessageToSession.mockResolvedValue({ success: true });

    render(<ChatInterface sessionId={SESSION_ID} />);

    await waitFor(() => expect(mockGetSessionMessages).toHaveBeenCalled());

    await sendMessage();

    // Wait for at least one assistant save to be attempted.
    await waitFor(() => {
      expect(mockSaveMessageToSession).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'assistant' }),
      );
    });

    expect(screen.queryByText(/Save failed/i)).not.toBeInTheDocument();
  });
});
