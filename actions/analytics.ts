'use server';

// ============================================================================
// Analytics Server Actions
// ============================================================================

import { createAdminClient } from '@/lib/supabase-server';
import { requireAdmin } from '@/lib/security';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface AnalyticsDashboardStats {
  totalUsers: number;
  activeUsersToday: number;
  activeUsersYesterday: number;
  messagesToday: number;
  messagesYesterday: number;
  permitsToday: number;
  permitsYesterday: number;
  newUsersToday: number;
  newUsersYesterday: number;
  totalChunks: number;
}

export interface MessageActivityDay {
  day: string;
  userCount: number;
  assistantCount: number;
  totalCount: number;
  activeUsers: number;
}

export interface DocumentUsageStat {
  documentName: string;
  chunkCount: number;
  minPage: number;
  maxPage: number;
}

export interface TopActiveUser {
  userId: string;
  username: string;
  fullName: string | null;
  messageCount: number;
  lastActive: string;
}

// -----------------------------------------------------------------------------
// 1. Dashboard Stats with Trends
// -----------------------------------------------------------------------------

export async function getAnalyticsDashboardStats(): Promise<{
  data: AnalyticsDashboardStats | null;
  error?: string;
}> {
  try {
    const authCheck = await requireAdmin();
    if (!authCheck.success) {
      return { data: null, error: authCheck.error };
    }

    const supabase = createAdminClient();
    const { data, error } = await supabase.rpc('get_analytics_dashboard_stats');

    if (error) {
      console.error('getAnalyticsDashboardStats RPC error:', error);
      throw error;
    }

    const row = data?.[0];
    if (!row) {
      return { data: null, error: 'No stats available' };
    }

    return {
      data: {
        totalUsers: Number(row.total_users) || 0,
        activeUsersToday: Number(row.active_users_today) || 0,
        activeUsersYesterday: Number(row.active_users_yesterday) || 0,
        messagesToday: Number(row.messages_today) || 0,
        messagesYesterday: Number(row.messages_yesterday) || 0,
        permitsToday: Number(row.permits_today) || 0,
        permitsYesterday: Number(row.permits_yesterday) || 0,
        newUsersToday: Number(row.new_users_today) || 0,
        newUsersYesterday: Number(row.new_users_yesterday) || 0,
        totalChunks: Number(row.total_chunks) || 0,
      },
    };
  } catch (error) {
    console.error('getAnalyticsDashboardStats error:', error);
    return {
      data: null,
      error: 'Failed to fetch analytics stats',
    };
  }
}

// -----------------------------------------------------------------------------
// 2. Message Activity (30 days)
// -----------------------------------------------------------------------------

export async function getMessageActivity30d(): Promise<{
  data: MessageActivityDay[];
  error?: string;
}> {
  try {
    const authCheck = await requireAdmin();
    if (!authCheck.success) {
      return { data: [], error: authCheck.error };
    }

    const supabase = createAdminClient();
    const { data, error } = await supabase.rpc('get_message_activity_30d');

    if (error) {
      console.error('getMessageActivity30d RPC error:', error);
      throw error;
    }

    return {
      data: (data || []).map((row: { day: string; user_count: number; assistant_count: number; total_count: number; active_users: number }) => ({
        day: row.day,
        userCount: Number(row.user_count) || 0,
        assistantCount: Number(row.assistant_count) || 0,
        totalCount: Number(row.total_count) || 0,
        activeUsers: Number(row.active_users) || 0,
      })),
    };
  } catch (error) {
    console.error('getMessageActivity30d error:', error);
    return {
      data: [],
      error: 'Failed to fetch message activity',
    };
  }
}

// -----------------------------------------------------------------------------
// 3. Document Usage Stats (reuses existing RPC)
// -----------------------------------------------------------------------------

