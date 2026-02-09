// ============================================================================
// Chat Export API Route — Exports a chat session as Markdown
// ============================================================================

import { NextRequest } from 'next/server';
import { getQuickSession } from '@/lib/auth';
import { createServerClient } from '@/lib/supabase-server';
import { uuidSchema } from '@/lib/validations';

export async function GET(request: NextRequest) {
  try {
    const user = await getQuickSession();
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const sessionId = request.nextUrl.searchParams.get('sessionId');
    if (!sessionId || !uuidSchema.safeParse(sessionId).success) {
      return Response.json({ error: 'Invalid session ID' }, { status: 400 });
    }

    const supabase = createServerClient();

    // Verify session ownership
    const { data: session } = await supabase
      .from('chat_sessions')
      .select('title, user_id, created_at')
      .eq('id', sessionId)
      .single();

    if (!session || session.user_id !== user.id) {
      return Response.json({ error: 'Access denied' }, { status: 403 });
    }

    // Fetch all messages
    const { data: messages, error } = await supabase
      .from('chat_messages')
      .select('role, content, citations, created_at')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true });

    if (error) {
      return Response.json({ error: 'Failed to fetch messages' }, { status: 500 });
    }

    // Build markdown
    const title = session.title || 'Chat Export';
    const exportDate = new Date().toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
    const sessionDate = new Date(session.created_at).toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric',
    });

    let markdown = `# ${title}\n\n`;
    markdown += `**Session started:** ${sessionDate}  \n`;
    markdown += `**Exported:** ${exportDate}  \n`;
    markdown += `**Messages:** ${(messages || []).length}\n\n---\n\n`;

    for (const msg of messages || []) {
      const role = msg.role === 'user' ? 'You' : 'Emirate Forge';
      markdown += `### ${role}\n\n`;
      markdown += `${msg.content}\n\n`;

      // Add citations if present
      if (msg.citations && Array.isArray(msg.citations) && msg.citations.length > 0) {
        markdown += `<details>\n<summary>Sources (${msg.citations.length})</summary>\n\n`;
        for (const citation of msg.citations) {
          const page = citation.page || citation.startPage || '?';
          const section = citation.section || '';
          const doc = citation.documentName || '';
          markdown += `- ${doc ? `[${doc}] ` : ''}Page ${page}${section ? `, Section ${section}` : ''}\n`;
        }
        markdown += `\n</details>\n\n`;
      }

      markdown += `---\n\n`;
    }

    markdown += `\n*Exported from Emirate Forge — Dubai Building Code Compliance Assistant*\n`;

    // Sanitize title for filename
    const safeTitle = title.replace(/[^a-zA-Z0-9-_ ]/g, '').slice(0, 50).trim() || 'chat-export';

    return new Response(markdown, {
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${safeTitle}.md"`,
        'Cache-Control': 'no-cache',
      },
    });
  } catch (error) {
    console.error('Chat export error:', error);
    return Response.json({ error: 'Export failed' }, { status: 500 });
  }
}
