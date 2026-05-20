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
    const rpc = vi.fn().mockResolvedValue({
      data: [
        {
          response: 'cached answer',
          citations,
          similarity: 0.97,
        },
      ],
      error: null,
    });
    withRpc(rpc);

    const out = await searchCache(SAMPLE_EMBEDDING);

    expect(out.hit).toBe(true);
    expect(out.response).toBe('cached answer');
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
