'use server';

// ============================================================================
// Notification Server Actions
// ============================================================================

import { createAdminClient } from '@/lib/supabase-server';
import { getQuickSession } from '@/lib/auth';
import { requireAuth, requireCSRF } from '@/lib/security';
import { uuidSchema } from '@/lib/validations';
import type { Notification } from '@/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function transformNotification(row: any): Notification {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    title: row.title,
    body: row.body,
    data: row.data || {},
    read: row.read,
    createdAt: row.created_at,
  };
}

// -----------------------------------------------------------------------------
// Get Notifications
// -----------------------------------------------------------------------------

export async function getNotifications(
  limit: number = 20
): Promise<{ data: Notification[]; unreadCount: number; error?: string }> {
  try {
    const user = await getQuickSession();
    if (!user) {
      return { data: [], unreadCount: 0, error: 'Not authenticated' };
    }

    const supabase = createAdminClient();

    // Fetch notifications
    const { data, error } = await supabase
      .from('notifications')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;

    // Count unread
    const { count } = await supabase
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('read', false);

    return {
      data: (data || []).map(transformNotification),
      unreadCount: count || 0,
    };
  } catch (error) {
    console.error('getNotifications error:', error);
    return {
      data: [],
      unreadCount: 0,
      error: 'Failed to fetch notifications',
    };
  }
}

// -----------------------------------------------------------------------------
// Mark Notification as Read
// -----------------------------------------------------------------------------

export async function markNotificationRead(
  notificationId: string,
  csrfToken: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const authCheck = await requireAuth();
    if (!authCheck.success || !authCheck.user) {
      return { success: false, error: authCheck.error };
    }

    const csrf = await requireCSRF(csrfToken);
    if (!csrf.valid) return { success: false, error: csrf.error };

    const idValidation = uuidSchema.safeParse(notificationId);
    if (!idValidation.success) {
      return { success: false, error: 'Invalid notification ID' };
    }

    const supabase = createAdminClient();
    const { error } = await supabase
      .from('notifications')
      .update({ read: true })
      .eq('id', notificationId)
      .eq('user_id', authCheck.user.id);

    if (error) throw error;

    return { success: true };
  } catch (error) {
    console.error('markNotificationRead error:', error);
    return {
      success: false,
      error: 'Failed to mark notification as read',
    };
  }
}

// -----------------------------------------------------------------------------
// Mark All Notifications as Read
// -----------------------------------------------------------------------------

export async function markAllNotificationsRead(
  csrfToken: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const authCheck = await requireAuth();
    if (!authCheck.success || !authCheck.user) {
      return { success: false, error: authCheck.error };
    }

    const csrf = await requireCSRF(csrfToken);
    if (!csrf.valid) return { success: false, error: csrf.error };

    const supabase = createAdminClient();
    const { error } = await supabase
      .from('notifications')
      .update({ read: true })
      .eq('user_id', authCheck.user.id)
      .eq('read', false);

    if (error) throw error;

    return { success: true };
  } catch (error) {
    console.error('markAllNotificationsRead error:', error);
    return {
      success: false,
      error: 'Failed to mark notifications as read',
    };
  }
}
