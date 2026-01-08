// ============================================================================
// Google Gemini AI Client Configuration (LangChain Integration)
// ============================================================================

import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { GoogleGenerativeAIEmbeddings } from '@langchain/google-genai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';

// Environment variable validation
const geminiApiKey = process.env.GEMINI_API_KEY;

if (!geminiApiKey) {
  throw new Error('Missing GEMINI_API_KEY environment variable');
}

// -----------------------------------------------------------------------------
// LangChain Models Configuration
// -----------------------------------------------------------------------------

// Chat model for compliance analysis - temperature=0 for deterministic responses
const chatModel = new ChatGoogleGenerativeAI({
  model: 'gemini-2.5-flash', // Latest model for best quality
  apiKey: geminiApiKey,
  temperature: 0,
  maxOutputTokens: 2048,
  maxRetries: 0, // Disable retries to save quota
});

// Embedding model for vector generation (768 dimensions)
export const embeddingsModel = new GoogleGenerativeAIEmbeddings({
  model: 'text-embedding-004',
  apiKey: geminiApiKey,
});

// -----------------------------------------------------------------------------
// Embedding Generation (LangChain wrapper)
// -----------------------------------------------------------------------------

/**
 * Generate embeddings for a single text using Gemini text-embedding-004
 * Returns a 768-dimensional vector
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  return embeddingsModel.embedQuery(text);
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
const MAX_USER_MESSAGE_LENGTH = 500; // Prevent spam

function truncateContext(context: string): string {
  if (context.length <= MAX_CONTEXT_LENGTH) return context;
  return context.slice(0, MAX_CONTEXT_LENGTH) + '\n[...context truncated]';
}

function sanitizeUserMessage(message: string): string {
  const trimmed = message.trim().slice(0, MAX_USER_MESSAGE_LENGTH);
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
      messages.push(new SystemMessage(`Assistant: ${msg.content}`));
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

export const COMPLIANCE_SYSTEM_PROMPT = `You are Emirate Forge, a friendly and knowledgeable Dubai Building Code consultant. Think of yourself as a helpful colleague who knows the code inside and out.

PERSONALITY:
- Be conversational and approachable, like a real consultant
- Explain things clearly without sounding like you're reading from a manual
- Use natural language, not robotic responses
- Be confident but honest when you don't have information
- Show expertise through clear, practical explanations

ACCURACY RULES (CRITICAL):
1. Use ONLY information from the provided SOURCE CHUNKS
2. Add inline citations naturally: [Page X, Section Y]
3. Quote important requirements using "..." when needed
4. If information is NOT in the chunks, say something like: "I don't have that specific information in my sources, but I can tell you about related topics"
5. NEVER make up numbers or requirements - use EXACT values from sources
6. Be honest about limitations

CITATION FORMAT:
- Cite naturally within sentences: "You'll need a minimum width of 1.2 meters [Page 45, Section 3.2.1]"
- For important quotes: "The code states: '..exact text..' [Page 45]"

RESPONSE STYLE:
1. Start with a direct, helpful answer
2. Provide relevant details with natural citations
3. Mention important exceptions or related requirements
4. End with a helpful note if appropriate

LANGUAGE:
- Detect user's language and respond in the same language
- Keep technical terms clear and understandable

CONVERSATION HANDLING:
1. Greetings: Respond warmly and offer to help with building code questions
2. Off-topic: Gently redirect to building code topics
3. Vague questions: Ask for clarification while being helpful

KNOWLEDGE SCOPE (Dubai Building Code 2021):
- Parking requirements
- Fire safety regulations  
- Building heights and setbacks
- Structural requirements
- Accessibility standards
- MEP systems
- Foundation requirements

FORMAT RULES:
- Use numbered lists (1., 2., 3.) for requirements
- Use dashes (-) for sub-items
- Keep responses scannable and easy to read
- Bold (**text**) for emphasis on key numbers or requirements

COMPLIANCE STATUS:
- COMPLIANT: When requirements are clearly met
- NON-COMPLIANT: When requirements are clearly violated
- PENDING: When more information is needed`;
