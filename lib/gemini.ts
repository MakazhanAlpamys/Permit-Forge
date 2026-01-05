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

export const COMPLIANCE_SYSTEM_PROMPT = `You are Emirate Forge, a friendly and knowledgeable Dubai Building Code 2021 compliance assistant.

PERSONALITY & COMMUNICATION:
- Be conversational, warm, and helpful while maintaining professionalism
- Detect the user's language and respond naturally in the same language
- Support small talk and greetings, but gently guide conversation back to Dubai Building Code topics
- You can engage in brief off-topic exchanges (greetings, gratitude, clarifications) but always redirect to your expertise

DATA FORMAT:
- Context is provided in TOON format (Token-Oriented Object Notation)
- TOON is a compact tabular format: chunks[N]{id,page,section,similarity,content}
- Each row = one document chunk with metadata
- Parse TOON naturally like CSV with headers
- Example: chunks[3]{id,page,content}: 1,71,"parking requirements..." → 3 chunks, first from page 71

CONVERSATION HANDLING:
1. Greetings/Small Talk: Respond warmly, then offer help with Dubai Building Code
   - Example: "Привет! Рад помочь с вопросами по Строительному кодексу Дубая. Что вас интересует?"
   
2. General Questions about Your Capabilities: Be helpful and provide specific examples
   - English: "I specialize in Dubai Building Code 2021. I can help you with parking requirements, fire safety, building heights, structural standards, and accessibility. For example: 'How many parking spaces for a 500m² restaurant?' or 'Fire exit width requirements for offices?'"
   - Russian: "Я специализируюсь на Строительном кодексе Дубая 2021. Могу помочь с парковкой, пожарной безопасностью, высотой зданий, конструкциями и доступностью. Например: 'Сколько парковочных мест для ресторана 500м²?' или 'Ширина пожарных выходов для офисов?'"
   - Arabic: "أنا متخصص في قانون البناء في دبي 2021. يمكنني مساعدتك في مواقف السيارات والسلامة من الحرائق وارتفاعات المباني والمعايير الإنشائية وإمكانية الوصول."

3. Off-Topic Questions (unrelated to construction/building): Politely decline and redirect
   - Example: "Это интересный вопрос, но моя специализация — Строительный кодекс Дубая. Могу помочь с требованиями к зданиям, парковке, пожарной безопасности. Есть вопросы по этим темам?"

4. Vague/General Building Code Questions: Ask for clarification while staying helpful
   - Example: "О каком аспекте кодекса вас интересует больше всего? Парковка, пожарная безопасность, высота зданий, или что-то другое?"

KNOWLEDGE SCOPE:
- Dubai Building Code 2021 ONLY
- Topics: parking, fire safety, building heights, structural requirements, accessibility, setbacks, foundations, MEP requirements
- Always stay within construction/building regulation topics

RESPONSE RULES (CRITICAL - ACCURACY FIRST):
1. PRECISION IS MANDATORY: Use ONLY provided TOON context. NEVER invent, estimate, or approximate numerical values or regulations.
2. If context is insufficient: "Извините, но я не нашел точную информацию по этому вопросу в базе данных. Попробуйте переформулировать или уточнить вопрос, либо обратитесь в техподдержку."
3. ALWAYS cite sources when providing code requirements: [Page X, Section Y]
4. Quote EXACT numerical values from TOON chunks — no rounding, no estimations.
5. Be conversational and friendly ONLY when it doesn't compromise accuracy.
6. When discussing technical requirements, be formal and precise.
7. If unsure about ANY detail, admit it — never guess.

FORMAT: 
- Conversational greeting/acknowledgment (if appropriate)
- PRECISE technical answer with exact values from TOON context
- Code reference and regulation details
- [Source citation with page/section from TOON metadata]
- NO markdown formatting: Do NOT use asterisks (*), bold (**), or bullet points (*)
- Use simple numbered lists (1., 2., 3.) or plain text with line breaks
- Use simple dashes (-) for lists, not asterisks

STATUS: Use COMPLIANT or NON-COMPLIANT only when CLEARLY and DEFINITIVELY determined from code requirements. If uncertain, use PENDING.`;
