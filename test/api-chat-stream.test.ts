// ============================================================================
// Chat Stream API Route Tests
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock auth
const mockGetQuickSession = vi.fn();
const mockValidateCSRFToken = vi.fn();
vi.mock('@/lib/auth', () => ({
  getQuickSession: (...args: unknown[]) => mockGetQuickSession(...args),
  validateCSRFToken: (...args: unknown[]) => mockValidateCSRFToken(...args),
}));

// AUTH-C1 / v1.0.0 Part E: chat-stream now boots through requireAuth. Mock
// as a thin passthrough over getQuickSession so existing tests still drive
// behaviour via mockGetQuickSession.
vi.mock('@/lib/security', () => ({
  requireAuth: vi.fn(async () => {
    const user = await mockGetQuickSession();
    if (!user) return { success: false, error: 'Authentication required' };
    return { success: true, user };
  }),
}));

// Mock rate limiting
const mockCheckRateLimit = vi.fn();
vi.mock('@/lib/supabase-server', () => {
  const mockFrom = vi.fn(() => ({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: null, error: null }),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({ data: [], error: null }),
  }));

  return {
    createServerClient: vi.fn(() => ({ from: mockFrom })),
    createAdminClient: vi.fn(() => ({ from: mockFrom })),
    checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  };
});

// Mock chat pipeline
const mockCacheResponse = vi.fn().mockResolvedValue(undefined);
const mockExecuteRAGPipeline = vi.fn().mockResolvedValue({ chunks: [], queryEmbedding: new Array(768).fill(0), fromCache: false });
const mockClassifyUserTopic = vi.fn().mockResolvedValue({ isOnTopic: false, shouldUseRAG: false });
vi.mock('@/lib/chat-pipeline', () => ({
  classifyUserTopic: (...args: unknown[]) => mockClassifyUserTopic(...args),
  executeRAGPipeline: (...args: unknown[]) => mockExecuteRAGPipeline(...args),
  generateCitations: vi.fn().mockReturnValue([{ source: 'Building Code', page: 1, section: '1' }]),
  cacheResponse: (...args: unknown[]) => mockCacheResponse(...args),
  buildContext: vi.fn().mockReturnValue('ctx'),
  getOffTopicResponse: vi.fn().mockResolvedValue('Off topic response'),
  getGreetingResponse: vi.fn().mockResolvedValue('Greeting response'),
  CRAG_FAIL_RESPONSE: 'CRAG fail response',
}));

// Mock rag
vi.mock('@/lib/rag', () => ({
  buildContext: vi.fn().mockReturnValue(''),
}));

// Mock gemini
const mockStream = vi.fn();
vi.mock('@/lib/gemini', () => ({
  COMPLIANCE_SYSTEM_PROMPT: 'Test system prompt',
  getStreamingModel: () => ({
    stream: (...args: unknown[]) => mockStream(...args),
  }),
}));

// Mock langchain messages
vi.mock('@langchain/core/messages', () => ({
  HumanMessage: class { constructor(public content: string) {} },
  SystemMessage: class { constructor(public content: string) {} },
  AIMessage: class { constructor(public content: string) {} },
}));

// Mock constants
vi.mock('@/lib/constants', () => ({
  MAX_CONTEXT_LENGTH: 10000,
  MIN_CACHEABLE_RESPONSE_LENGTH: 50,
}));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/chat/stream/route';

function createRequest(body: object, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost:3000/api/chat/stream', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'Content-Type': 'application/json',
      // C31H: chat stream now requires Origin or Referer to match the host.
      // Provide a valid Origin by default; individual tests can override.
      Origin: 'http://localhost:3000',
      ...headers,
    },
  });
}

function makeAsyncIter(chunks: string[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const c of chunks) {
        yield { content: c };
      }
    },
  };
}

async function drainStream(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let out = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value);
  }
  return out;
}

