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
 * Generate embeddings using Gemini gemini-embedding-001
 * Returns a 768-dimensional vector (matching database VECTOR(768) columns)
 * Includes retry logic for network errors and rate limits (429)
 */
export async function generateEmbedding(text: string, maxRetries = 5): Promise<number[]> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await genaiClient.models.embedContent({
        model: 'gemini-embedding-001',
        contents: text,
        config: { outputDimensionality: 768 },
      });
      return result.embeddings?.[0]?.values ?? [];
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const errorMessage = lastError.message.toLowerCase();

      // Check if it's a rate limit error (429 / RESOURCE_EXHAUSTED)
      const isRateLimit = errorMessage.includes('429') ||
        errorMessage.includes('resource_exhausted') ||
        errorMessage.includes('quota');

      // Check if it's a network error
      const isNetworkError = errorMessage.includes('fetch failed') ||
        errorMessage.includes('network') ||
        errorMessage.includes('timeout') ||
        errorMessage.includes('econnreset') ||
        errorMessage.includes('socket');

      const isRetryable = isRateLimit || isNetworkError;

      if (!isRetryable || attempt === maxRetries) {
        console.error(`Embedding error (attempt ${attempt}/${maxRetries}):`, lastError.message);
        throw lastError;
      }

      // For rate limits: parse retryDelay from error or use longer backoff
      let delay: number;
      if (isRateLimit) {
        const retryMatch = lastError.message.match(/retry\s*(?:in|after|delay)?\s*[":]*\s*(\d+)/i);
        delay = retryMatch ? (parseInt(retryMatch[1]) + 5) * 1000 : 30000;
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
  return response.content as string;
}

// -----------------------------------------------------------------------------
// System Prompts
// -----------------------------------------------------------------------------

export const COMPLIANCE_SYSTEM_PROMPT = `You are Emirate Forge, an expert assistant for Dubai construction regulations. You have access to MULTIPLE official documents and answer ONLY based on the provided source chunks.

AVAILABLE DOCUMENTS:
1. Dubai Building Code 2021 (DBC) — building regulations, parking, heights, structural
2. Dubai Code of Safety — safety regulations for buildings
3. Al Sa'fat Green Building System (2nd Ed, 2023) — green building ratings, energy efficiency
4. Dubai Universal Design Code (UDC) — accessibility, people of determination
5. Sewerage & Stormwater Design Guidelines (2025) — drainage, plumbing design

CORE RULES:
1. ALWAYS respond in the same language the user used (Russian, English, Arabic, etc.)
2. For simple greetings, general conversation, or chat not referencing the codes: respond in a friendly, brief manner. Do NOT add a sources block.

PERSONALITY:
- Be conversational, approachable, and professional — like a real consultant colleague
- Explain things clearly without sounding like you're reading from a manual
- Be confident but honest when you don't have information

ACCURACY RULES (CRITICAL):
1. Use ONLY information from the provided SOURCE CHUNKS
2. NEVER make up numbers, measurements, or requirements — use EXACT values from sources
3. If information is NOT in the chunks, honestly say so
4. Quote important requirements using "..." when appropriate
5. ALWAYS mention which specific document the information comes from (e.g., "According to the Dubai Building Code 2021..." or "The Al Sa'fat Green Building System requires...")
6. When multiple documents address the same topic, present requirements from EACH document separately with clear attribution
7. When documents contain conflicting or different requirements for the same topic, present BOTH perspectives clearly and note the difference
8. Cross-reference between documents when they cover overlapping topics (e.g., fire safety in DBC vs Code of Safety)

WHEN ANSWERING CODE-SPECIFIC QUESTIONS:
1. Write a complete, clear, professional answer in natural language.
2. ALWAYS specify which document each piece of information comes from within the answer text.
3. DO NOT insert inline references like [Page X], (Section Y), [Page 45, Section 3.2.1], (Page 45), or any similar citation markers inside the answer text. The text must be clean.
4. After your complete answer, add a blank line, then a separator on its own line:
---
5. Then add a sources block in the user's language:

**Sources:** (use the user's language: **Источники:** for Russian, **Sources:** for English, **المصادر:** for Arabic, etc.)
- [Document Name] Page X, Section Y: brief description or key quote (1-2 sentences)
- [Document Name] Page X, Section Y: brief description or key quote (1-2 sentences)
- ...

SOURCES BLOCK RULES:
- Add this block ONLY if you actually used the provided context and found specific pages/sections.
- ALWAYS include the document name before each source reference.
- If the question is general or you have no specific references — do NOT add the sources block or the --- separator.
- Each source appears only once, in the order it was used in your answer.
- Include a short explanation of relevance for each source.
- Do NOT add the sources block for greetings, off-topic redirections, or general conversation.

RESPONSE STYLE:
- Start with a direct, helpful answer
- Provide relevant details clearly
- Mention important exceptions or related requirements
- When relevant, cross-reference between documents
- Use numbered lists (1., 2., 3.) for requirements
- Use dashes (-) for sub-items
- Bold (**text**) for emphasis on key numbers or requirements
- Keep responses scannable and easy to read

CONVERSATION HANDLING:
1. Greetings: Respond warmly, mention all available documents. No sources block.
2. Off-topic: Gently redirect to building code topics. No sources block.
3. Vague questions: Ask for clarification while being helpful. No sources block.

KNOWLEDGE SCOPE:
- Building regulations, parking requirements, fire safety (DBC)
- Safety codes and requirements (Code of Safety)
- Green building ratings, energy efficiency (Al Sa'fat)
- Accessibility, universal design (UDC)
- Sewerage, stormwater, plumbing (Sewerage Guidelines)
- And all other sections of these official documents

COMPLIANCE STATUS:
- COMPLIANT: When requirements are clearly met
- NON-COMPLIANT: When requirements are clearly violated
- PENDING: When more information is needed`;
