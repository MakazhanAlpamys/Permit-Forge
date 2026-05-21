'use server';

// ============================================================================
// Analytics Server Actions
// ============================================================================

import { createAdminClient } from '@/lib/supabase-server';
import { requireAdmin } from '@/lib/security';
import { getAllDocuments } from '@/lib/document-registry';
import { numOrZero } from '@/lib/transforms';

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
  /** Short display name resolved server-side from document_registry */
  displayName?: string;
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
        totalUsers: numOrZero(row.total_users),
        activeUsersToday: numOrZero(row.active_users_today),
        activeUsersYesterday: numOrZero(row.active_users_yesterday),
        messagesToday: numOrZero(row.messages_today),
        messagesYesterday: numOrZero(row.messages_yesterday),
        permitsToday: numOrZero(row.permits_today),
        permitsYesterday: numOrZero(row.permits_yesterday),
        newUsersToday: numOrZero(row.new_users_today),
        newUsersYesterday: numOrZero(row.new_users_yesterday),
        totalChunks: numOrZero(row.total_chunks),
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
        userCount: numOrZero(row.user_count),
        assistantCount: numOrZero(row.assistant_count),
        totalCount: numOrZero(row.total_count),
        activeUsers: numOrZero(row.active_users),
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

    // Resolve display names server-side to avoid importing registry in client components
    const allDocs = await getAllDocuments();
    const nameMap = new Map(allDocs.map(d => [d.id, d.shortName]));

    return {
      data: (data || []).map((row: { document_name: string; chunk_count: number; min_page: number; max_page: number }) => ({
        documentName: row.document_name,
        displayName: nameMap.get(row.document_name) || row.document_name,
        chunkCount: numOrZero(row.chunk_count),
        minPage: numOrZero(row.min_page),
        maxPage: numOrZero(row.max_page),
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
        total: numOrZero(stats.total_permits),
        draft: numOrZero(stats.draft_count),
        submitted: numOrZero(stats.submitted_count),
        underReview: numOrZero(stats.under_review_count),
        approved: numOrZero(stats.approved_count),
        rejected: numOrZero(stats.rejected_count),
        revisionRequested: numOrZero(stats.revision_requested_count),
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

// -----------------------------------------------------------------------------
// 5a. Refresh analytics_daily materialized view (admin Refresh button)
// -----------------------------------------------------------------------------

/**
 * D2/H15+H16: Admin "Refresh" trigger for the analytics_daily MV.
 * Cheap (CONCURRENTLY refresh) and safe to call from the dashboard's refresh
 * button. Failures are reported but never crash dashboard load.
 */
export async function refreshAnalytics(): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    const authCheck = await requireAdmin();
    if (!authCheck.success) {
      return { success: false, error: authCheck.error };
    }

    const supabase = createAdminClient();
    const { error } = await supabase.rpc('refresh_analytics');

    if (error) {
      console.error('refreshAnalytics RPC error:', error);
      return { success: false, error: 'Failed to refresh analytics' };
    }

    return { success: true };
  } catch (error) {
    console.error('refreshAnalytics error:', error);
    return { success: false, error: 'Failed to refresh analytics' };
  }
}

// -----------------------------------------------------------------------------
// 6. Top Active Users
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
        messageCount: numOrZero(row.message_count),
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
