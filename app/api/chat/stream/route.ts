import { NextRequest } from 'next/server';
import { createAdminClient, checkRateLimit } from '@/lib/supabase-server';
import { getQuickSession, validateCSRFToken } from '@/lib/auth';
import { chatMessageSchema } from '@/lib/validations';
import { HumanMessage, SystemMessage, AIMessage } from '@langchain/core/messages';
import { COMPLIANCE_SYSTEM_PROMPT, getStreamingModel } from '@/lib/gemini';
import { MAX_CONTEXT_LENGTH } from '@/lib/constants';
import {
  classifyUserTopic,
  executeRAGPipeline,
  generateCitations,
  cacheResponse,
  buildContext,
  CRAG_FAIL_RESPONSE,
} from '@/lib/chat-pipeline';

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
    // SECURITY: Origin validation + CSRF (mandatory)
    // =========================================================================
    const origin = request.headers.get('origin');
    if (origin) {
      const allowedHost = request.nextUrl.host;
      try {
        const originHost = new URL(origin).host;
        if (originHost !== allowedHost) {
          return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      } catch {
        return new Response(JSON.stringify({ error: 'Invalid origin' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

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

    // Topic classification
    const topicClassification = await classifyUserTopic(trimmedMessage);

    // Execute RAG only for on-topic queries that need it
    let pipelineResult: Awaited<ReturnType<typeof executeRAGPipeline>> | null = null;

    if (topicClassification.isOnTopic && topicClassification.shouldUseRAG) {
      pipelineResult = await executeRAGPipeline(trimmedMessage);

      // Cache hit — return cached response directly
      if (pipelineResult.fromCache && pipelineResult.cachedResponse) {
        const encoder = new TextEncoder();
        const cachedCitations = pipelineResult.cachedCitations || [];

        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(pipelineResult!.cachedResponse!));
            if (cachedCitations.length > 0) {
              controller.enqueue(encoder.encode(`\n\n__CITATIONS__${JSON.stringify(cachedCitations)}`));
            }
            controller.close();
          },
        });

        return new Response(stream, {
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Transfer-Encoding': 'chunked',
            'Cache-Control': 'no-cache',
          },
        });
      }

      // CRAG failed — no good results found
      if (pipelineResult.chunks.length === 0) {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(CRAG_FAIL_RESPONSE));
            controller.close();
          },
        });

        return new Response(stream, {
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Transfer-Encoding': 'chunked',
            'Cache-Control': 'no-cache',
          },
        });
      }
    }

    // Build context from chunks
    const chunks = pipelineResult?.chunks || [];
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

    // Build messages for LLM
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
          const streamResponse = await getStreamingModel().stream(langchainMessages);
          let fullContent = '';

          for await (const chunk of streamResponse) {
            const raw = chunk.content;
            const text = typeof raw === 'string'
              ? raw
              : Array.isArray(raw)
                ? raw.map(c => (typeof c === 'string' ? c : 'text' in c ? c.text : '')).join('')
                : String(raw);
            if (text) {
              fullContent += text;
              controller.enqueue(encoder.encode(text));
            }
          }

          // Chunk-based citations (0 API calls)
          if (chunks.length > 0) {
            const citations = generateCitations(chunks);
            controller.enqueue(encoder.encode(`\n\n__CITATIONS__${JSON.stringify(citations)}`));

            // Cache the response for future similar queries (fire-and-forget)
            if (pipelineResult?.queryEmbedding) {
              cacheResponse(trimmedMessage, pipelineResult.queryEmbedding, fullContent, citations)
                .catch(err => console.warn('Cache store failed:', err));
            }
          }

          controller.close();
        } catch (error) {
          console.error('Streaming error:', error);
          try {
            controller.enqueue(encoder.encode(
              `\n\n__ERROR__${JSON.stringify({ code: 'STREAM_ERROR', message: 'An error occurred while generating a response' })}`
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
