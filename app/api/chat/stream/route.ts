import { NextRequest } from 'next/server';
import { createAdminClient, checkRateLimit } from '@/lib/supabase-server';
import { getQuickSession, validateCSRFToken } from '@/lib/auth';
import { chatMessageSchema } from '@/lib/validations';
import { HumanMessage, SystemMessage, AIMessage } from '@langchain/core/messages';
import { COMPLIANCE_SYSTEM_PROMPT, streamingModel } from '@/lib/gemini';
import { MAX_CONTEXT_LENGTH } from '@/lib/constants';
import {
  classifyUserTopic,
  executeRAGPipeline,
  verifyAIResponse,
  generateCitations,
} from '@/lib/chat-pipeline';
import { buildContext } from '@/lib/rag';
import type { MatchedChunk } from '@/types';

export async function POST(request: NextRequest) {
  try {
    // =========================================================================
    // SECURITY: Authentication check
    // =========================================================================
    const user = await getQuickSession();
    if (!user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { 
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // =========================================================================
    // SECURITY: CSRF validation (mandatory)
    // =========================================================================
    const csrfToken = request.headers.get('x-csrf-token');
    if (!csrfToken) {
      return new Response(JSON.stringify({ error: 'CSRF token required' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    const csrfValid = await validateCSRFToken(csrfToken);
    if (!csrfValid) {
      return new Response(JSON.stringify({ error: 'Invalid CSRF token' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // =========================================================================
    // SECURITY: Rate limiting
    // =========================================================================
    const rateLimitResult = await checkRateLimit(user.id);
    if (!rateLimitResult.allowed) {
      return new Response(JSON.stringify({ 
        error: 'Rate limited', 
        retryAfter: rateLimitResult.retryAfterMs 
      }), { 
        status: 429,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // =========================================================================
    // SECURITY: Input validation with Zod
    // =========================================================================
    const body = await request.json();
    const validation = chatMessageSchema.safeParse(body);
    
    if (!validation.success) {
      return new Response(JSON.stringify({ 
        error: 'Invalid input',
        details: validation.error.issues[0].message 
      }), { 
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const { message, sessionId } = validation.data;
    const trimmedMessage = message.trim().slice(0, 500);

    // =========================================================================
    // SECURITY: Session ownership verification
    // =========================================================================
    if (sessionId) {
      const supabase = createAdminClient();
      const { data: session, error } = await supabase
        .from('chat_sessions')
        .select('user_id')
        .eq('id', sessionId)
        .single();
      
      if (error || !session || session.user_id !== user.id) {
        return new Response(JSON.stringify({ error: 'Access denied' }), { 
          status: 403,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // Topic classification using centralized pipeline
    const topicClassification = await classifyUserTopic(trimmedMessage);

    // Execute RAG only for on-topic queries that need it
    // Greetings and off-topic go through LLM without RAG context (for multilingual support)
    let chunks: MatchedChunk[] = [];
    if (topicClassification.isOnTopic && topicClassification.shouldUseRAG) {
      chunks = await executeRAGPipeline(trimmedMessage);
    }

    // Build context using centralized function from rag.ts
    const context = buildContext(chunks);

    // Load conversation history
    let conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    if (sessionId) {
      const supabase = createAdminClient();
      const { data: messages } = await supabase
        .from('chat_messages')
        .select('role, content')
        .eq('session_id', sessionId)
        .order('created_at', { ascending: true })
        .limit(10);
      
      if (messages) {
        conversationHistory = messages.map(m => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        }));
      }
    }

    // Build messages
    const fullUserMessage = context
      ? `CONTEXT:\n${context.slice(0, MAX_CONTEXT_LENGTH)}\n\nQ: ${trimmedMessage}`
      : `Q: ${trimmedMessage}`;

    const langchainMessages = [
      new SystemMessage(COMPLIANCE_SYSTEM_PROMPT),
      ...conversationHistory.slice(-10).map(msg => 
        msg.role === 'user' 
          ? new HumanMessage(msg.content) 
          : new AIMessage(msg.content)
      ),
      new HumanMessage(fullUserMessage),
    ];

    // Create streaming response
    const encoder = new TextEncoder();
    
    const stream = new ReadableStream({
      async start(controller) {
        try {
          const streamResponse = await streamingModel.stream(langchainMessages);
          let fullContent = '';
          
          for await (const chunk of streamResponse) {
            const text = chunk.content as string;
            if (text) {
              fullContent += text;
              controller.enqueue(encoder.encode(text));
            }
          }
          
          // Send smart citations at the end using centralized functions
          if (chunks.length > 0) {
            // Verification to get confidence score
            let verificationConfidence = 30;
            try {
              const { verificationResult } = await verifyAIResponse(fullContent, chunks, trimmedMessage);
              verificationConfidence = verificationResult.confidence;
              console.log(`🔍 Verification: ${verificationResult.isVerified ? '✓' : '✗'} (${verificationConfidence}%)`);
            } catch (e) {
              console.error('Verification error:', e);
            }
            
            // Use centralized citation generation
            const citations = await generateCitations(fullContent, chunks, verificationConfidence);
            
            controller.enqueue(encoder.encode(`\n\n__CITATIONS__${JSON.stringify(citations)}`));
          }
          
          controller.close();
        } catch (error) {
          console.error('Streaming error:', error);
          const errorMsg = error instanceof Error ? error.message : 'Stream processing failed';
          try {
            controller.enqueue(encoder.encode(
              `\n\n__ERROR__${JSON.stringify({ code: 'STREAM_ERROR', message: errorMsg })}`
            ));
            controller.close();
          } catch {
            controller.error(error);
          }
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache',
      },
    });
  } catch (error) {
    console.error('Chat stream error:', error);
    return new Response(JSON.stringify({
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
