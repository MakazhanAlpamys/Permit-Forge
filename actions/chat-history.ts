'use server';

// ============================================================================
// Chat History Server Actions (with Access Control)
// ============================================================================

import { createPublicClient, createServerClient } from '@/lib/supabase';
import { getSession, getQuickSession, logAuditEvent } from '@/lib/auth';
import { uuidSchema, paginationSchema, citationsArraySchema } from '@/lib/validations';
import type { ChatSession, ChatMessage, Citation } from '@/types';

// -----------------------------------------------------------------------------
// Helper: Verify Session Ownership
// -----------------------------------------------------------------------------

async function verifySessionOwnership(sessionId: string, userId: string): Promise<boolean> {
  const validation = uuidSchema.safeParse(sessionId);
  if (!validation.success) return false;
  
  const supabase = createPublicClient();
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

    const supabase = createPublicClient();
    
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
  } catch (error) {
    return { 
      sessionId: null, 
      error: error instanceof Error ? error.message : 'Failed to create session' 
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

    const supabase = createPublicClient();
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
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to save message' 
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

    const supabase = createPublicClient();
    
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
  } catch (error) {
    return { 
      sessions: [], 
      hasMore: false,
      error: error instanceof Error ? error.message : 'Failed to fetch sessions' 
    };
  }
}

// -----------------------------------------------------------------------------
// Get Messages for a Session (with Ownership Check)
// -----------------------------------------------------------------------------

export async function getSessionMessages(sessionId: string): Promise<{ messages: ChatMessage[]; error?: string }> {
  try {
    const user = await getQuickSession();
    if (!user) {
      return { messages: [], error: 'Not authenticated' };
    }
    
    // Validate sessionId
    const validation = uuidSchema.safeParse(sessionId);
    if (!validation.success) {
      return { messages: [], error: 'Invalid session ID' };
    }
    
    // Verify ownership
    const isOwner = await verifySessionOwnership(sessionId, user.id);
    if (!isOwner) {
      return { messages: [], error: 'Access denied' };
    }
    
    const supabase = createPublicClient();
    const { data, error } = await supabase
      .from('chat_messages')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true });

    if (error) {
      return { messages: [], error: error.message };
    }

    // Transform to ChatMessage format
    const messages: ChatMessage[] = (data || []).map(msg => ({
      id: msg.id,
      role: msg.role as 'user' | 'assistant',
      content: msg.content,
      citations: msg.citations || [],
      complianceStatus: msg.compliance_status,
      timestamp: new Date(msg.created_at),
    }));

    return { messages };
  } catch (error) {
    return { 
      messages: [], 
      error: error instanceof Error ? error.message : 'Failed to fetch messages' 
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
    
    const supabase = createPublicClient();
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
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to delete session' 
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
    
    const supabase = createPublicClient();
    const { error } = await supabase
      .from('chat_sessions')
      .update({ title: sanitizedTitle, updated_at: new Date().toISOString() })
      .eq('id', sessionId)
      .eq('user_id', user.id); // Double-check ownership

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to update title' 
    };
  }
}
