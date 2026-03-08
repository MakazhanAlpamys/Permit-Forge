// ============================================================================
// Google Gemini AI Client Configuration (LangChain Integration)
// ============================================================================

import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { HumanMessage, SystemMessage, AIMessage } from '@langchain/core/messages';
import { GoogleGenAI } from '@google/genai';
import { MAX_MESSAGE_LENGTH, MAX_CONTEXT_LENGTH } from './constants';

// Environment variable validation
const geminiApiKey = process.env.GEMINI_API_KEY;

if (!geminiApiKey) {
  throw new Error('Configuration error: GEMINI_API_KEY environment variable is missing. Please set it in your .env file with a valid Google AI API key.');
}

// -----------------------------------------------------------------------------
// LangChain Models Configuration
// -----------------------------------------------------------------------------

// Chat model for compliance analysis - temperature=0 for deterministic responses
export const chatModel = new ChatGoogleGenerativeAI({
  model: 'gemini-2.5-flash', // Latest model for best quality
  apiKey: geminiApiKey,
  temperature: 0,
  maxOutputTokens: 4096,
  maxRetries: 0, // Disable retries to save quota
});

// Streaming chat model for API routes (same config but with streaming enabled)
export const streamingModel = new ChatGoogleGenerativeAI({
  model: 'gemini-2.5-flash',
  apiKey: geminiApiKey,
  temperature: 0,
  maxOutputTokens: 4096,
  streaming: true,
});

// New Google GenAI client for embeddings (gemini-embedding-001)
const genaiClient = new GoogleGenAI({ apiKey: geminiApiKey });

// Legacy LangChain embeddings model — kept for backward compatibility import
// Use generateEmbedding() or embedQuery() instead
export const embeddingsModel = {
  async embedQuery(text: string): Promise<number[]> {
    return generateEmbedding(text);
  },
  async embedDocuments(documents: string[]): Promise<number[][]> {
    return Promise.all(documents.map(doc => generateEmbedding(doc)));
  },
};

// -----------------------------------------------------------------------------
// Embedding Generation (@google/genai SDK — gemini-embedding-001, 768 dims)
// -----------------------------------------------------------------------------

/**
 * Custom error class for daily quota exhaustion — not retryable within the session.
 */
export class DailyQuotaExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DailyQuotaExhaustedError';
  }
}

/**
 * Generate embeddings using Gemini gemini-embedding-001
 * Returns a 768-dimensional vector (matching database VECTOR(768) columns)
 * Includes retry logic for network errors and per-minute rate limits (429).
 * Throws DailyQuotaExhaustedError immediately when daily quota is hit.
 */
