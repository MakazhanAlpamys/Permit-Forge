// ============================================================================
// E5: lib/gemini.ts coverage
// ============================================================================
// Focus on the embedding retry loop + DailyQuotaExhaustedError detection +
// generateChatResponse context/history shaping. The real Google SDKs are
// expensive and stateful; we mock both @google/genai and @langchain/google-genai.
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ----------------------------------------------------------------------------
// Mocks
// ----------------------------------------------------------------------------

const mockEmbedContent = vi.fn();

vi.mock('@google/genai', () => {
  class GoogleGenAIMock {
    models = { embedContent: mockEmbedContent };
    constructor(_: { apiKey: string }) {
      void _;
    }
  }
  return { GoogleGenAI: GoogleGenAIMock };
});

const mockInvoke = vi.fn();

vi.mock('@langchain/google-genai', () => {
  class ChatGoogleGenerativeAIMock {
    invoke = mockInvoke;
    constructor(_: unknown) {
      void _;
    }
  }
  return { ChatGoogleGenerativeAI: ChatGoogleGenerativeAIMock };
});

// Real LangChain message classes are tiny and pure so we can use the real ones.
// Vitest's resolver will use the actual implementation.

// ----------------------------------------------------------------------------
// Imports (after mocks)
// ----------------------------------------------------------------------------

import {
  generateEmbedding,
  embeddingsModel,
  DailyQuotaExhaustedError,
  generateChatResponse,
  getChatModel,
  getStreamingModel,
} from '@/lib/gemini';

beforeEach(() => {
  vi.clearAllMocks();
});

// ----------------------------------------------------------------------------
// generateEmbedding
// ----------------------------------------------------------------------------

describe('generateEmbedding', () => {
  it('returns the 768-dim vector on first-try success', async () => {
    const vec = new Array(768).fill(0.123);
    mockEmbedContent.mockResolvedValueOnce({ embeddings: [{ values: vec }] });

    const out = await generateEmbedding('hello');

    expect(out).toEqual(vec);
    expect(mockEmbedContent).toHaveBeenCalledTimes(1);
    expect(mockEmbedContent).toHaveBeenCalledWith({
      model: 'gemini-embedding-001',
      contents: 'hello',
      config: { outputDimensionality: 768 },
    });
  });

  it('throws on empty vector response', async () => {
    mockEmbedContent.mockResolvedValueOnce({ embeddings: [{ values: [] }] });

    await expect(generateEmbedding('x', 1)).rejects.toThrow(/empty vector/);
  });

  it('throws on missing values field', async () => {
    mockEmbedContent.mockResolvedValueOnce({ embeddings: [{}] });

    await expect(generateEmbedding('x', 1)).rejects.toThrow(/empty vector/);
  });

  it('retries on network errors with exponential backoff', async () => {
    const vec = [0.1, 0.2, 0.3];
    mockEmbedContent
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce({ embeddings: [{ values: vec }] });

    // Use fake timers to keep the exponential backoff from actually sleeping.
    vi.useFakeTimers();
    const promise = generateEmbedding('q', 5);
    // First failure → setTimeout(1000); second → setTimeout(2000).
    await vi.runAllTimersAsync();
    const out = await promise;
    vi.useRealTimers();

    expect(out).toEqual(vec);
    expect(mockEmbedContent).toHaveBeenCalledTimes(3);
  });

  it('immediately throws DailyQuotaExhaustedError on perday quota messages', async () => {
    mockEmbedContent.mockRejectedValueOnce(
      new Error('429 RESOURCE_EXHAUSTED: quota perday limit exceeded'),
    );

    await expect(generateEmbedding('q', 3)).rejects.toBeInstanceOf(
      DailyQuotaExhaustedError,
    );
    expect(mockEmbedContent).toHaveBeenCalledTimes(1);
  });

  it('retries per-minute 429s up to maxRetries then re-throws', async () => {
    mockEmbedContent
      .mockRejectedValueOnce(new Error('429 quota: retry after 1'))
      .mockRejectedValueOnce(new Error('429 quota: retry after 1'));

    vi.useFakeTimers();
    const promise = generateEmbedding('q', 2);
    // Swallow the rejection here so vitest sees it as handled before the
    // backoff timer resolves; awaiting after runAllTimersAsync is racy.
    const caught = promise.catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const result = await caught;
    vi.useRealTimers();

    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/429/);
    expect(mockEmbedContent).toHaveBeenCalledTimes(2);
  });

  it('does not retry on non-retryable errors', async () => {
    mockEmbedContent.mockRejectedValueOnce(new Error('Invalid API key'));

    await expect(generateEmbedding('q', 5)).rejects.toThrow(/Invalid API key/);
    expect(mockEmbedContent).toHaveBeenCalledTimes(1);
  });
});

