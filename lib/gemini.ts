// ============================================================================
// Google Gemini AI Client Configuration (LangChain Integration)
// ============================================================================

import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { GoogleGenerativeAIEmbeddings } from '@langchain/google-genai';
import { HumanMessage, SystemMessage, AIMessage } from '@langchain/core/messages';
import { MAX_MESSAGE_LENGTH } from './constants';

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
  maxOutputTokens: 2048,
  maxRetries: 0, // Disable retries to save quota
});

// Streaming chat model for API routes (same config but with streaming enabled)
export const streamingModel = new ChatGoogleGenerativeAI({
  model: 'gemini-2.5-flash',
  apiKey: geminiApiKey,
  temperature: 0,
  maxOutputTokens: 2048,
  streaming: true,
});

// Embedding model for vector generation (768 dimensions)
export const embeddingsModel = new GoogleGenerativeAIEmbeddings({
  model: 'text-embedding-004',
  apiKey: geminiApiKey,
});

// -----------------------------------------------------------------------------
// Embedding Generation (LangChain wrapper with retry logic)
// -----------------------------------------------------------------------------

/**
 * Generate embeddings for a single text using Gemini text-embedding-004
 * Returns a 768-dimensional vector
 * Includes retry logic for transient network errors
 */
export async function generateEmbedding(text: string, maxRetries = 3): Promise<number[]> {
  let lastError: Error | null = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await embeddingsModel.embedQuery(text);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      // Check if it's a network/fetch error (retryable)
      const errorMessage = lastError.message.toLowerCase();
      const isRetryable = errorMessage.includes('fetch failed') || 
                          errorMessage.includes('network') ||
                          errorMessage.includes('timeout') ||
                          errorMessage.includes('econnreset') ||
                          errorMessage.includes('socket');
      
      if (!isRetryable || attempt === maxRetries) {
        console.error(`Embedding error (attempt ${attempt}/${maxRetries}):`, lastError.message);
        throw lastError;
      }
      
      // Exponential backoff: 1s, 2s, 4s
      const delay = Math.pow(2, attempt - 1) * 1000;
      console.warn(`Embedding fetch failed, retrying in ${delay}ms (attempt ${attempt}/${maxRetries})...`);
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

const MAX_CONTEXT_LENGTH = 6000; // ~1500 tokens
// MAX_MESSAGE_LENGTH imported from constants.ts

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

  // Add last 6 messages from conversation history (3 exchanges)
  const recentHistory = conversationHistory.slice(-6);
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

export const COMPLIANCE_SYSTEM_PROMPT = `You are Emirate Forge, an expert assistant for the Dubai Building Code 2021. You answer ONLY based on the provided source documents (PDF context).

CORE RULES:
1. ALWAYS respond in the same language the user used (Russian, English, Arabic, etc.)
2. For simple greetings, general conversation, or chat not referencing the code: respond in a friendly, brief manner. Do NOT add a sources block.

PERSONALITY:
- Be conversational, approachable, and professional — like a real consultant colleague
- Explain things clearly without sounding like you're reading from a manual
- Be confident but honest when you don't have information

ACCURACY RULES (CRITICAL):
1. Use ONLY information from the provided SOURCE CHUNKS
2. NEVER make up numbers, measurements, or requirements — use EXACT values from sources
3. If information is NOT in the chunks, honestly say so
4. Quote important requirements using "..." when appropriate

WHEN ANSWERING CODE-SPECIFIC QUESTIONS:
1. Write a complete, clear, professional answer in natural language.
2. DO NOT insert inline references like [Page X], (Section Y), [Page 45, Section 3.2.1], (Page 45), or any similar citation markers inside the answer text. The text must be clean.
3. After your complete answer, add a blank line, then a separator on its own line:
---
4. Then add a sources block in the user's language:

**Sources:** (use the user's language: **Источники:** for Russian, **Sources:** for English, **المصادر:** for Arabic, etc.)
- Page X, Section Y: brief description or key quote (1-2 sentences)
- Page X, Section Y: brief description or key quote (1-2 sentences)
- ...

SOURCES BLOCK RULES:
- Add this block ONLY if you actually used the provided context and found specific pages/sections.
- If the question is general or you have no specific references — do NOT add the sources block or the --- separator.
- Each source appears only once, in the order it was used in your answer.
- Include a short explanation of relevance for each source.
- Do NOT add the sources block for greetings, off-topic redirections, or general conversation.

RESPONSE STYLE:
- Start with a direct, helpful answer
- Provide relevant details clearly
- Mention important exceptions or related requirements
- Use numbered lists (1., 2., 3.) for requirements
- Use dashes (-) for sub-items
- Bold (**text**) for emphasis on key numbers or requirements
- Keep responses scannable and easy to read

CONVERSATION HANDLING:
1. Greetings: Respond warmly, offer to help with building code questions. No sources block.
2. Off-topic: Gently redirect to building code topics. No sources block.
3. Vague questions: Ask for clarification while being helpful. No sources block.

KNOWLEDGE SCOPE (Dubai Building Code 2021):
- Parking requirements, fire safety regulations
- Building heights and setbacks
- Structural requirements, foundation requirements
- Accessibility standards, MEP systems
- Vertical transportation, seismic requirements
- Energy efficiency, glazing, insulation
- And all other sections of the code

COMPLIANCE STATUS:
- COMPLIANT: When requirements are clearly met
- NON-COMPLIANT: When requirements are clearly violated
- PENDING: When more information is needed`;
