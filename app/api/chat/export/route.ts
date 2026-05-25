// ============================================================================
// Chat Export API Route — Exports a chat session as Markdown
// ============================================================================

import { NextRequest } from 'next/server';
import { requireAuth } from '@/lib/security';
import { createAdminClient } from '@/lib/supabase-server';
import { uuidSchema } from '@/lib/validations';
import { applySecurityHeaders } from '@/lib/api-security-headers';
import { contentDispositionAttachment } from '@/lib/http-headers';

/**
 * Escape characters that have special meaning inside a Markdown table cell.
 * Pipes split cells, backticks open inline code, leading/trailing whitespace
 * confuses some renderers. We only use this on attacker-controlled fields
 * (document name, section, title) that flow into the citation list. (C19H/M9)
 */
function mdEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/`/g, '\\`');
}

export async function GET(request: NextRequest) {
  try {
    // AUTH-C1 / v1.0.0 Part E: route through `requireAuth` so JWT.tv vs.
    // users.token_version is enforced here too (Edge matcher skips `/api/*`).
    const auth = await requireAuth();
    if (!auth.success || !auth.user) {
      return applySecurityHeaders(
        Response.json({ error: auth.error || 'Unauthorized' }, { status: 401 }),
      );
    }
    const user = auth.user;

    const sessionId = request.nextUrl.searchParams.get('sessionId');
    if (!sessionId || !uuidSchema.safeParse(sessionId).success) {
      return applySecurityHeaders(Response.json({ error: 'Invalid session ID' }, { status: 400 }));
    }

    const supabase = createAdminClient();

    // Verify session ownership
    const { data: session } = await supabase
      .from('chat_sessions')
      .select('title, user_id, created_at')
      .eq('id', sessionId)
      .single();

    if (!session || session.user_id !== user.id) {
      return applySecurityHeaders(Response.json({ error: 'Access denied' }, { status: 403 }));
    }

    // Fetch all messages
    const { data: messages, error } = await supabase
      .from('chat_messages')
      .select('role, content, citations, created_at')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true });

    if (error) {
      return applySecurityHeaders(Response.json({ error: 'Failed to fetch messages' }, { status: 500 }));
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
      const role = msg.role === 'user' ? 'You' : 'PermitForge';
      markdown += `### ${role}\n\n`;
      markdown += `${msg.content}\n\n`;

      // Add citations if present
      if (msg.citations && Array.isArray(msg.citations) && msg.citations.length > 0) {
        markdown += `<details>\n<summary>Sources (${msg.citations.length})</summary>\n\n`;
        for (const citation of msg.citations) {
          const page = citation.page || citation.startPage || '?';
          const section = mdEscape(String(citation.section || ''));
          const doc = mdEscape(String(citation.documentName || ''));
          markdown += `- ${doc ? `[${doc}] ` : ''}Page ${page}${section ? `, Section ${section}` : ''}\n`;
        }
        markdown += `\n</details>\n\n`;
      }

      markdown += `---\n\n`;
    }

    markdown += `\n*Exported from PermitForge — Building Code Compliance Assistant*\n`;

    // S-H-4 / v1.5.0 Part C: use the RFC 5987 helper so non-ASCII session
    // titles (Arabic / Cyrillic project names) survive the download instead
    // of getting truncated to mojibake by the browser. The helper handles
    // ASCII fallback + UTF-8 percent-encoding + path-traversal stripping.
    const downloadName = `${title.trim() || 'chat-export'}.md`;

    return applySecurityHeaders(
      new Response(markdown, {
        headers: {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': contentDispositionAttachment(downloadName),
          'Cache-Control': 'no-cache',
        },
      })
    );
  } catch (error) {
    console.error('Chat export error:', error);
    return applySecurityHeaders(Response.json({ error: 'Export failed' }, { status: 500 }));
  }
}
