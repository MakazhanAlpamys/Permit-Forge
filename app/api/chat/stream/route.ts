import { NextRequest } from 'next/server';
import { createServerClient, checkRateLimit } from '@/lib/supabase';
import { getQuickSession } from '@/lib/auth';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { HumanMessage, SystemMessage, AIMessage } from '@langchain/core/messages';
import { COMPLIANCE_SYSTEM_PROMPT } from '@/lib/gemini';
import { queryDubaiCode, multiQuerySearch } from '@/lib/rag';
import { 
  expandQuery, 
  rerankChunks, 
  detectQueryType,
  classifyTopic,
  verifyAnswer
} from '@/lib/agents';
import { createSmartCitations, getCitationStats } from '@/lib/citation-parser';

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

    // Topic classification
    const topicClassification = await classifyTopic(trimmedMessage);
    
    if (!topicClassification.isOnTopic) {
      return new Response(
        "I'm Emirate Forge, a Dubai Building Code 2021 assistant. I can help you with questions about building regulations, parking requirements, fire safety, structural requirements, and more. Feel free to ask me anything about the Dubai Building Code!",
        { headers: { 'Content-Type': 'text/plain' } }
      );
    }

    if (!topicClassification.shouldUseRAG) {
      return new Response(
        "Hello! I'm Emirate Forge, your Dubai Building Code 2021 assistant. I can help you with:\n\n- **Parking requirements** for different building types\n- **Fire safety** regulations and exit requirements\n- **Building heights** and setback rules\n- **Structural requirements** and load specifications\n- **Accessibility** standards\n- **MEP systems** requirements\n\nJust ask me any question about the Dubai Building Code!",
        { headers: { 'Content-Type': 'text/plain' } }
      );
    }

    // RAG Pipeline
    const queryType = detectQueryType(trimmedMessage);
    
    // Query expansion
    let searchQueries = [trimmedMessage];
    if (queryType !== 'exact') {
      const expandedQueries = await expandQuery(trimmedMessage);
      searchQueries = expandedQueries.slice(0, 4);
    }

    // Hybrid search
    let chunks;
    if (searchQueries.length > 1) {
      chunks = await multiQuerySearch(searchQueries, 15);
    } else {
      const ragResult = await queryDubaiCode({
        query: trimmedMessage,
        matchThreshold: 0.4,
        matchCount: 25,
      });
      chunks = ragResult.chunks;
    }

    // Reranking
    if (chunks.length > 7) {
      chunks = await rerankChunks(trimmedMessage, chunks, 7);
    }

    // Build context
    const context = chunks.map((chunk, idx) => 
      `[SOURCE ${idx + 1}] Page ${chunk.metadata.page}, Section: ${chunk.metadata.section || 'N/A'}:\n"${chunk.content}"`
    ).join('\n\n');

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
          
          // Send smart citations at the end (parsed from AI response)
          if (chunks.length > 0) {
            // Quick verification to get confidence score
            let verificationConfidence = 50; // Default
            try {
              const verification = await verifyAnswer(fullContent, chunks, trimmedMessage);
              verificationConfidence = verification.confidence;
              console.log(`🔍 Verification: ${verification.isVerified ? '✓' : '✗'} (${verificationConfidence}%)`);
            } catch (e) {
              console.error('Verification error:', e);
            }
            
            // Use smart citations with verification confidence
            const citations = await createSmartCitations(
              fullContent, 
              chunks, 
              verificationConfidence,
              30 // Min confidence threshold
            );
            
            // Log stats for debugging
            const stats = getCitationStats(citations);
            console.log(`📊 Stream citations: ${stats.verified}/${stats.total} verified, confidence: ${verificationConfidence}`);
            
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
