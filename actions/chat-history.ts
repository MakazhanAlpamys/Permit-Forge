'use server';

// ============================================================================
// Chat History Server Actions (with Access Control)
// ============================================================================

import { createServerClient } from '@/lib/supabase-server';
import { getQuickSession, logAuditEvent } from '@/lib/auth';
import { uuidSchema, paginationSchema, citationsArraySchema } from '@/lib/validations';
import type { ChatSession, ChatMessage, Citation } from '@/types';

// -----------------------------------------------------------------------------
// Helper: Verify Session Ownership
// -----------------------------------------------------------------------------

async function verifySessionOwnership(sessionId: string, userId: string): Promise<boolean> {
  const validation = uuidSchema.safeParse(sessionId);
  if (!validation.success) return false;
  
  const supabase = createServerClient();
  const { data, error } = await supabase
    .from('chat_sessions')
    .select('user_id')
    .eq('id', sessionId)
    .single();
  
  if (error || !data) return false;
  return data.user_id === userId;
}

// -----------------------------------------------------------------------------
// Create New Chat Session
// -----------------------------------------------------------------------------

export async function createChatSession(title?: string): Promise<{ sessionId: string | null; error?: string }> {
  try {
    const user = await getQuickSession();
    if (!user) {
      return { sessionId: null, error: 'Not authenticated' };
    }

    const supabase = createServerClient();
    
    // Sanitize title
    const sanitizedTitle = (title || 'New Chat').slice(0, 100).trim();
    
    const { data, error } = await supabase
      .from('chat_sessions')
      .insert({
        title: sanitizedTitle,
        user_id: user.id,
      })
      .select('id')
      .single();

    if (error) {
      return { sessionId: null, error: error.message };
    }

    return { sessionId: data.id };
  } catch {
    return {
      sessionId: null,
      error: 'Failed to create session'
    };
  }
}

// -----------------------------------------------------------------------------
// Save Message to Session (with Ownership Check)
// -----------------------------------------------------------------------------

