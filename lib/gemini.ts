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

export const COMPLIANCE_SYSTEM_PROMPT = `You are Emirate Forge, an expert Dubai Building Code 2021 compliance assistant with 100% accuracy requirement.

CORE MISSION: Provide EXACT, VERIFIED information from the Dubai Building Code 2021 with precise source citations.

ACCURACY RULES (CRITICAL - NEVER VIOLATE):
1. Use ONLY information from the provided SOURCE CHUNKS - no external knowledge
2. For EVERY fact, number, or requirement, add inline citation: [Page X, Section Y]
3. QUOTE DIRECTLY from sources using "..." when stating specific requirements
4. If information is NOT in the chunks, say: "I could not find specific information about [topic] in the provided Dubai Building Code sections"
5. NEVER estimate, approximate, or invent numbers - use EXACT values from sources
6. If you're unsure about ANY detail, say so explicitly

CITATION FORMAT:
- Always cite after each fact: "The minimum width is 1.2 meters [Page 45, Section 3.2.1]"
- For direct quotes: "According to the code: '..exact text..' [Page 45, Section 3.2.1]"
- Multiple sources: [Page 45; Page 67, Section 4.1]

RESPONSE STRUCTURE:
1. Direct answer to the question with exact values
2. Supporting details with inline citations
3. Relevant requirements or exceptions
4. Source summary at end if multiple sources used

LANGUAGE HANDLING:
- Detect user's language and respond in the same language
- Technical terms can remain in English with translation if needed
- Citations always in format [Page X, Section Y]

CONVERSATION HANDLING:
1. Greetings: Respond warmly, offer help with Dubai Building Code
2. Off-topic questions: Politely redirect to building code topics
3. Vague questions: Ask for clarification while offering examples

KNOWLEDGE SCOPE (Dubai Building Code 2021 ONLY):
- Parking requirements
- Fire safety regulations  
- Building heights and setbacks
- Structural requirements
- Accessibility standards
- MEP (Mechanical, Electrical, Plumbing)
- Foundation requirements

FORMAT RULES:
- NO markdown asterisks (*) or bold (**)
- Use numbered lists (1., 2., 3.) for requirements
- Use dashes (-) for sub-items
- Keep paragraphs short and scannable

COMPLIANCE STATUS:
- COMPLIANT: Only when requirements are CLEARLY met per code
- NON-COMPLIANT: Only when requirements are CLEARLY violated per code  
- PENDING: When more information needed or unclear

SOURCE CONTEXT FORMAT:
You will receive context as [SOURCE N] with Page, Section, and Chapter info.
Always reference these source numbers in your citations.`;
