'use server';

// ============================================================================
// Chat Server Action with Rate Limiting
// ============================================================================

import { queryDubaiCode } from '@/lib/rag';
import { generateChatResponse, COMPLIANCE_SYSTEM_PROMPT } from '@/lib/gemini';
import type { 
  ChatRequest, 
  ChatResponse, 
  Citation, 
  ComplianceStatus,
  MatchedChunk 
} from '@/types';

// -----------------------------------------------------------------------------
// Rate Limiting Configuration
// -----------------------------------------------------------------------------

const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 10; // Max 10 requests per minute
const MIN_REQUEST_INTERVAL_MS = 2000; // Min 2 seconds between requests

// Simple in-memory rate limiter (use Redis in production)
const requestLog: Map<string, number[]> = new Map();
let lastRequestTime = 0;

function checkRateLimit(clientId: string = 'default'): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  
  // Check minimum interval between requests
  if (now - lastRequestTime < MIN_REQUEST_INTERVAL_MS) {
    return { allowed: false, retryAfter: MIN_REQUEST_INTERVAL_MS - (now - lastRequestTime) };
  }
  
  // Get request history for this client
  const requests = requestLog.get(clientId) || [];
  
  // Filter to only requests within the window
  const recentRequests = requests.filter(time => now - time < RATE_LIMIT_WINDOW_MS);
  
  if (recentRequests.length >= MAX_REQUESTS_PER_WINDOW) {
    const oldestRequest = recentRequests[0];
    const retryAfter = RATE_LIMIT_WINDOW_MS - (now - oldestRequest);
    return { allowed: false, retryAfter };
  }
  
  // Update request log
  recentRequests.push(now);
  requestLog.set(clientId, recentRequests);
  lastRequestTime = now;
  
  return { allowed: true };
}

// -----------------------------------------------------------------------------
// Input Validation
// -----------------------------------------------------------------------------

const MAX_MESSAGE_LENGTH = 500;

function validateMessage(message: string): { valid: boolean; error?: string } {
  if (!message || typeof message !== 'string') {
    return { valid: false, error: 'Message is required' };
  }
  
  const trimmed = message.trim();
  
  if (trimmed.length === 0) {
    return { valid: false, error: 'Message is required' };
  }
  
  if (trimmed.length > MAX_MESSAGE_LENGTH) {
    return { valid: false, error: `Message too long (max ${MAX_MESSAGE_LENGTH} characters)` };
  }
  
  return { valid: true };
}

// -----------------------------------------------------------------------------
// Main Chat Action
// -----------------------------------------------------------------------------

export async function sendChatMessage(request: ChatRequest): Promise<ChatResponse> {
  try {
    const { message, sessionId } = request;

    // Load conversation history if sessionId exists
    let conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    if (sessionId) {
      const { getSessionMessages } = await import('@/actions/chat-history');
      const { messages } = await getSessionMessages(sessionId);
      conversationHistory = messages.map(msg => ({
        role: msg.role,
        content: msg.content,
      }));
    }

    // Input validation
    const validation = validateMessage(message);
    if (!validation.valid) {
      return {
        message: validation.error || 'Invalid input',
        citations: [],
        complianceStatus: 'pending',
      };
    }

    // Rate limiting
    const rateCheck = checkRateLimit();
    if (!rateCheck.allowed) {
      const seconds = Math.ceil((rateCheck.retryAfter || 0) / 1000);
      return {
        message: `Too many requests. Please wait ${seconds} seconds before trying again.`,
        citations: [],
        complianceStatus: 'pending',
      };
    }

    const trimmedMessage = message.trim();
    
    // Step 1: Get RAG context from Dubai Building Code
    // Note: Using original message - AI will handle any language in the query
    // Gemini embeddings support multilingual queries naturally
    const ragResult = await queryDubaiCode({
      query: trimmedMessage, // Use original message, no translation needed
      matchThreshold: 0.70,
      matchCount: 5,
    });

    // Step 2: Generate response using Gemini (with conversation history)
    const responseText = await generateChatResponse({
      systemPrompt: COMPLIANCE_SYSTEM_PROMPT,
      userMessage: message, // Original message to detect user's language
      context: ragResult.context, // ONLY PDF context, no TOON
      conversationHistory, // Previous messages for context
    });

    // Step 3: Extract citations from matched chunks
    const citations = extractCitations(ragResult.chunks);

    // Step 4: Determine compliance status
    const complianceStatus = determineComplianceStatus(responseText);

    return {
      message: responseText,
      citations,
      complianceStatus,
    };
  } catch (error) {
    console.error('Chat error:', error);
    return {
      message: 'I apologize, but I encountered an error processing your request. Please try again.',
      citations: [],
      complianceStatus: 'pending',
    };
  }
}

// -----------------------------------------------------------------------------
// Citation Extraction
// -----------------------------------------------------------------------------

function extractCitations(chunks: MatchedChunk[]): Citation[] {
  return chunks.map(chunk => ({
    chunkId: chunk.id,
    page: chunk.metadata.page || 0,
    section: chunk.metadata.section,
    excerpt: truncateExcerpt(chunk.content, 150),
    similarity: chunk.similarity,
  }));
}

function truncateExcerpt(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.substring(0, maxLength).trim() + '...';
}

// -----------------------------------------------------------------------------
// Compliance Status Determination
// -----------------------------------------------------------------------------

function determineComplianceStatus(responseText: string): ComplianceStatus {
  const lowerResponse = responseText.toLowerCase();

  // Check for explicit compliance indicators
  const compliantIndicators = [
    'is compliant',
    'meets the requirement',
    'satisfies the code',
    'complies with',
    'within the allowed',
    'acceptable',
    'permitted',
  ];

  const nonCompliantIndicators = [
    'is not compliant',
    'non-compliant',
    'does not meet',
    'violates',
    'exceeds the maximum',
    'below the minimum',
    'not permitted',
    'not allowed',
    'insufficient',
  ];

  const reviewIndicators = [
    'requires review',
    'needs verification',
    'should be verified',
    'consult with',
    'depends on',
    'may require',
    'additional information needed',
    'unclear',
    'not enough information',
  ];

  // Check for non-compliant first (most critical)
  for (const indicator of nonCompliantIndicators) {
    if (lowerResponse.includes(indicator)) {
      return 'non-compliant';
    }
  }

  // Check for compliant
  for (const indicator of compliantIndicators) {
    if (lowerResponse.includes(indicator)) {
      return 'compliant';
    }
  }

  // Default to pending
  return 'pending';
}
