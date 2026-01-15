import { NextRequest } from 'next/server';
import { createServerClient, checkRateLimit } from '@/lib/supabase';
import { getQuickSession } from '@/lib/auth';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { HumanMessage, SystemMessage, AIMessage } from '@langchain/core/messages';
import { COMPLIANCE_SYSTEM_PROMPT } from '@/lib/gemini';
import {
  classifyUserTopic,
  executeRAGPipeline,
  buildContextFromChunks,
  verifyAIResponse,
  generateCitations,
  OFF_TOPIC_RESPONSE,
  GREETING_RESPONSE,
} from '@/lib/chat-pipeline';

// Streaming chat model
const streamingModel = new ChatGoogleGenerativeAI({
  model: 'gemini-2.5-flash',
  apiKey: process.env.GEMINI_API_KEY!,
  temperature: 0,
  maxOutputTokens: 2048,
  streaming: true,
});

export async function POST(request: NextRequest) {
  try {
    // Auth check using proper JWT verification
    const user = await getQuickSession();
    if (!user) {
      return new Response('Unauthorized', { status: 401 });
    }

    // Rate limit using consolidated function
    const rateLimitResult = await checkRateLimit(user.id);
    if (!rateLimitResult.allowed) {
      return new Response('Rate limited', { status: 429 });
    }

    const { message, sessionId } = await request.json();
    
    if (!message || typeof message !== 'string') {
      return new Response('Message required', { status: 400 });
    }

    const trimmedMessage = message.trim().slice(0, 500);

    // Topic classification using centralized pipeline
    const topicClassification = await classifyUserTopic(trimmedMessage);
    
    if (!topicClassification.isOnTopic) {
      return new Response(OFF_TOPIC_RESPONSE, { headers: { 'Content-Type': 'text/plain' } });
    }

    if (!topicClassification.shouldUseRAG) {
      return new Response(GREETING_RESPONSE, { headers: { 'Content-Type': 'text/plain' } });
    }

    // Execute RAG Pipeline using centralized module
    const chunks = await executeRAGPipeline(trimmedMessage);

    // Build context using centralized function
    const context = buildContextFromChunks(chunks);

    // Load conversation history
    let conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    if (sessionId) {
      const supabase = createServerClient();
      const { data: messages } = await supabase
        .from('chat_messages')
        .select('role, content')
        .eq('session_id', sessionId)
        .order('created_at', { ascending: true })
        .limit(6);
      
      if (messages) {
        conversationHistory = messages.map(m => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        }));
      }
    }

    // Build messages
    const fullUserMessage = context 
      ? `CONTEXT:\n${context.slice(0, 6000)}\n\nQ: ${trimmedMessage}` 
      : `Q: ${trimmedMessage}`;

    const langchainMessages = [
      new SystemMessage(COMPLIANCE_SYSTEM_PROMPT),
      ...conversationHistory.slice(-6).map(msg => 
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
            let verificationConfidence = 50;
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
          controller.error(error);
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
    return new Response('Internal error', { status: 500 });
  }
}