export async function saveMessageToSession(params: {
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  citations?: Citation[];
  complianceStatus?: string;
}): Promise<{ success: boolean; error?: string }> {
  try {
    const user = await getQuickSession();
    if (!user) {
      return { success: false, error: 'Not authenticated' };
    }

    const { sessionId, role, content, citations, complianceStatus } = params;
    
    // Validate sessionId
    const sessionValidation = uuidSchema.safeParse(sessionId);
    if (!sessionValidation.success) {
      return { success: false, error: 'Invalid session ID' };
    }
    
    // Verify ownership
    const isOwner = await verifySessionOwnership(sessionId, user.id);
    if (!isOwner) {
      return { success: false, error: 'Access denied' };
    }
    
    // Validate citations if provided
    let validatedCitations: unknown[] = [];
    if (citations && Array.isArray(citations)) {
      const citationValidation = citationsArraySchema.safeParse(citations);
      if (citationValidation.success) {
        validatedCitations = citationValidation.data;
      }
    }

    const supabase = createServerClient();
    const { error } = await supabase
      .from('chat_messages')
      .insert({
        session_id: sessionId,
        role,
        content: content.slice(0, 50000), // Limit content size
        citations: validatedCitations,
        compliance_status: complianceStatus,
      });

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch {
    return {
      success: false,
      error: 'Failed to save message'
    };
  }
}

// -----------------------------------------------------------------------------
// Get All Chat Sessions (with Pagination)
// -----------------------------------------------------------------------------

interface PaginatedSessionsResult {
  sessions: ChatSession[];
  nextCursor?: string;
  hasMore: boolean;
  error?: string;
}

export async function getChatSessions(
  cursor?: string,
  limit: number = 20
): Promise<PaginatedSessionsResult> {
  try {
    const user = await getQuickSession();
    if (!user) {
      return { sessions: [], hasMore: false, error: 'Not authenticated' };
    }

    // Validate pagination params
    const paginationValidation = paginationSchema.safeParse({ cursor, limit });
    const validLimit = paginationValidation.success ? paginationValidation.data.limit : 20;

    const supabase = createServerClient();
    
    let query = supabase
      .from('chat_sessions')
      .select('id, title, created_at, updated_at')
      .eq('user_id', user.id)
      .order('updated_at', { ascending: false })
      .limit(validLimit + 1); // Fetch one extra to check if there are more
    
    // Apply cursor if provided
    if (cursor) {
      query = query.lt('updated_at', cursor);
    }

    const { data, error } = await query;

    if (error) {
      return { sessions: [], hasMore: false, error: error.message };
    }

    const sessions = data || [];
    const hasMore = sessions.length > validLimit;
    
    // Remove the extra item we fetched for pagination check
    if (hasMore) {
      sessions.pop();
    }

    const nextCursor = hasMore && sessions.length > 0 
      ? sessions[sessions.length - 1].updated_at 
      : undefined;

    return { 
      sessions: sessions as ChatSession[], 
      nextCursor,
      hasMore 
    };
  } catch {
    return {
      sessions: [],
      hasMore: false,
      error: 'Failed to fetch sessions' 
    };
  }
}

// -----------------------------------------------------------------------------
// Get Messages for a Session (with Ownership Check + Pagination)
// -----------------------------------------------------------------------------

interface PaginatedMessagesResult {
  messages: ChatMessage[];
  nextCursor?: string;
  hasMore: boolean;
  error?: string;
}

export async function getSessionMessages(
  sessionId: string,
  cursor?: string,
  limit: number = 50
): Promise<PaginatedMessagesResult> {
  try {
    const user = await getQuickSession();
    if (!user) {
      return { messages: [], hasMore: false, error: 'Not authenticated' };
    }

    // Validate sessionId
    const validation = uuidSchema.safeParse(sessionId);
    if (!validation.success) {
      return { messages: [], hasMore: false, error: 'Invalid session ID' };
    }

    // Verify ownership
    const isOwner = await verifySessionOwnership(sessionId, user.id);
    if (!isOwner) {
      return { messages: [], hasMore: false, error: 'Access denied' };
    }

    const validLimit = Math.min(Math.max(limit, 1), 100);

    const supabase = createServerClient();
    let query = supabase
      .from('chat_messages')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: false })
      .limit(validLimit + 1);

    // Cursor: fetch messages older than the cursor timestamp
    if (cursor) {
      query = query.lt('created_at', cursor);
    }

    const { data, error } = await query;

    if (error) {
      return { messages: [], hasMore: false, error: error.message };
    }

    const rows = data || [];
    const hasMore = rows.length > validLimit;

    if (hasMore) {
      rows.pop();
    }

    const nextCursor = hasMore && rows.length > 0
      ? rows[rows.length - 1].created_at
      : undefined;

    // Reverse to chronological order (oldest first)
    rows.reverse();

    // Transform to ChatMessage format
    const messages: ChatMessage[] = rows.map(msg => ({
      id: msg.id,
      role: msg.role as 'user' | 'assistant',
      content: msg.content,
      citations: msg.citations || [],
      complianceStatus: msg.compliance_status,
      timestamp: new Date(msg.created_at),
    }));

    return { messages, nextCursor, hasMore };
  } catch {
    return {
      messages: [],
      hasMore: false,
      error: 'Failed to fetch messages'
    };
  }
}

// -----------------------------------------------------------------------------
// Delete Chat Session (with Ownership Check)
// -----------------------------------------------------------------------------

export async function deleteChatSession(sessionId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const user = await getQuickSession();
    if (!user) {
      return { success: false, error: 'Not authenticated' };
    }
    
    // Validate sessionId
    const validation = uuidSchema.safeParse(sessionId);
    if (!validation.success) {
      return { success: false, error: 'Invalid session ID' };
    }
    
    // Verify ownership
    const isOwner = await verifySessionOwnership(sessionId, user.id);
    if (!isOwner) {
      return { success: false, error: 'Access denied' };
    }
    
    const supabase = createServerClient();
    const { error } = await supabase
      .from('chat_sessions')
      .delete()
      .eq('id', sessionId)
      .eq('user_id', user.id); // Double-check ownership in query

    if (error) {
      return { success: false, error: error.message };
    }

    // Log the deletion
    await logAuditEvent({
      userId: user.id,
      action: 'session_deleted',
      metadata: { sessionId },
    });

    return { success: true };
  } catch {
    return {
      success: false,
      error: 'Failed to delete session'
    };
  }
}

