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
vi.mock('@/lib/chat-pipeline', () => ({
  classifyUserTopic: vi.fn().mockResolvedValue({ isOnTopic: false, shouldUseRAG: false }),
  executeRAGPipeline: vi.fn().mockResolvedValue({ chunks: [], queryEmbedding: new Array(768).fill(0), fromCache: false }),
  generateCitations: vi.fn().mockReturnValue([]),
  cacheResponse: vi.fn().mockResolvedValue(undefined),
  buildContext: vi.fn().mockReturnValue(''),
  getOffTopicResponse: vi.fn().mockResolvedValue('Off topic response'),
  getGreetingResponse: vi.fn().mockResolvedValue('Greeting response'),
  CRAG_FAIL_RESPONSE: 'CRAG fail response',
}));

// Mock rag
vi.mock('@/lib/rag', () => ({
  buildContext: vi.fn().mockReturnValue(''),
}));

// Mock gemini
vi.mock('@/lib/gemini', () => ({
  COMPLIANCE_SYSTEM_PROMPT: 'Test system prompt',
  streamingModel: {
    stream: vi.fn().mockResolvedValue({
      [Symbol.asyncIterator]: async function* () {
        yield { content: 'Test response' };
      },
    }),
  },
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
}));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/chat/stream/route';

function createRequest(body: object, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost:3000/api/chat/stream', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'Content-Type': 'application/json',
      // L13: route now requires Origin on POST. Tests run as same-origin.
      'Origin': 'http://localhost:3000',
      ...headers,
    },
  });
}

describe('POST /api/chat/stream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue({ allowed: true });
    mockValidateCSRFToken.mockResolvedValue(true);
  });

  it('should return 401 when unauthenticated', async () => {
    mockGetQuickSession.mockResolvedValue(null);

    const request = createRequest({ message: 'Hello' });
    const response = await POST(request);

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe('Unauthorized');
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

    expect(mockCheckRateLimit).toHaveBeenCalledWith('user-123');
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
});