describe('POST /api/chat/stream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue({ allowed: true });
    mockValidateCSRFToken.mockResolvedValue(true);
    mockClassifyUserTopic.mockResolvedValue({ isOnTopic: false, shouldUseRAG: false });
    mockExecuteRAGPipeline.mockResolvedValue({ chunks: [], queryEmbedding: new Array(768).fill(0), fromCache: false });
    mockStream.mockResolvedValue(makeAsyncIter(['Test response']));
  });

  it('should return 401 when unauthenticated', async () => {
    mockGetQuickSession.mockResolvedValue(null);

    const request = createRequest({ message: 'Hello' });
    const response = await POST(request);

    expect(response.status).toBe(401);
    const data = await response.json();
    // AUTH-C1 / v1.0.0 Part E: surface requireAuth's 'Authentication required'.
    expect(data.error).toBe('Authentication required');
  });

  it('should return 429 when rate limited', async () => {
    mockGetQuickSession.mockResolvedValue({ id: 'user-1', role: 'user' });
    mockCheckRateLimit.mockResolvedValue({ allowed: false, retryAfterMs: 5000 });

    const request = createRequest({ message: 'Hello' }, { 'x-csrf-token': 'valid-token' });
    const response = await POST(request);

    expect(response.status).toBe(429);
    const data = await response.json();
    expect(data.error).toBe('Rate limited');
    expect(data.retryAfter).toBe(5000);
  });

  // S-H-1 / v1.0.0 Part F: chat-stream must hit its dedicated 'chat' bucket,
  // not 'default', otherwise a chat burst silently shares the bucket with
  // every other endpoint and the per-endpoint limits (C11H/C22H) become moot.
  it('checks the dedicated chat rate-limit bucket', async () => {
    mockGetQuickSession.mockResolvedValue({ id: 'user-1', role: 'user' });
    mockCheckRateLimit.mockResolvedValue({ allowed: false, retryAfterMs: 5000 });

    const request = createRequest({ message: 'Hello' }, { 'x-csrf-token': 'valid-token' });
    await POST(request);

    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ endpoint: 'chat' }),
    );
  });

  it('should return 400 on invalid input (empty message)', async () => {
    mockGetQuickSession.mockResolvedValue({ id: 'user-1', role: 'user' });

    const request = createRequest({ message: '' }, { 'x-csrf-token': 'valid-token' });
    const response = await POST(request);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('Invalid input');
  });

  it('should return 400 on missing message field', async () => {
    mockGetQuickSession.mockResolvedValue({ id: 'user-1', role: 'user' });

    const request = createRequest({}, { 'x-csrf-token': 'valid-token' });
    const response = await POST(request);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('Invalid input');
  });

  it('should return 403 on session ownership violation', async () => {
    mockGetQuickSession.mockResolvedValue({ id: 'user-1', role: 'user' });

    // The mock supabase client returns { data: null, error: null } for session lookup
    // which means session not found → access denied
    const request = createRequest({
      message: 'Hello',
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
    }, { 'x-csrf-token': 'valid-token' });
    const response = await POST(request);

    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.error).toBe('Access denied');
  });

  it('should return 403 when both Origin and Referer are missing (C31H)', async () => {
    mockGetQuickSession.mockResolvedValue({ id: 'user-1', role: 'user' });

    // Build a NextRequest that has neither Origin nor Referer.
    const request = new NextRequest('http://localhost:3000/api/chat/stream', {
      method: 'POST',
      body: JSON.stringify({ message: 'Hello' }),
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'valid-token' },
    });
    const response = await POST(request);

    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.error).toBe('Origin or Referer required');
  });

  it('should accept Referer when Origin is missing (C31H)', async () => {
    mockGetQuickSession.mockResolvedValue({ id: 'user-1', role: 'user' });

    const request = new NextRequest('http://localhost:3000/api/chat/stream', {
      method: 'POST',
      body: JSON.stringify({ message: 'Hello world' }),
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': 'valid-token',
        Referer: 'http://localhost:3000/some-page',
      },
    });
    const response = await POST(request);

    // Origin not allowed would be 403; valid Referer should let it through.
    expect(response.status).toBe(200);
  });

  it('should return 403 on invalid CSRF token', async () => {
    mockGetQuickSession.mockResolvedValue({ id: 'user-1', role: 'user' });
    mockValidateCSRFToken.mockResolvedValue(false);

    const request = createRequest(
      { message: 'Hello' },
      { 'x-csrf-token': 'invalid-token' }
    );
    const response = await POST(request);

    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.error).toBe('Invalid CSRF token');
  });

  it('should return streaming response for valid request without session', async () => {
    mockGetQuickSession.mockResolvedValue({ id: 'user-1', role: 'user' });

    const request = createRequest({ message: 'Hello world' }, { 'x-csrf-token': 'valid-token' });
    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
  });

  it('should call checkRateLimit with user ID', async () => {
    mockGetQuickSession.mockResolvedValue({ id: 'user-123', role: 'user' });

    const request = createRequest({ message: 'Hello' }, { 'x-csrf-token': 'valid-token' });
    await POST(request);

    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      'user-123',
      expect.objectContaining({ endpoint: 'chat' }),
    );
  });

  it('should return 403 when no CSRF token provided', async () => {
    mockGetQuickSession.mockResolvedValue({ id: 'user-1', role: 'user' });

    const request = createRequest({ message: 'Hello world' });
    const response = await POST(request);

    // CSRF is now mandatory — missing token should return 403
    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.error).toBe('CSRF token required');
  });

  // ========================================================================
  // v1.3.0 Part B — SSE abort plumbing + cache-poisoning guard (A-C-2 / TS-H-5)
  // ========================================================================
  describe('streaming abort + cache poisoning guard', () => {
    function makePipelineWithChunks() {
      mockClassifyUserTopic.mockResolvedValue({ isOnTopic: true, shouldUseRAG: true });
      mockExecuteRAGPipeline.mockResolvedValue({
        chunks: [{ id: 1, content: 'x', metadata: { page: 1 }, similarity: 0.9 }],
        queryEmbedding: new Array(768).fill(0.1),
        fromCache: false,
      });
    }

    it('passes the request signal to getStreamingModel().stream()', async () => {
      mockGetQuickSession.mockResolvedValue({ id: 'user-1', role: 'user' });
      makePipelineWithChunks();
      mockStream.mockResolvedValueOnce(
        makeAsyncIter(['A long enough cacheable response with at least fifty characters!']),
      );

      const request = createRequest({ message: 'tell me about parking' }, { 'x-csrf-token': 'valid' });
      const response = await POST(request);
      await drainStream(response);

      const [, opts] = mockStream.mock.calls[0];
      expect(opts).toBeDefined();
      expect(opts).toHaveProperty('signal');
      expect(opts.signal).toBeInstanceOf(AbortSignal);
    });

    it('writes to cache when response length >= MIN_CACHEABLE_RESPONSE_LENGTH', async () => {
      mockGetQuickSession.mockResolvedValue({ id: 'user-1', role: 'user' });
      makePipelineWithChunks();
      mockStream.mockResolvedValueOnce(
        makeAsyncIter(['A long enough cacheable response with at least fifty characters!']),
      );

      const request = createRequest({ message: 'tell me about parking' }, { 'x-csrf-token': 'valid' });
      const response = await POST(request);
      await drainStream(response);

      // Allow fire-and-forget cacheResponse promise to dispatch.
      await new Promise(resolve => setImmediate(resolve));
      expect(mockCacheResponse).toHaveBeenCalledTimes(1);
    });

    it('does NOT write to cache when response length < MIN_CACHEABLE_RESPONSE_LENGTH (A-C-2)', async () => {
      mockGetQuickSession.mockResolvedValue({ id: 'user-1', role: 'user' });
      makePipelineWithChunks();
      // Short truncated reply — emulates an aborted / partial stream.
      mockStream.mockResolvedValueOnce(makeAsyncIter(['tiny']));

      const request = createRequest({ message: 'tell me about parking' }, { 'x-csrf-token': 'valid' });
      const response = await POST(request);
      await drainStream(response);

      await new Promise(resolve => setImmediate(resolve));
      expect(mockCacheResponse).not.toHaveBeenCalled();
    });

    it('does NOT write to cache when the request signal is aborted mid-stream', async () => {
      mockGetQuickSession.mockResolvedValue({ id: 'user-1', role: 'user' });
      makePipelineWithChunks();

      // Stream yields a few chunks; we'll abort the request before draining.
      const abortableIter = {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        signal: undefined as any,
        [Symbol.asyncIterator]: async function* () {
          yield { content: 'A long enough cacheable response with at least' };
          yield { content: ' fifty characters!' };
        },
      };
      mockStream.mockResolvedValueOnce(abortableIter);

      const controller = new AbortController();
      // Pre-abort so the stream's `for await` exits on first iteration.
      controller.abort();

      const request = new NextRequest('http://localhost:3000/api/chat/stream', {
        method: 'POST',
        body: JSON.stringify({ message: 'parking?' }),
        headers: {
          'Content-Type': 'application/json',
          'x-csrf-token': 'valid',
          Origin: 'http://localhost:3000',
        },
        signal: controller.signal,
      });
      const response = await POST(request);
      try { await drainStream(response); } catch { /* aborted */ }

      await new Promise(resolve => setImmediate(resolve));
      expect(mockCacheResponse).not.toHaveBeenCalled();
    });
  });
});
