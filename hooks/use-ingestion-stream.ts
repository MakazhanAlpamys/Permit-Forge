'use client';

// ============================================================================
// useIngestionStream — SSE ingestion-progress consumer (F17 / Simplify #17)
// ============================================================================
// Wraps the boilerplate around POST /api/ingest:
//   - per-document AbortController for Cancel
//   - SSE line-buffer parsing
//   - active-progress / status / message state per documentId
//   - graceful handling of user-initiated AbortError
// ============================================================================

import { useCallback, useRef, useState } from 'react';

export type IngestionStatus = 'idle' | 'loading' | 'success' | 'error';

export interface IngestionProgressInfo {
  stage: string;
  progress: number;
  total: number;
  message: string;
  chunksProcessed?: number;
}

export interface UseIngestionStreamReturn {
  /** Per-documentId status (idle / loading / success / error). */
  statuses: Record<string, IngestionStatus>;
  /** Per-documentId message shown next to the status badge. */
  messages: Record<string, string>;
  /** Per-documentId progress payload from the most recent SSE event (deleted on done). */
  activeProgress: Record<string, IngestionProgressInfo>;
  /** Trigger an ingestion. Caller supplies csrfToken + replaceChunks flag. */
  startIngestion: (
    documentId: string,
    csrfToken: string | null,
    replaceChunks?: boolean,
  ) => Promise<void>;
  /** Cancel the in-flight ingestion for this document. */
  cancelIngestion: (documentId: string) => void;
  /** Manually set status/message — useful for unrelated clear-chunks calls. */
  setStatus: (documentId: string, status: IngestionStatus, message?: string) => void;
}

export function useIngestionStream(
  options: { onComplete?: (documentId: string, success: boolean) => void } = {},
): UseIngestionStreamReturn {
  const [statuses, setStatuses] = useState<Record<string, IngestionStatus>>({});
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [activeProgress, setActiveProgress] = useState<Record<string, IngestionProgressInfo>>({});

  const abortersRef = useRef<Record<string, AbortController>>({});

  const setStatus = useCallback((documentId: string, status: IngestionStatus, message?: string) => {
    setStatuses((prev) => ({ ...prev, [documentId]: status }));
    if (message !== undefined) {
      setMessages((prev) => ({ ...prev, [documentId]: message }));
    }
  }, []);

  const cancelIngestion = useCallback((documentId: string) => {
    abortersRef.current[documentId]?.abort();
  }, []);

  const startIngestion = useCallback(
    async (documentId: string, csrfToken: string | null, replaceChunks = false) => {
      setStatuses((prev) => ({ ...prev, [documentId]: 'loading' }));
      setMessages((prev) => ({ ...prev, [documentId]: 'Starting ingestion...' }));
      setActiveProgress((prev) => ({
        ...prev,
        [documentId]: { stage: 'starting', progress: 0, total: 100, message: 'Connecting...' },
      }));

      abortersRef.current[documentId]?.abort();
      const controller = new AbortController();
      abortersRef.current[documentId] = controller;

      try {
        const response = await fetch('/api/ingest', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-csrf-token': csrfToken || '',
          },
          body: JSON.stringify({ documentId, replaceChunks }),
          signal: controller.signal,
        });

        if (!response.ok) throw new Error('Failed to start ingestion');

        const reader = response.body?.getReader();
        const decoder = new TextDecoder();
        if (!reader) throw new Error('No response stream');

        let buffer = '';
        let didComplete = false;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              const data = JSON.parse(line.slice(6));
              setActiveProgress((prev) => ({
                ...prev,
                [documentId]: {
                  stage: data.stage,
                  progress: data.progress,
                  total: data.total,
                  message: data.message,
                  chunksProcessed: data.chunksProcessed,
                },
              }));

              if (data.done) {
                didComplete = true;
                if (data.error) {
                  setStatuses((prev) => ({ ...prev, [documentId]: 'error' }));
                  setMessages((prev) => ({ ...prev, [documentId]: data.error }));
                  options.onComplete?.(documentId, false);
                } else {
                  setStatuses((prev) => ({ ...prev, [documentId]: 'success' }));
                  setMessages((prev) => ({
                    ...prev,
                    [documentId]: `${data.chunksProcessed || 0} chunks ingested`,
                  }));
                  options.onComplete?.(documentId, true);
                }
                setActiveProgress((prev) => {
                  const next = { ...prev };
                  delete next[documentId];
                  return next;
                });
              }
            } catch (err) {
              // TS-M-5 / v1.6.0 Part F: surface the parse failure to the
              // console so a malformed SSE payload (vs. an incomplete buffer
              // boundary) is at least debuggable. Most failures here are
              // expected mid-buffer slicing — the loop reassembles on the
              // next chunk via `buffer = lines.pop()` — so we don't surface
              // to UI, just operator logs.
              console.warn(
                '[use-ingestion-stream] JSON.parse failed (likely partial SSE line):',
                err instanceof Error ? err.message : String(err),
              );
            }
          }
        }

        if (!didComplete) {
          // Stream closed without a `done` event — surface as a graceful error.
          setStatuses((prev) => ({ ...prev, [documentId]: 'error' }));
          setMessages((prev) => ({ ...prev, [documentId]: 'Stream ended unexpectedly' }));
          options.onComplete?.(documentId, false);
        }
      } catch (error) {
        const isAbort = error instanceof DOMException && error.name === 'AbortError';
        setStatuses((prev) => ({ ...prev, [documentId]: isAbort ? 'idle' : 'error' }));
        setMessages((prev) => ({
          ...prev,
          [documentId]: isAbort
            ? 'Ingestion cancelled.'
            : error instanceof Error
              ? error.message
              : 'Failed',
        }));
        setActiveProgress((prev) => {
          const next = { ...prev };
          delete next[documentId];
          return next;
        });
        if (!isAbort) options.onComplete?.(documentId, false);
      } finally {
        delete abortersRef.current[documentId];
      }
    },
    [options],
  );

  return {
    statuses,
    messages,
    activeProgress,
    startIngestion,
    cancelIngestion,
    setStatus,
  };
}