// ----------------------------------------------------------------------------
// embeddingsModel back-compat shim
// ----------------------------------------------------------------------------

describe('embeddingsModel shim', () => {
  it('embedQuery delegates to generateEmbedding', async () => {
    const vec = new Array(768).fill(0.5);
    mockEmbedContent.mockResolvedValueOnce({ embeddings: [{ values: vec }] });

    const out = await embeddingsModel.embedQuery('hello');
    expect(out).toEqual(vec);
  });

  it('embedDocuments calls generateEmbedding per document', async () => {
    const vec = new Array(768).fill(1);
    mockEmbedContent.mockResolvedValue({ embeddings: [{ values: vec }] });

    const out = await embeddingsModel.embedDocuments(['a', 'b', 'c']);
    expect(out).toHaveLength(3);
    expect(mockEmbedContent).toHaveBeenCalledTimes(3);
  });
});

// ----------------------------------------------------------------------------
// generateChatResponse — context truncation + history cap + role mapping
// ----------------------------------------------------------------------------

describe('generateChatResponse', () => {
  it('sends system + user message + context to the chat model', async () => {
    mockInvoke.mockResolvedValueOnce({ content: 'answer' });

    const answer = await generateChatResponse({
      systemPrompt: 'sys',
      userMessage: 'what is parking?',
      context: 'small context',
    });

    expect(answer).toBe('answer');
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    const messages = mockInvoke.mock.calls[0][0];
    // System message + 1 human message (no history)
    expect(messages).toHaveLength(2);
    // Last message contains the context + question
    const last = messages[1];
    expect(last.content).toContain('CONTEXT:');
    expect(last.content).toContain('small context');
    expect(last.content).toContain('Q: what is parking?');
  });

  it('truncates context beyond MAX_CONTEXT_LENGTH (12000 chars)', async () => {
    mockInvoke.mockResolvedValueOnce({ content: 'answer' });
    const long = 'X'.repeat(20_000);

    await generateChatResponse({
      systemPrompt: 's',
      userMessage: 'q',
      context: long,
    });

    const last = mockInvoke.mock.calls[0][0].at(-1).content as string;
    expect(last).toContain('[...context truncated]');
    expect(last.length).toBeLessThan(20_000);
  });

  it('caps conversation history at the last 10 messages', async () => {
    mockInvoke.mockResolvedValueOnce({ content: 'answer' });

    const longHistory = Array.from({ length: 30 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `m${i}`,
    }));

    await generateChatResponse({
      systemPrompt: 's',
      userMessage: 'q',
      conversationHistory: longHistory,
    });

    const messages = mockInvoke.mock.calls[0][0];
    // system + 10 history + 1 final user = 12
    expect(messages).toHaveLength(12);
    // First history message should be the LAST 10 from longHistory (i.e. m20)
    expect(messages[1].content).toBe('m20');
  });

  it('joins array content blocks from the model into a string', async () => {
    mockInvoke.mockResolvedValueOnce({
      content: [{ text: 'hello ' }, { text: 'world' }],
    });

    const answer = await generateChatResponse({
      systemPrompt: 's',
      userMessage: 'q',
    });
    expect(answer).toBe('hello world');
  });

  it('coerces non-string non-array content via String()', async () => {
    mockInvoke.mockResolvedValueOnce({ content: 42 });
    const answer = await generateChatResponse({ systemPrompt: 's', userMessage: 'q' });
    expect(answer).toBe('42');
  });

  it('sanitizes user message: trims, slices to MAX_MESSAGE_LENGTH, collapses whitespace', async () => {
    mockInvoke.mockResolvedValueOnce({ content: 'ok' });
    await generateChatResponse({
      systemPrompt: 's',
      userMessage: '  multi\n\n  whitespace\t \t input  ',
    });

    const last = mockInvoke.mock.calls[0][0].at(-1).content as string;
    // No tabs or newlines remain inside the question.
    expect(last).toContain('Q: multi whitespace input');
  });
});

// ----------------------------------------------------------------------------
// getChatModel / getStreamingModel — lazy singleton
// ----------------------------------------------------------------------------

describe('chat model singletons', () => {
  it('getChatModel returns the same instance on repeated calls', () => {
    const a = getChatModel();
    const b = getChatModel();
    expect(a).toBe(b);
  });

  it('getStreamingModel returns the same instance on repeated calls', () => {
    const a = getStreamingModel();
    const b = getStreamingModel();
    expect(a).toBe(b);
  });

  it('getChatModel throws when GEMINI_API_KEY is missing', async () => {
    const original = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      // Reset module to force re-init of the lazy singleton.
      vi.resetModules();
      const { getChatModel: freshGetChatModel } = await import('@/lib/gemini');
      expect(() => freshGetChatModel()).toThrow(/GEMINI_API_KEY/);
    } finally {
      process.env.GEMINI_API_KEY = original;
    }
  });
});