export async function generateEmbedding(text: string, maxRetries = 7): Promise<number[]> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await genaiClient.models.embedContent({
        model: 'gemini-embedding-001',
        contents: text,
        config: { outputDimensionality: 768 },
      });
      const values = result.embeddings?.[0]?.values;
      if (!values || values.length === 0) {
        throw new Error('Embedding API returned empty vector');
      }
      return values;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const errorMessage = lastError.message;
      const errorLower = errorMessage.toLowerCase();

      // Check if it's a rate limit error (429 / RESOURCE_EXHAUSTED)
      const isRateLimit = errorLower.includes('429') ||
        errorLower.includes('resource_exhausted') ||
        errorLower.includes('quota');

      // Detect DAILY quota exhaustion (not retryable within this session)
      if (isRateLimit && errorLower.includes('perday')) {
        throw new DailyQuotaExhaustedError(
          `Daily embedding quota exhausted (free tier: 1000 requests/day). ` +
          `${attempt > 1 ? `Failed after ${attempt} attempts. ` : ''}` +
          `Please wait until tomorrow or upgrade your Gemini API plan.`
        );
      }

      // Check if it's a network error
      const isNetworkError = errorLower.includes('fetch failed') ||
        errorLower.includes('network') ||
        errorLower.includes('timeout') ||
        errorLower.includes('econnreset') ||
        errorLower.includes('socket');

      const isRetryable = isRateLimit || isNetworkError;

      if (!isRetryable || attempt === maxRetries) {
        console.error(`Embedding error (attempt ${attempt}/${maxRetries}):`, errorMessage);
        throw lastError;
      }

      // For per-minute rate limits: parse retryDelay from error or use longer backoff
      let delay: number;
      if (isRateLimit) {
        const retryMatch = errorMessage.match(/retry\s*(?:in|after|delay)?\s*[":]*\s*(\d+)/i);
        delay = retryMatch ? (parseInt(retryMatch[1]) + 5) * 1000 : 60000;
      } else {
        delay = Math.pow(2, attempt - 1) * 1000;
      }

      console.warn(`Embedding ${isRateLimit ? 'rate limited' : 'fetch failed'}, retrying in ${Math.round(delay / 1000)}s (attempt ${attempt}/${maxRetries})...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError || new Error('Failed to generate embedding');
}

// -----------------------------------------------------------------------------
// Chat Completion
// -----------------------------------------------------------------------------

export interface GeminiChatOptions {
  systemPrompt: string;
  userMessage: string;
  context?: string;
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

// -----------------------------------------------------------------------------
// Context Truncation - Prevent token overflow
// -----------------------------------------------------------------------------

// MAX_CONTEXT_LENGTH and MAX_MESSAGE_LENGTH imported from constants.ts

function truncateContext(context: string): string {
  if (context.length <= MAX_CONTEXT_LENGTH) return context;
  return context.slice(0, MAX_CONTEXT_LENGTH) + '\n[...context truncated]';
}

function sanitizeUserMessage(message: string): string {
  const trimmed = message.trim().slice(0, MAX_MESSAGE_LENGTH);
  return trimmed.replace(/\s+/g, ' ');
}

/**
 * Generate a chat completion with the compliance-focused system prompt
 * Uses LangChain ChatGoogleGenerativeAI
 */
export async function generateChatResponse(options: GeminiChatOptions): Promise<string> {
  const { systemPrompt, userMessage, context, conversationHistory = [] } = options;

  // Sanitize inputs
  const safeMessage = sanitizeUserMessage(userMessage);
  const safeContext = context ? truncateContext(context) : '';

  // Build user message with context
  const fullUserMessage = safeContext
    ? `CONTEXT:\n${safeContext}\n\nQ: ${safeMessage}`
    : `Q: ${safeMessage}`;

  // Build messages with conversation history for memory
  const messages = [
    new SystemMessage(systemPrompt),
  ];

  // Add last 10 messages from conversation history (5 exchanges)
  const recentHistory = conversationHistory.slice(-10);
  for (const msg of recentHistory) {
    if (msg.role === 'user') {
      messages.push(new HumanMessage(msg.content));
    } else {
      messages.push(new AIMessage(msg.content));
    }
  }

  // Add current message
  messages.push(new HumanMessage(fullUserMessage));

  const response = await chatModel.invoke(messages);
  const raw = response.content;
  return typeof raw === 'string'
    ? raw
    : Array.isArray(raw)
      ? raw.map(c => (typeof c === 'string' ? c : 'text' in c ? c.text : '')).join('')
      : String(raw);
}

// -----------------------------------------------------------------------------
// System Prompts
// -----------------------------------------------------------------------------

export const COMPLIANCE_SYSTEM_PROMPT = `You are PermitForge, a building code compliance assistant.

RULES:
1. Answer ONLY using the provided CONTEXT. Never invent information.
2. If the CONTEXT does not contain the answer, say: "I could not find this information in the available documents."
3. Do NOT write page numbers, section references, or citations in your response. Sources are displayed separately below your answer.
4. Be precise with numbers, measurements, and requirements — use EXACT values from sources.
5. Use bullet points and headers for clarity.
6. You can respond in any language the user writes in.
7. ALWAYS mention which document the information comes from (e.g., "According to the Building Code...").
8. When multiple documents address the same topic, present requirements from EACH document separately.

PERSONALITY:
- Be conversational, approachable, and professional
- Explain clearly without sounding like you're reading from a manual
- Be confident but honest when you don't have information

RESPONSE STYLE:
- Start with a direct answer
- Use numbered lists (1., 2., 3.) for requirements
- Bold (**text**) for key numbers or requirements
- Keep responses scannable

CONVERSATION HANDLING:
1. Greetings: Respond warmly, mention all available documents.
2. Off-topic: Gently redirect to building code topics.
3. Vague questions: Ask for clarification while being helpful.`;
