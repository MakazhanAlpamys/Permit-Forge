'use server';

// ============================================================================
// Chat Server Action with Advanced RAG Pipeline
// ============================================================================

import { queryDubaiCode, multiQuerySearch } from '@/lib/rag';
import { generateChatResponse, COMPLIANCE_SYSTEM_PROMPT } from '@/lib/gemini';
import { 
  expandQuery, 
  rerankChunks, 
  verifyAnswer, 
  detectQueryType,
  classifyTopic
} from '@/lib/agents';
import { checkRateLimit } from '@/lib/supabase';
import { getSession } from '@/lib/auth';
import type { 
  ChatRequest, 
  ChatResponse, 
  Citation, 
  ComplianceStatus,
  MatchedChunk,
  EnhancedCitation,
  VerifiedAnswer
} from '@/types';

// -----------------------------------------------------------------------------
// Configuration: Advanced RAG Pipeline
// -----------------------------------------------------------------------------

const ENABLE_QUERY_EXPANSION = true;    // Generate multiple search queries
const ENABLE_RERANKING = true;          // AI-powered relevance scoring
const ENABLE_VERIFICATION = true;       // Self-check for hallucinations
const MAX_EXPANDED_QUERIES = 4;         // Max queries after expansion
const RERANK_TOP_K = 7;                 // Keep top 7 after reranking

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
    
    console.log('🚀 Starting Advanced RAG Pipeline...');
    console.log(`📝 Query: "${trimmedMessage}"`);

    // =========================================================================
    // STEP 0: Topic Classification (Skip RAG for off-topic/greetings)
    // =========================================================================
    console.log('🎯 Classifying topic...');
    const topicClassification = await classifyTopic(trimmedMessage);
    
    if (!topicClassification.isOnTopic) {
      console.log('❌ Off-topic query detected, responding without RAG');
      return {
        message: "I'm Emirate Forge, a Dubai Building Code 2021 assistant. I can help you with questions about building regulations, parking requirements, fire safety, structural requirements, and more. Feel free to ask me anything about the Dubai Building Code!",
        citations: [],
        complianceStatus: 'pending',
      };
    }

    if (!topicClassification.shouldUseRAG) {
      console.log('👋 Greeting detected, responding without RAG');
      return {
        message: "Hello! I'm Emirate Forge, your Dubai Building Code 2021 assistant. I can help you with:\n\n- **Parking requirements** for different building types\n- **Fire safety** regulations and exit requirements\n- **Building heights** and setback rules\n- **Structural requirements** and load specifications\n- **Accessibility** standards\n- **MEP systems** requirements\n\nJust ask me any question about the Dubai Building Code!",
        citations: [],
        complianceStatus: 'pending',
      };
    }

    console.log('✅ On-topic query, proceeding with RAG pipeline');

    // =========================================================================
    // STEP 1: Query Type Detection
    // =========================================================================
    const queryType = detectQueryType(trimmedMessage);
    console.log(`🔍 Query type detected: ${queryType}`);

    // =========================================================================
    // STEP 2: Query Expansion (Generate multiple search variations)
    // =========================================================================
    let searchQueries = [trimmedMessage];
    
    if (ENABLE_QUERY_EXPANSION && queryType !== 'exact') {
      console.log('🔄 Expanding query...');
      const expandedQueries = await expandQuery(trimmedMessage);
      searchQueries = expandedQueries.slice(0, MAX_EXPANDED_QUERIES);
      console.log(`✅ Generated ${searchQueries.length} query variations`);
    }

    // =========================================================================
    // STEP 3: Hybrid Search (Vector + Keyword with RRF)
    // =========================================================================
    console.log('🔍 Performing hybrid search...');
    let chunks: MatchedChunk[];
    
    if (searchQueries.length > 1) {
      // Multi-query search with RRF fusion
      chunks = await multiQuerySearch(searchQueries, 15);
    } else {
      // Single query hybrid search
      const ragResult = await queryDubaiCode({
        query: trimmedMessage,
        matchThreshold: 0.4,  // Lower threshold for hybrid
        matchCount: 25,       // Get more for reranking
      });
      chunks = ragResult.chunks;
    }
    
    console.log(`✅ Found ${chunks.length} relevant chunks`);

    // =========================================================================
    // STEP 4: Re-ranking (AI-powered relevance scoring)
    // =========================================================================
    if (ENABLE_RERANKING && chunks.length > RERANK_TOP_K) {
      console.log('📊 Re-ranking chunks by relevance...');
      chunks = await rerankChunks(trimmedMessage, chunks, RERANK_TOP_K);
      console.log(`✅ Selected top ${chunks.length} most relevant chunks`);
    }

    // =========================================================================
    // STEP 5: Generate Answer with Citations
    // =========================================================================
    console.log('💬 Generating answer with citations...');
    
    // Build context for answer generation
    const context = chunks.map((chunk, idx) => 
      `[SOURCE ${idx + 1}] Page ${chunk.metadata.page}, Section: ${chunk.metadata.section || 'N/A'}, Chapter: ${chunk.metadata.chapter || 'N/A'}:\n"${chunk.content}"`
    ).join('\n\n');

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
    let verificationResult: VerifiedAnswer | null = null;

    if (ENABLE_VERIFICATION && chunks.length > 0) {
      console.log('✔️ Verifying answer against sources...');
      verificationResult = await verifyAnswer(responseText, chunks, trimmedMessage);
      
      if (!verificationResult.isVerified && verificationResult.confidence < 50) {
        // Low confidence - add disclaimer
        finalResponse = responseText + '\n\n⚠️ Note: I could not fully verify all details in this response against the source documents. Please cross-reference with the official Dubai Building Code.';
      }
      
      console.log(`✅ Verification complete (confidence: ${verificationResult.confidence}%)`);
    }

    // =========================================================================
    // STEP 7: Extract Enhanced Citations
    // =========================================================================
    const citations = extractEnhancedCitations(chunks, verificationResult);

    // =========================================================================
    // STEP 8: Determine Compliance Status
    // =========================================================================
    const complianceStatus = determineComplianceStatus(finalResponse);

    console.log('🎉 Advanced RAG Pipeline complete!');

    return {
      message: finalResponse,
      citations,
      complianceStatus,
    };
  } catch (error) {
    console.error('❌ Chat error:', error);
    return {
      message: 'I apologize, but I encountered an error processing your request. Please try again.',
      citations: [],
      complianceStatus: 'pending',
    };
  }
}

// -----------------------------------------------------------------------------
// Enhanced Citation Extraction
// -----------------------------------------------------------------------------

function extractEnhancedCitations(
  chunks: MatchedChunk[], 
  verificationResult: VerifiedAnswer | null
): Citation[] {
  // If we have verification result with enhanced citations, use those
  if (verificationResult?.citations && verificationResult.citations.length > 0) {
    return verificationResult.citations.map((ec: EnhancedCitation, idx: number) => ({
      chunkId: ec.chunkId,
      page: ec.page,
      section: ec.section,
      excerpt: ec.exactQuote || ec.context.slice(0, 200),
      similarity: ec.similarity,
    }));
  }

  // Fallback to standard extraction
  return chunks.slice(0, 5).map(chunk => ({
    chunkId: chunk.id,
    page: chunk.metadata.page || 0,
    section: chunk.metadata.section,
    excerpt: truncateExcerpt(chunk.content, 200),
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