export async function getDocumentUsageStats(): Promise<{
  data: DocumentUsageStat[];
  error?: string;
}> {
  try {
    const authCheck = await requireAdmin();
    if (!authCheck.success) {
      return { data: [], error: authCheck.error };
    }

    const supabase = createAdminClient();
    const { data, error } = await supabase.rpc('get_document_stats');

    if (error) {
      // Fallback: Use lightweight count-only query per document instead of
      // loading all chunks into memory. This avoids OOM on large datasets.
      const { data: docNames, error: docError } = await supabase
        .from('dubai_code_chunks')
        .select('document_name')
        .limit(1000);

      if (docError || !docNames) {
        return { data: [], error: 'Failed to fetch document stats' };
      }

      // Get unique document names
      const uniqueDocs = [...new Set(docNames.map(d => d.document_name || 'unknown'))];

      const stats: DocumentUsageStat[] = [];
      for (const docName of uniqueDocs) {
        const { count } = await supabase
          .from('dubai_code_chunks')
          .select('id', { count: 'exact', head: true })
          .eq('document_name', docName);

        stats.push({
          documentName: docName,
          chunkCount: count || 0,
          minPage: 0,
          maxPage: 0,
        });
      }

      return { data: stats };
    }

    return {
      data: (data || []).map((row: { document_name: string; chunk_count: number; min_page: number; max_page: number }) => ({
        documentName: row.document_name,
        chunkCount: Number(row.chunk_count) || 0,
        minPage: Number(row.min_page) || 0,
        maxPage: Number(row.max_page) || 0,
      })),
    };
  } catch (error) {
    console.error('getDocumentUsageStats error:', error);
    return {
      data: [],
      error: 'Failed to fetch document usage',
    };
  }
}

// -----------------------------------------------------------------------------
// 4. Permit Status Breakdown (reuses existing RPC)
// -----------------------------------------------------------------------------

export interface PermitStatusBreakdown {
  total: number;
  draft: number;
  submitted: number;
  underReview: number;
  approved: number;
  rejected: number;
  revisionRequested: number;
}

export async function getPermitStatusBreakdown(): Promise<{
  data: PermitStatusBreakdown | null;
  error?: string;
}> {
  try {
    const authCheck = await requireAdmin();
    if (!authCheck.success) {
      return { data: null, error: authCheck.error };
    }

    const supabase = createAdminClient();
    const { data, error } = await supabase.rpc('get_permit_stats');

    if (error) throw error;

    const stats = data?.[0];
    if (!stats) {
      return { data: null, error: 'No permit stats available' };
    }

    return {
      data: {
        total: Number(stats.total_permits) || 0,
        draft: Number(stats.draft_count) || 0,
        submitted: Number(stats.submitted_count) || 0,
        underReview: Number(stats.under_review_count) || 0,
        approved: Number(stats.approved_count) || 0,
        rejected: Number(stats.rejected_count) || 0,
        revisionRequested: Number(stats.revision_requested_count) || 0,
      },
    };
  } catch (error) {
    console.error('getPermitStatusBreakdown error:', error);
    return {
      data: null,
      error: 'Failed to fetch permit breakdown',
    };
  }
}

// -----------------------------------------------------------------------------
// 5. Top Active Users
// -----------------------------------------------------------------------------

export async function getTopActiveUsers(
  days: number = 30,
  limit: number = 5
): Promise<{ data: TopActiveUser[]; error?: string }> {
  try {
    const authCheck = await requireAdmin();
    if (!authCheck.success) {
      return { data: [], error: authCheck.error };
    }

    const supabase = createAdminClient();
    const { data, error } = await supabase.rpc('get_top_active_users', {
      p_days: days,
      p_limit: limit,
    });

    if (error) {
      console.error('getTopActiveUsers RPC error:', error);
      throw error;
    }

    return {
      data: (data || []).map((row: { user_id: string; username: string; full_name: string | null; message_count: number; last_active: string }) => ({
        userId: row.user_id,
        username: row.username,
        fullName: row.full_name,
        messageCount: Number(row.message_count) || 0,
        lastActive: row.last_active,
      })),
    };
  } catch (error) {
    console.error('getTopActiveUsers error:', error);
    return {
      data: [],
      error: 'Failed to fetch top users',
    };
  }
}
