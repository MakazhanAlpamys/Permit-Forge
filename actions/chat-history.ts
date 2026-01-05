'use server';

// ============================================================================
// Chat History Server Actions
// ============================================================================

import { createServerClient } from '@/lib/supabase';
import { getSession } from '@/lib/auth';
import type { ChatSession, ChatMessage } from '@/types';

// -----------------------------------------------------------------------------
// Create New Chat Session
// -----------------------------------------------------------------------------

export async function createChatSession(title?: string): Promise<{ sessionId: string | null; error?: string }> {
  try {
    const user = await getSession();
    if (!user) {
      return { sessionId: null, error: 'Not authenticated' };
    }

    const supabase = createServerClient();
    
    const { data, error } = await supabase
      .from('chat_sessions')
      .insert({
        title: title || 'New Chat',
        user_id: user.id,
      })
      .select('id')
      .single();

    if (error) {
      console.error('Error creating chat session:', error);
      return { sessionId: null, error: error.message };
    }

    return { sessionId: data.id };
  } catch (error) {
    console.error('Create chat session error:', error);
    return { 
      sessionId: null, 
      error: error instanceof Error ? error.message : 'Failed to create session' 
    };
  }
}

// -----------------------------------------------------------------------------
// Save Message to Session
// -----------------------------------------------------------------------------

export async function saveMessageToSession(params: {
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  citations?: any[];
  complianceStatus?: string;
}): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = createServerClient();
    const { sessionId, role, content, citations, complianceStatus } = params;

    const { error } = await supabase
      .from('chat_messages')
      .insert({
        session_id: sessionId,
        role,
        content,
        citations: citations || [],
        compliance_status: complianceStatus,
      });

    if (error) {
      console.error('Error saving message:', error);
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (error) {
    console.error('Save message error:', error);
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to save message' 
    };
  }
}

// -----------------------------------------------------------------------------
// Get All Chat Sessions
// -----------------------------------------------------------------------------

export async function getChatSessions(): Promise<{ sessions: ChatSession[]; error?: string }> {
  try {
    const user = await getSession();
    if (!user) {
      return { sessions: [], error: 'Not authenticated' };
    }

    const supabase = createServerClient();
    
    const { data, error } = await supabase
      .from('chat_sessions')
      .select('id, title, created_at, updated_at')
      .eq('user_id', user.id)
      .order('updated_at', { ascending: false })
      .limit(50);

    if (error) {
      console.error('Error fetching chat sessions:', error);
      return { sessions: [], error: error.message };
    }

    return { sessions: data || [] };
  } catch (error) {
    console.error('Get chat sessions error:', error);
    return { 
      sessions: [], 
      error: error instanceof Error ? error.message : 'Failed to fetch sessions' 
    };
  }
}

// -----------------------------------------------------------------------------
// Get Messages for a Session
// -----------------------------------------------------------------------------

export async function getSessionMessages(sessionId: string): Promise<{ messages: ChatMessage[]; error?: string }> {
  try {
    const supabase = createServerClient();
    
    const { data, error } = await supabase
      .from('chat_messages')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('Error fetching session messages:', error);
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
    console.error('Get session messages error:', error);
    return { 
      messages: [], 
      error: error instanceof Error ? error.message : 'Failed to fetch messages' 
    };
  }
}

// -----------------------------------------------------------------------------
// Delete Chat Session
// -----------------------------------------------------------------------------

export async function deleteChatSession(sessionId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = createServerClient();
    
    const { error } = await supabase
      .from('chat_sessions')
      .delete()
      .eq('id', sessionId);

    if (error) {
      console.error('Error deleting chat session:', error);
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (error) {
    console.error('Delete chat session error:', error);
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to delete session' 
    };
  }
}

// -----------------------------------------------------------------------------
// Update Session Title
// -----------------------------------------------------------------------------

export async function updateSessionTitle(sessionId: string, title: string): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = createServerClient();
    
    const { error } = await supabase
      .from('chat_sessions')
      .update({ title, updated_at: new Date().toISOString() })
      .eq('id', sessionId);

    if (error) {
      console.error('Error updating session title:', error);
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (error) {
    console.error('Update session title error:', error);
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to update title' 
    };
  }
}
