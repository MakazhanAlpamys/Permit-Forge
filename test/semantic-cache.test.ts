// ============================================================================
// E8 — lib/semantic-cache.ts coverage
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAdminClient } from '@/lib/supabase-server';
import { searchCache, storeInCache } from '@/lib/semantic-cache';
import { CACHE_SIMILARITY_THRESHOLD, CACHE_TTL_SECONDS } from '@/lib/constants';
import type { Citation } from '@/types';

const SAMPLE_EMBEDDING = new Array(768).fill(0.1);

beforeEach(() => {
  vi.clearAllMocks();
});

function withRpc(rpc: ReturnType<typeof vi.fn>) {
  vi.mocked(createAdminClient).mockReturnValueOnce({
    from: vi.fn(),
    rpc,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

// ----------------------------------------------------------------------------
// searchCache
// ----------------------------------------------------------------------------

describe('searchCache', () => {
  it('returns a cache HIT when the RPC has a row above threshold', async () => {
    const citations: Citation[] = [
      {
        chunkId: 1,
        page: 12,
        section: '3.1',
        excerpt: 'cited excerpt',
        similarity: 0.9,
      },
    ];
    // PR5 (v1.3.0 re-audit): searchCache now treats responses below
    // MIN_CACHEABLE_RESPONSE_LENGTH (50) as a miss, so the test fixture
    // must reflect a plausible real answer.
    const longResponse = 'cached answer that is long enough to clear the fifty-character defense-in-depth filter';
    const rpc = vi.fn().mockResolvedValue({
      data: [
        {
          response: longResponse,
          citations,
          similarity: 0.97,
        },
      ],
      error: null,
    });
    withRpc(rpc);

    const out = await searchCache(SAMPLE_EMBEDDING);

    expect(out.hit).toBe(true);
    expect(out.response).toBe(longResponse);
    expect(out.citations).toEqual(citations);
    expect(out.similarity).toBeCloseTo(0.97);
    expect(rpc).toHaveBeenCalledWith('search_semantic_cache', {
      query_embedding: SAMPLE_EMBEDDING,
      similarity_threshold: CACHE_SIMILARITY_THRESHOLD,
      max_age_seconds: CACHE_TTL_SECONDS,
    });
  });

  it('returns a cache MISS when the RPC returns no rows', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });
    withRpc(rpc);

    const out = await searchCache(SAMPLE_EMBEDDING);
    expect(out).toEqual({ hit: false });
  });

  // PR5 (v1.3.0 re-audit): legacy rows shorter than 50 chars can still exist
  // in the table from before MIN_CACHEABLE_RESPONSE_LENGTH was enforced on
  // write — searchCache must defensively miss on them so a truncated answer
  // can't be served back to a user.
  it('returns a cache MISS when the stored response is below MIN_CACHEABLE_RESPONSE_LENGTH', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ response: 'tiny', citations: [], similarity: 0.99 }],
      error: null,
    });
    withRpc(rpc);

    const out = await searchCache(SAMPLE_EMBEDDING);
    expect(out).toEqual({ hit: false });
  });

  it('returns a cache MISS when the RPC returns null data', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    withRpc(rpc);

    const out = await searchCache(SAMPLE_EMBEDDING);
    expect(out).toEqual({ hit: false });
  });

  it('returns a cache MISS (does not throw) when the RPC returns an error', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'rpc broke' } });
    withRpc(rpc);

    await expect(searchCache(SAMPLE_EMBEDDING)).resolves.toEqual({ hit: false });
  });

  it('returns a cache MISS (does not throw) when the call throws', async () => {
    vi.mocked(createAdminClient).mockImplementationOnce(() => {
      throw new Error('connection refused');
    });

    await expect(searchCache(SAMPLE_EMBEDDING)).resolves.toEqual({ hit: false });
  });
});

// ----------------------------------------------------------------------------
// storeInCache
// ----------------------------------------------------------------------------

