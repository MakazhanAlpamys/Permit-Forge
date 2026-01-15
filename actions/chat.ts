'use server';

// ============================================================================
// Chat Server Action with Advanced RAG Pipeline
// ============================================================================

import { generateChatResponse, COMPLIANCE_SYSTEM_PROMPT } from '@/lib/gemini';
import { 
  classifyUserTopic,
  executeRAGPipeline,
  buildContextFromChunks,
  verifyAIResponse,
  generateCitations,
  OFF_TOPIC_RESPONSE,
  GREETING_RESPONSE,
  CHAT_PIPELINE_CONFIG,
} from '@/lib/chat-pipeline';
import { checkRateLimit } from '@/lib/supabase-server';
import { getSession } from '@/lib/auth';
import type { 
  ChatRequest, 
  ChatResponse, 
  ComplianceStatus,
} from '@/types';

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const MAX_MESSAGE_LENGTH = 500;

// -----------------------------------------------------------------------------
// Input Validation
// -----------------------------------------------------------------------------

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
// Main Chat Action with Advanced RAG Pipeline
// -----------------------------------------------------------------------------

export async function sendChatMessage(request: ChatRequest): Promise<ChatResponse> {
  try {
    const { message, sessionId } = request;

    // Get current user for rate limiting
    const user = await getSession();
    if (!user) {
      return {
        message: 'Please log in to use the chat.',
        citations: [],
        complianceStatus: 'pending',
      };
    }

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

    // Rate limiting (Supabase-based)
    const rateCheck = await checkRateLimit(user.id);
    if (!rateCheck.allowed) {
      const seconds = Math.ceil((rateCheck.retryAfterMs || 0) / 1000);
      return {
        message: `Too many requests. Please wait ${seconds} seconds before trying again.`,
        citations: [],
        complianceStatus: 'pending',
      };
    }

    const trimmedMessage = message.trim();

    // =========================================================================
    // STEP 0: Topic Classification (Skip RAG for off-topic/greetings)
    // =========================================================================
    const topicClassification = await classifyUserTopic(trimmedMessage);
    
    if (!topicClassification.isOnTopic) {
      return {
        message: OFF_TOPIC_RESPONSE,
        citations: [],
        complianceStatus: 'pending',
      };
    }

    if (!topicClassification.shouldUseRAG) {
      return {
        message: GREETING_RESPONSE,
        citations: [],
        complianceStatus: 'pending',
      };
    }

    // =========================================================================
    // STEP 1-4: RAG Pipeline (Query Expansion → Search → Rerank)
    // =========================================================================
    const chunks = await executeRAGPipeline(trimmedMessage);

    // =========================================================================
    // STEP 5: Generate Answer with Citations
    // =========================================================================
    const context = buildContextFromChunks(chunks);

    const responseText = await generateChatResponse({
      systemPrompt: COMPLIANCE_SYSTEM_PROMPT,
      userMessage: message,
      context: context,
      conversationHistory,
    });

    // =========================================================================
    // STEP 6: Answer Verification (Self-check for hallucinations)
    // =========================================================================
    let finalResponse = responseText;
    let verificationConfidence = 50;

    if (CHAT_PIPELINE_CONFIG.ENABLE_VERIFICATION && chunks.length > 0) {
      const { verifiedResponse, verificationResult } = await verifyAIResponse(
        responseText,
        chunks,
        trimmedMessage
      );
      finalResponse = verifiedResponse;
      verificationConfidence = verificationResult.confidence;
    }

    // =========================================================================
    // STEP 7: Extract Smart Citations
    // =========================================================================
    const citations = await generateCitations(finalResponse, chunks, verificationConfidence);

    // =========================================================================
    // STEP 8: Determine Compliance Status
    // =========================================================================
    const complianceStatus = determineComplianceStatus(finalResponse);

    return {
      message: finalResponse,
      citations,
      complianceStatus,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      message: `Error processing request: ${errorMessage}. Please check your configuration and try again.`,
      citations: [],
      complianceStatus: 'pending',
    };
  }
}

// -----------------------------------------------------------------------------
// Compliance Status Determination
// -----------------------------------------------------------------------------

function determineComplianceStatus(responseText: string): ComplianceStatus {
  const lowerResponse = responseText.toLowerCase();

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

  return 'pending';
}