// -----------------------------------------------------------------------------
// Update Session Title (with Ownership Check)
// -----------------------------------------------------------------------------

export async function updateSessionTitle(sessionId: string, title: string): Promise<{ success: boolean; error?: string }> {
  try {
    const user = await getQuickSession();
    if (!user) {
      return { success: false, error: 'Not authenticated' };
    }
    
    // Validate sessionId
    const validation = uuidSchema.safeParse(sessionId);
    if (!validation.success) {
      return { success: false, error: 'Invalid session ID' };
    }
    
    // Verify ownership
    const isOwner = await verifySessionOwnership(sessionId, user.id);
    if (!isOwner) {
      return { success: false, error: 'Access denied' };
    }
    
    // Sanitize title
    const sanitizedTitle = title.slice(0, 100).trim();
    
    const supabase = createServerClient();
    const { error } = await supabase
      .from('chat_sessions')
      .update({ title: sanitizedTitle, updated_at: new Date().toISOString() })
      .eq('id', sessionId)
      .eq('user_id', user.id); // Double-check ownership

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch {
    return {
      success: false,
      error: 'Failed to update title'
    };
  }
}

// -----------------------------------------------------------------------------
// Search Chat History (searches message content across user's sessions)
// -----------------------------------------------------------------------------

interface SearchResult {
  sessionId: string;
  sessionTitle: string;
  snippet: string;
  updatedAt: string;
}

export async function searchChatHistory(
  query: string
): Promise<{ results: SearchResult[]; error?: string }> {
  try {
    const user = await getQuickSession();
    if (!user) {
      return { results: [], error: 'Not authenticated' };
    }

    const trimmedQuery = query.trim().slice(0, 200);
    if (!trimmedQuery) {
      return { results: [] };
    }

    // SECURITY: Escape wildcard characters in the query to prevent LIKE injection
    const escapedQuery = trimmedQuery.replace(/[%_]/g, '\\$&');
    const searchPattern = `%${escapedQuery}%`;

    const supabase = createServerClient();

    // Search session titles first
    const { data: titleMatches } = await supabase
      .from('chat_sessions')
      .select('id, title, updated_at')
      .eq('user_id', user.id)
      .ilike('title', searchPattern)
      .order('updated_at', { ascending: false })
      .limit(10);

    // Search message content
    const { data: messageMatches } = await supabase
      .from('chat_messages')
      .select('session_id, content, chat_sessions!inner(title, user_id, updated_at)')
      .eq('chat_sessions.user_id', user.id)
      .ilike('content', searchPattern)
      .order('created_at', { ascending: false })
      .limit(20);

    // Deduplicate by session ID, preferring title matches
    const seenSessions = new Set<string>();
    const results: SearchResult[] = [];

    for (const s of titleMatches || []) {
      if (!seenSessions.has(s.id)) {
        seenSessions.add(s.id);
        results.push({
          sessionId: s.id,
          sessionTitle: s.title || 'Untitled',
          snippet: s.title || '',
          updatedAt: s.updated_at,
        });
      }
    }

    for (const m of messageMatches || []) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const session = m.chat_sessions as any;
      if (!seenSessions.has(m.session_id)) {
        seenSessions.add(m.session_id);
        // Extract a snippet around the match
        const idx = m.content.toLowerCase().indexOf(trimmedQuery.toLowerCase());
        const start = Math.max(0, idx - 40);
        const end = Math.min(m.content.length, idx + trimmedQuery.length + 40);
        const snippet = (start > 0 ? '...' : '') + m.content.slice(start, end) + (end < m.content.length ? '...' : '');

        results.push({
          sessionId: m.session_id,
          sessionTitle: session?.title || 'Untitled',
          snippet,
          updatedAt: session?.updated_at || '',
        });
      }
    }

    return { results: results.slice(0, 15) };
  } catch {
    return {
      results: [],
      error: 'Search failed',
    };
  }
}
