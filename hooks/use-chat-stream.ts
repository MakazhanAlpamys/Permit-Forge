'use client';

// ============================================================================
// useChatStream — encapsulates the /api/chat/stream SSE consumer (F19)
// ============================================================================
// Pulled out of chat-interface.tsx so the component owns only UI concerns.
// The server still uses the existing marker protocol (`__CITATIONS__` /
// `__ERROR__`); upgrading to a typed event stream is left for a follow-up.
// ============================================================================

import { useCallback } from 'react';
import type { Citation } from '@/types';

export interface ChatStreamCallbacks {
  /** Called repeatedly with the latest assistant content as the stream arrives. */
  onContent: (content: string) => void;
  /** Called once when the text portion is done but citations haven't arrived yet. */
  onTextDone?: () => void;
  /** Called once when the stream is fully consumed, with the final content + citations. */
  onComplete: (result: { content: string; citations: Citation[] }) => void;
  /** Called if the server emits an `__ERROR__` marker or if the fetch fails. */
  onError: (error: Error) => void;
  /** Called once the abort signal fires. */
  onAbort?: () => void;
}

export interface UseChatStreamReturn {
  /** Send a message and stream the response. Returns the controller so the caller can abort it. */
  streamMessage: (
    body: { message: string; sessionId: string | null },
    options: {
      csrfToken: string | null;
      signal: AbortSignal;
      isCancelled: () => boolean;
      callbacks: ChatStreamCallbacks;
    },
  ) => Promise<void>;
}

/**
 * Parse the marker-delimited stream from /api/chat/stream:
 *   <text>__CITATIONS__<json>          — normal completion
 *   ...<text>...__ERROR__<json>...     — server emitted an error mid-stream
 *
 * Returns the cleaned text + parsed citations. Throws on parse failure of an
 * `__ERROR__` payload to let the caller surface the message.
 */
function parseStreamPayload(raw: string): { content: string; citations: Citation[] } {
  const errorIdx = raw.indexOf('__ERROR__');
  if (errorIdx !== -1) {
    const errorJson = raw.slice(errorIdx + '__ERROR__'.length);
    try {
      const parsed = JSON.parse(errorJson);
      throw new Error(parsed.message || 'Stream error');
    } catch (e) {
      if (e instanceof SyntaxError) throw new Error('Stream processing failed');
      throw e;
    }
  }

  const citationIdx = raw.indexOf('__CITATIONS__');
  if (citationIdx === -1) {
    return { content: raw, citations: [] };
  }

  const content = raw.slice(0, citationIdx);
  const citationsJson = raw.slice(citationIdx + '__CITATIONS__'.length);
  let citations: Citation[] = [];
  try {
    citations = JSON.parse(citationsJson);
  } catch {
    console.error('Failed to parse citations JSON');
  }
  return { content, citations };
}

export function useChatStream(): UseChatStreamReturn {
  // Thin functional wrapper: the AbortController is owned by the caller
  // (chat-interface.tsx already keeps its own ref to support the Stop button).

  const streamMessage = useCallback(
    async (
      body: { message: string; sessionId: string | null },
      options: {
        csrfToken: string | null;
        signal: AbortSignal;
        isCancelled: () => boolean;
        callbacks: ChatStreamCallbacks;
      },
    ) => {
      const { csrfToken, signal, isCancelled, callbacks } = options;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (csrfToken) headers['x-csrf-token'] = csrfToken;

      try {
        const response = await fetch('/api/chat/stream', {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal,
        });

        if (!response.ok) {
          let errorDetail = `HTTP ${response.status}`;
          try {
            const errJson = await response.json();
            errorDetail = errJson.message || errJson.error || errorDetail;
          } catch {
            // body not JSON — keep generic HTTP detail
          }
          throw new Error(errorDetail);
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error('No response stream');

        const decoder = new TextDecoder();
        let raw = '';
        let textDoneFired = false;

        while (true) {
          if (isCancelled()) break;
          const { done, value } = await reader.read();
          if (done) break;

          raw += decoder.decode(value, { stream: true });

          // Bail early if the server already signalled an error mid-stream.
          if (raw.includes('__ERROR__')) {
            const parsedErr = parseStreamPayload(raw);
            // parseStreamPayload throws on error markers — we shouldn't reach here.
            callbacks.onContent(parsedErr.content);
            break;
          }

          // Strip pending citations marker from the visible content (if any).
          const citationIdx = raw.indexOf('__CITATIONS__');
          const visible = citationIdx === -1 ? raw : raw.slice(0, citationIdx);
          callbacks.onContent(visible);

          // The marker may straddle chunk boundaries. The trailing `\n\n__CIT`
          // sequence is a reliable hint that the text portion is done.
          if (!textDoneFired && citationIdx === -1 && raw.includes('\n\n__CIT')) {
            textDoneFired = true;
            callbacks.onTextDone?.();
          }
        }

        if (isCancelled()) {
          callbacks.onAbort?.();
          return;
        }

        const result = parseStreamPayload(raw);
        callbacks.onComplete(result);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          callbacks.onAbort?.();
          return;
        }
        callbacks.onError(error instanceof Error ? error : new Error(String(error)));
      }
    },
    [],
  );

  return { streamMessage };
}
