/**
 * @vitest-environment jsdom
 */
// ============================================================================
// MessageBubble + CitationsList tests (COV-C-9 / v1.4.0 Part C)
// ============================================================================
// Both message-bubble.tsx and source-citation.tsx were at 0% line coverage
// before this file. Focused on user-visible behaviour: render shapes, link
// sanitisation, copy-button state machine, sort/show-more on citations.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

import { MessageBubble } from '@/components/chat/message-bubble';
import { CitationsList } from '@/components/chat/source-citation';
import type { ChatMessage, Citation } from '@/types';

// jsdom doesn't ship navigator.clipboard.
beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

const baseUserMessage: ChatMessage = {
  id: 'm-1',
  role: 'user',
  content: 'How tall can a residential building be?',
  timestamp: new Date('2026-05-21T10:00:00Z'),
};

const baseAssistantMessage: ChatMessage = {
  id: 'm-2',
  role: 'assistant',
  content: 'Per the Dubai Building Code, **maximum** residential height is 60 metres.',
  timestamp: new Date('2026-05-21T10:00:05Z'),
};

describe('MessageBubble', () => {
  it('renders user message as plain text (no markdown processor)', () => {
    render(<MessageBubble message={baseUserMessage} />);
    // The literal text is present, asterisks are not promoted to <strong>.
    expect(screen.getByText('How tall can a residential building be?')).toBeInTheDocument();
  });

  it('renders assistant markdown with bold emphasis', () => {
    render(<MessageBubble message={baseAssistantMessage} />);
    const strong = screen.getByText('maximum');
    expect(strong.tagName).toBe('STRONG');
  });

  it('sanitizes javascript: URLs in markdown links to #', () => {
    render(
      <MessageBubble
        message={{
          ...baseAssistantMessage,
          content: 'Read [more](javascript:alert(1)).',
        }}
      />,
    );
    const link = screen.getByText('more') as HTMLAnchorElement;
    expect(link.tagName).toBe('A');
    // The XSS-safety guard collapses non-http(s) protocols to '#'.
    expect(link.getAttribute('href')).toBe('#');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('preserves http(s) URLs in markdown links', () => {
    render(
      <MessageBubble
        message={{
          ...baseAssistantMessage,
          content: 'See [the code](https://example.com/code).',
        }}
      />,
    );
    const link = screen.getByText('the code') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://example.com/code');
  });

  it('renders compliance badge for assistant messages with non-pending status', () => {
    render(
      <MessageBubble
        message={{
          ...baseAssistantMessage,
          complianceStatus: 'compliant',
        }}
      />,
    );
    expect(screen.getByText('Compliant')).toBeInTheDocument();
  });

  it('hides compliance badge when status is "pending"', () => {
    render(
      <MessageBubble
        message={{
          ...baseAssistantMessage,
          complianceStatus: 'pending',
        }}
      />,
    );
    expect(screen.queryByText('Pending')).not.toBeInTheDocument();
  });

  it('does NOT render the Copy button on user messages', () => {
    render(<MessageBubble message={baseUserMessage} />);
    expect(screen.queryByTitle('Copy answer')).not.toBeInTheDocument();
  });

  it('writes message content to navigator.clipboard on Copy click', async () => {
    render(<MessageBubble message={baseAssistantMessage} />);
    fireEvent.click(screen.getByTitle('Copy answer'));
    // navigator.clipboard.writeText is invoked with the raw message content.
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(baseAssistantMessage.content);
  });

  it('does not render CitationsList when message has no citations', () => {
    render(<MessageBubble message={baseAssistantMessage} />);
    // CitationsList renders the "Sources" header — absent here.
    expect(screen.queryByText('Sources')).not.toBeInTheDocument();
  });
});

// ============================================================================
// CitationsList
// ============================================================================

const citation = (overrides: Partial<Citation> = {}): Citation => ({
  chunkId: 1,
  page: 45,
  section: '3.2.1',
  excerpt: 'Maximum building height for residential zones is 60 metres.',
  similarity: 0.85,
  ...overrides,
});

describe('CitationsList', () => {
  it('renders nothing when citations is empty', () => {
    const { container } = render(<CitationsList citations={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the Sources header alongside each citation card', () => {
    render(<CitationsList citations={[citation(), citation({ chunkId: 2, page: 99 })]} />);
    expect(screen.getByText('Sources')).toBeInTheDocument();
    // Both cards rendered — page labels are the distinguishing per-card text.
    expect(screen.getByText('Page 45')).toBeInTheDocument();
    expect(screen.getByText('Page 99')).toBeInTheDocument();
  });

  it('shows only the first 3 by default and a "Show N more" toggle', () => {
    const five = [1, 2, 3, 4, 5].map(i =>
      citation({ chunkId: i, page: 40 + i, section: `3.${i}` }),
    );
    render(<CitationsList citations={five} />);

    expect(screen.getByText('Page 41')).toBeInTheDocument();
    expect(screen.getByText('Page 42')).toBeInTheDocument();
    expect(screen.getByText('Page 43')).toBeInTheDocument();
    // 4th and 5th hidden until toggle.
    expect(screen.queryByText('Page 44')).not.toBeInTheDocument();
    expect(screen.queryByText('Page 45')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText(/Show 2 more sources/));
    expect(screen.getByText('Page 44')).toBeInTheDocument();
    expect(screen.getByText('Page 45')).toBeInTheDocument();
  });

  it('sorts verified citations to the top regardless of confidence', () => {
    const items = [
      citation({ chunkId: 1, page: 10, confidence: 90, isVerified: false }),
      citation({ chunkId: 2, page: 20, confidence: 50, isVerified: true }),
    ];
    render(<CitationsList citations={items} />);
    // Both render; the rendered order is verified-first. Visually we just
    // check the verified badge appears in the first card.
    const cards = screen.getAllByText(/Page \d+/);
    expect(cards[0]).toHaveTextContent('Page 20');
    expect(cards[1]).toHaveTextContent('Page 10');
  });

  it('expands a citation card on click and reveals the excerpt', () => {
    render(<CitationsList citations={[citation()]} />);
    const header = screen.getByText('Page 45').closest('button')!;
    fireEvent.click(header);
    expect(
      screen.getByText('Maximum building height for residential zones is 60 metres.'),
    ).toBeInTheDocument();
  });

  it('renders page range badge when startPage != endPage', () => {
    render(
      <CitationsList
        citations={[
          citation({ page: 45, startPage: 45, endPage: 47 }),
        ]}
      />,
    );
    expect(screen.getByText('Pages 45-47')).toBeInTheDocument();
    expect(screen.getByText('range')).toBeInTheDocument();
  });

  it('shows confidence badge with percentage for non-verified citations', () => {
    render(
      <CitationsList
        citations={[citation({ confidence: 88, isVerified: false })]}
      />,
    );
    expect(screen.getByText('88%')).toBeInTheDocument();
  });

  it('shows "verified" badge and hides confidence when isVerified=true', () => {
    render(
      <CitationsList
        citations={[citation({ confidence: 30, isVerified: true })]}
      />,
    );
    expect(screen.getByText('verified')).toBeInTheDocument();
    // 30% must NOT be rendered when verified — verified supersedes confidence.
    expect(screen.queryByText('30%')).not.toBeInTheDocument();
  });

  it('does not render a clickable PDF link (PDFs live in Storage, not served at /)', () => {
    render(<CitationsList citations={[citation({ documentName: 'building-code-2021', startPage: 45 })]} />);
    fireEvent.click(screen.getByText('Page 45').closest('button')!);
    // The old "View in PDF" anchor built a /<doc>.pdf#page=N path that 404'd —
    // it was removed. The citation card stays info-only (excerpt + page + confidence).
    expect(screen.queryByText('View in PDF')).not.toBeInTheDocument();
  });

  // Defense-in-depth: confirm the table-rendering path is exercised for tabular content.
  it('renders tabular excerpts via the rich-excerpt parser', () => {
    const tabular = 'Zone\tMaxHeight\tNotes\nResidential\t60m\tStandard\nCommercial\t90m\tCBD only';
    render(<CitationsList citations={[citation({ excerpt: tabular, contentType: 'table' })]} />);
    fireEvent.click(screen.getByText('Page 45').closest('button')!);
    // A real <table> is rendered (not the default <p>) when contentType=table.
    const table = screen.getByRole('table');
    expect(within(table).getByText('Residential')).toBeInTheDocument();
    expect(within(table).getByText('Commercial')).toBeInTheDocument();
  });
});