describe('storeInCache', () => {
  it('calls insert_semantic_cache with the expected payload', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    withRpc(rpc);

    const citations: Citation[] = [
      {
        chunkId: 1,
        page: 12,
        section: '3.1',
        excerpt: 'cited excerpt',
        similarity: 0.9,
      },
    ];
    await storeInCache('q', SAMPLE_EMBEDDING, 'response', citations);

    expect(rpc).toHaveBeenCalledWith('insert_semantic_cache', {
      p_query_text: 'q',
      p_query_embedding: SAMPLE_EMBEDDING,
      p_response: 'response',
      p_citations: citations,
      p_ttl_seconds: CACHE_TTL_SECONDS,
    });
  });

  it('swallows RPC error (never throws)', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'oh no' } });
    withRpc(rpc);

    await expect(
      storeInCache('q', SAMPLE_EMBEDDING, 'r', []),
    ).resolves.toBeUndefined();
  });

  it('swallows thrown error (never throws)', async () => {
    vi.mocked(createAdminClient).mockImplementationOnce(() => {
      throw new Error('connection refused');
    });

    await expect(
      storeInCache('q', SAMPLE_EMBEDDING, 'r', []),
    ).resolves.toBeUndefined();
  });

  // S-M-7 / v1.9.0 Part A: defense-in-depth against persisted prompt injection.
  // Even though MessageBubble + ReactMarkdown filter `javascript:` URLs at
  // render time, the cache row sticks around for the full TTL (1hr) and could
  // be served to many users; we sanitize before storing so the bad payload
  // never persists.
  it('sanitizes javascript:-style URLs out of the response before storing (S-M-7)', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    withRpc(rpc);

    const malicious =
      'Check [this](javascript:alert(1)) link and [data exfil](vbscript:msgbox).';
    await storeInCache('q', SAMPLE_EMBEDDING, malicious, []);

    const payload = rpc.mock.calls[0][1];
    expect(payload.p_response).not.toMatch(/javascript:/i);
    expect(payload.p_response).not.toMatch(/vbscript:/i);
  });

  it('strips <script> tags from the cached response (S-M-7)', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    withRpc(rpc);

    const malicious = 'Hello<script>alert(1)</script> world';
    await storeInCache('q', SAMPLE_EMBEDDING, malicious, []);

    const payload = rpc.mock.calls[0][1];
    expect(payload.p_response).not.toMatch(/<script/i);
    expect(payload.p_response).not.toMatch(/<\/script>/i);
  });

  // v1.9.0 Part A re-audit (NEW-2, Low): data:text/html URIs can carry
  // executable HTML that bypasses the link sanitizer in MessageBubble.
  it('strips data:text/html URIs from the cached response (S-M-7 re-audit NEW-2)', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    withRpc(rpc);

    const malicious = 'Click [bait](data:text/html,<img src=x onerror=alert(1)>) now';
    await storeInCache('q', SAMPLE_EMBEDDING, malicious, []);

    const payload = rpc.mock.calls[0][1];
    expect(payload.p_response).not.toMatch(/data:text\/html/i);
    expect(payload.p_response).not.toMatch(/onerror=alert/i);
  });

  it('strips data:application/xhtml+xml URIs too', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    withRpc(rpc);

    const malicious = '[bait](data:application/xhtml+xml;base64,PHNjcmlwdD4=)';
    await storeInCache('q', SAMPLE_EMBEDDING, malicious, []);

    const payload = rpc.mock.calls[0][1];
    expect(payload.p_response).not.toMatch(/data:application/i);
  });

  it('does not touch innocuous data: URIs in non-HTML schemes', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    withRpc(rpc);

    // Leaving image data: URIs alone is intentional — the cache primarily
    // stores plain text but a Markdown image link is a known-safe shape.
    const benign = '![logo](data:image/png;base64,AAAA)';
    await storeInCache('q', SAMPLE_EMBEDDING, benign, []);

    const payload = rpc.mock.calls[0][1];
    expect(payload.p_response).toBe(benign);
  });

  it('leaves benign markdown alone', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    withRpc(rpc);

    const benign = 'See [page 5](https://example.com/doc#page=5) for **details**.';
    await storeInCache('q', SAMPLE_EMBEDDING, benign, []);

    const payload = rpc.mock.calls[0][1];
    expect(payload.p_response).toBe(benign);
  });

  it('JSON-serializes citations to drop functions / undefined / symbols', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    withRpc(rpc);

    const dirty = [
      {
        chunkId: 1,
        page: 5,
        section: '1.1',
        excerpt: 'x',
        similarity: 0.9,
        extra: undefined as unknown,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any;
    await storeInCache('q', SAMPLE_EMBEDDING, 'r', dirty);

    const payload = rpc.mock.calls[0][1];
    // JSON.stringify+parse drops `undefined` and any non-JSON values.
    expect(payload.p_citations[0]).not.toHaveProperty('extra');
  });
});
