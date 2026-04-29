// ============================================================================
// Coverage backfill for lib/gemini.ts retry/quota path (P2-T5)
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockEmbedContent } = vi.hoisted(() => ({ mockEmbedContent: vi.fn() }));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { embedContent: mockEmbedContent };
  },
}));

// Stub LangChain wrappers — they're constructor-only and gemini-2.5 isn't called here.
vi.mock('@langchain/google-genai', () => ({
  ChatGoogleGenerativeAI: class {},
}));

import { generateEmbedding, DailyQuotaExhaustedError } from '@/lib/gemini';

describe('lib/gemini > generateEmbedding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Speed up retries — replace setTimeout with immediate callback so tests don't sleep.
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  it('returns the vector on first successful call', async () => {
    mockEmbedContent.mockResolvedValueOnce({
      embeddings: [{ values: new Array(768).fill(0.1) }],
    });
    const vec = await generateEmbedding('hello');
    expect(vec).toHaveLength(768);
    expect(mockEmbedContent).toHaveBeenCalledTimes(1);
  });

  it('throws when API returns empty values array', async () => {
    mockEmbedContent.mockResolvedValueOnce({ embeddings: [{ values: [] }] });
    // Empty -> retried up to maxRetries; ultimately rejected. Use small maxRetries.
    await expect(generateEmbedding('hi', 1)).rejects.toThrow(/empty vector/i);
  });

  it('throws DailyQuotaExhaustedError immediately on perday quota error', async () => {
    mockEmbedContent.mockRejectedValueOnce(
      new Error('429 RESOURCE_EXHAUSTED quota perday limit')
    );
    await expect(generateEmbedding('x')).rejects.toBeInstanceOf(DailyQuotaExhaustedError);
    expect(mockEmbedContent).toHaveBeenCalledTimes(1);
  });

  it('does not retry non-retryable errors (e.g. invalid api key)', async () => {
    mockEmbedContent.mockRejectedValueOnce(new Error('401 Unauthorized: invalid api key'));
    await expect(generateEmbedding('x', 5)).rejects.toThrow(/invalid api key/i);
    expect(mockEmbedContent).toHaveBeenCalledTimes(1);
  });

  it('retries on per-minute 429 and eventually succeeds', async () => {
    mockEmbedContent
      .mockRejectedValueOnce(new Error('429 Too Many Requests, retryDelay 1'))
      .mockResolvedValueOnce({ embeddings: [{ values: new Array(768).fill(0.5) }] });
    const promise = generateEmbedding('x', 3);
    // Fast-forward past the rate-limit backoff (~6s)
    await vi.advanceTimersByTimeAsync(15_000);
    const vec = await promise;
    expect(vec).toHaveLength(768);
    expect(mockEmbedContent).toHaveBeenCalledTimes(2);
  });

  it('retries on transient network errors with exponential backoff', async () => {
    mockEmbedContent
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce({ embeddings: [{ values: new Array(768).fill(0.2) }] });
    const promise = generateEmbedding('x', 5);
    await vi.advanceTimersByTimeAsync(10_000);
    const vec = await promise;
    expect(vec).toHaveLength(768);
    expect(mockEmbedContent).toHaveBeenCalledTimes(3);
  });

  it('rethrows the last error after exhausting retries', async () => {
    mockEmbedContent.mockRejectedValue(new Error('fetch failed'));
    const promise = generateEmbedding('x', 2).catch(e => e);
    await vi.advanceTimersByTimeAsync(10_000);
    const err = await promise;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/fetch failed/);
    expect(mockEmbedContent).toHaveBeenCalledTimes(2);
  });

  it('DailyQuotaExhaustedError is named correctly', () => {
    const err = new DailyQuotaExhaustedError('out');
    expect(err.name).toBe('DailyQuotaExhaustedError');
    expect(err.message).toBe('out');
  });
});
