import { NextRequest } from 'next/server';
import { createAdminClient, checkRateLimit } from '@/lib/supabase-server';
import { validateCSRFToken } from '@/lib/auth';
import { requireAuth } from '@/lib/security';
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
import { applySecurityHeaders } from '@/lib/api-security-headers';

// A6: every Response leaving this route must carry the security headers from
// applySecurityHeaders. jsonError() centralizes the boilerplate for the JSON
// error responses; streaming success responses wrap their own Response below.
function jsonError(payload: Record<string, unknown>, status: number): Response {
  return applySecurityHeaders(
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

export async function POST(request: NextRequest) {
  try {
    // =========================================================================
    // SECURITY: Authentication check
    // =========================================================================
    // AUTH-C1 / v1.0.0 Part E: route through `requireAuth` so the same JWT.tv
    // vs. users.token_version comparison the Edge middleware does on page nav
    // also fires on this API surface (matcher excludes `/api/*`).
    const auth = await requireAuth();
    if (!auth.success || !auth.user) {
      return jsonError({ error: auth.error || 'Unauthorized' }, 401);
    }
    const user = auth.user;

    // =========================================================================
    // SECURITY: Origin/Referer validation + CSRF (mandatory)
    // =========================================================================
    // C31H/L13: previously the check was skipped entirely when Origin was
    // absent (some legitimate clients drop it). Treat Referer as a fallback;
    // reject only when BOTH are missing — this preserves the legitimate-client
    // path while closing the silent-bypass.
    const origin = request.headers.get('origin');
    const referer = request.headers.get('referer');
    const allowedHost = request.nextUrl.host;
    const checkHost = origin ?? referer;
    if (!checkHost) {
      return jsonError({ error: 'Origin or Referer required' }, 403);
    }
    try {
      const sourceHost = new URL(checkHost).host;
      if (sourceHost !== allowedHost) {
        return jsonError({ error: 'Origin not allowed' }, 403);
      }
    } catch {
      return jsonError({ error: 'Invalid origin' }, 403);
    }

    const csrfToken = request.headers.get('x-csrf-token');
    if (!csrfToken) {
      return jsonError({ error: 'CSRF token required' }, 403);
    }
    const csrfValid = await validateCSRFToken(csrfToken);
    if (!csrfValid) {
      return jsonError({ error: 'Invalid CSRF token' }, 403);
    }

    // =========================================================================
    // SECURITY: Rate limiting
    // =========================================================================
    // S-H-1 / v1.0.0 Part F: hit the dedicated 'chat' bucket (C11H/C22H), not
    // the shared 'default' bucket — otherwise chat bursts can starve any
    // other endpoint that lands in 'default' (and vice versa).
    const rateLimitResult = await checkRateLimit(user.id, { endpoint: 'chat' });
    if (!rateLimitResult.allowed) {
      return jsonError({ error: 'Rate limited', retryAfter: rateLimitResult.retryAfterMs }, 429);
    }

    // =========================================================================
    // SECURITY: Input validation with Zod
    // =========================================================================
    const body = await request.json();
    const validation = chatMessageSchema.safeParse(body);

    if (!validation.success) {
      return jsonError({ error: 'Invalid input', details: validation.error.issues[0].message }, 400);
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
        return jsonError({ error: 'Access denied' }, 403);
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

        return applySecurityHeaders(
          new Response(stream, {
            headers: {
              'Content-Type': 'text/plain; charset=utf-8',
              'Transfer-Encoding': 'chunked',
              'Cache-Control': 'no-cache',
            },
          }),
        );
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

        return applySecurityHeaders(
          new Response(stream, {
            headers: {
              'Content-Type': 'text/plain; charset=utf-8',
              'Transfer-Encoding': 'chunked',
              'Cache-Control': 'no-cache',
            },
          }),
        );
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

    return applySecurityHeaders(
      new Response(stream, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Transfer-Encoding': 'chunked',
          'Cache-Control': 'no-cache',
        },
      }),
    );
  } catch (error) {
    console.error('Chat stream error:', error);
    return jsonError({ error: 'Internal server error', code: 'INTERNAL_ERROR' }, 500);
  }
}
