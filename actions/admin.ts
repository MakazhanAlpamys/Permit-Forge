'use server';

// ============================================================================
// Admin Dashboard Server Actions
// ============================================================================

import { createServerClient } from '@/lib/supabase';
import { getQuickSession, logAuditEvent, hashPassword } from '@/lib/auth';
import { uuidSchema, createUserSchema } from '@/lib/validations';
import { getRequestMetadata } from '@/lib/auth';

// -----------------------------------------------------------------------------
// RPC Response Types (matching Supabase functions)
// -----------------------------------------------------------------------------

interface WeeklyActivityRow {
  day: string;
  messages: number;
  users: number;
}

interface AuditLogRow {
  id: number;
  user_id: string | null;
  username: string | null;
  action: string;
  target_user_id: string | null;
  target_username: string | null;
  metadata: Record<string, unknown>;
  ip_address: string | null;
  created_at: string;
}

interface AdminUserRow {
  id: string;
  username: string;
  full_name: string | null;
  role: string;
  blocked: boolean;
  blocked_reason: string | null;
  created_at: string;
  last_login: string | null;
  session_count: number;
  message_count: number;
}

// -----------------------------------------------------------------------------
// Helper: Verify Admin Access
// -----------------------------------------------------------------------------

async function requireAdmin() {
  const user = await getQuickSession();
  if (!user || user.role !== 'admin') {
    throw new Error('Unauthorized: Admin access required');
  }
  return user;
}

// -----------------------------------------------------------------------------
// Dashboard Statistics
// -----------------------------------------------------------------------------

export interface DashboardStats {
  totalUsers: number;
  activeUsersToday: number;
  totalSessions: number;
  totalMessages: number;
  messagesToday: number;
  blockedUsers: number;
}

export async function getDashboardStats(): Promise<{ data: DashboardStats | null; error?: string }> {
  try {
    await requireAdmin();
    
    const supabase = createServerClient();
    const { data, error } = await supabase.rpc('get_admin_stats');
    
    if (error) throw error;
    
    const stats = data?.[0];
    if (!stats) {
      return { data: null, error: 'No stats available' };
    }
    
    return {
      data: {
        totalUsers: Number(stats.total_users),
        activeUsersToday: Number(stats.active_users_today),
        totalSessions: Number(stats.total_sessions),
        totalMessages: Number(stats.total_messages),
        messagesToday: Number(stats.messages_today),
        blockedUsers: Number(stats.blocked_users),
      }
    };
  } catch (error) {
    return { 
      data: null, 
      error: error instanceof Error ? error.message : 'Failed to fetch stats' 
    };
  }
}

// -----------------------------------------------------------------------------
// Weekly Activity Chart
// -----------------------------------------------------------------------------

export interface WeeklyActivity {
  day: string;
  messages: number;
  users: number;
}

export async function getWeeklyActivity(): Promise<{ data: WeeklyActivity[]; error?: string }> {
  try {
    await requireAdmin();
    
    const supabase = createServerClient();
    const { data, error } = await supabase.rpc('get_weekly_activity');
    
    if (error) throw error;
    
    return {
      data: (data || []).map((item: WeeklyActivityRow) => ({
        day: item.day,
        messages: Number(item.messages),
        users: Number(item.users),
      }))
    };
  } catch (error) {
    return { 
      data: [], 
      error: error instanceof Error ? error.message : 'Failed to fetch activity' 
    };
  }
}

// -----------------------------------------------------------------------------
// Audit Logs
// -----------------------------------------------------------------------------

export interface AuditLogEntry {
  id: number;
  userId: string | null;
  username: string | null;
  action: string;
  targetUserId: string | null;
  targetUsername: string | null;
  metadata: Record<string, unknown>;
  ipAddress: string | null;
  createdAt: string;
}

export async function getAuditLogs(
  limit: number = 50,
  actionFilter?: string
): Promise<{ data: AuditLogEntry[]; error?: string }> {
  try {
    await requireAdmin();
    
    const supabase = createServerClient();
    const { data, error } = await supabase.rpc('get_recent_audit_logs', {
      p_limit: Math.min(limit, 500),
      p_action_filter: actionFilter || null,
    });
    
    if (error) throw error;
    
    return {
      data: (data || []).map((item: AuditLogRow) => ({
        id: item.id,
        userId: item.user_id,
        username: item.username,
        action: item.action,
        targetUserId: item.target_user_id,
        targetUsername: item.target_username,
        metadata: item.metadata || {},
        ipAddress: item.ip_address,
        createdAt: item.created_at,
      }))
    };
  } catch (error) {
    return { 
      data: [], 
      error: error instanceof Error ? error.message : 'Failed to fetch logs' 
    };
  }
}

// -----------------------------------------------------------------------------
// User Management
// -----------------------------------------------------------------------------

export interface AdminUser {
  id: string;
  username: string;
  fullName: string | null;
  role: 'admin' | 'user';
  blocked: boolean;
  blockedReason: string | null;
  createdAt: string;
  lastLogin: string | null;
  sessionCount: number;
  messageCount: number;
}

export async function getAllUsers(
  limit: number = 50,
  offset: number = 0,
  search?: string
): Promise<{ data: AdminUser[]; error?: string }> {
  try {
    const admin = await requireAdmin();
    
    const supabase = createServerClient();
    const { data, error } = await supabase.rpc('get_all_users_admin', {
      p_admin_id: admin.id,
      p_limit: Math.min(limit, 100),
      p_offset: offset,
      p_search: search || null,
    });
    
    if (error) throw error;
    
    return {
      data: (data || []).map((item: AdminUserRow) => ({
        id: item.id,
        username: item.username,
        fullName: item.full_name,
        role: item.role as 'admin' | 'user',
        blocked: item.blocked,
        blockedReason: item.blocked_reason,
        createdAt: item.created_at,
        lastLogin: item.last_login,
        sessionCount: Number(item.session_count),
        messageCount: Number(item.message_count),
      }))
    };
  } catch (error) {
    return { 
      data: [], 
      error: error instanceof Error ? error.message : 'Failed to fetch users' 
    };
  }
}

// -----------------------------------------------------------------------------
// Block/Unblock User
// -----------------------------------------------------------------------------

export async function blockUser(
  userId: string,
  blocked: boolean,
  reason?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const admin = await requireAdmin();
    
    // Validate userId
    const validation = uuidSchema.safeParse(userId);
    if (!validation.success) {
      return { success: false, error: 'Invalid user ID' };
    }
    
    const supabase = createServerClient();
    const { error } = await supabase.rpc('admin_block_user', {
      p_admin_id: admin.id,
      p_target_user_id: userId,
      p_blocked: blocked,
      p_reason: reason || null,
    });
    
    if (error) throw error;
    
    // Log the action
    const metadata = await getRequestMetadata();
    await logAuditEvent({
      userId: admin.id,
      action: blocked ? 'user_blocked' : 'user_unblocked',
      targetUserId: userId,
      metadata: { reason },
      ...metadata,
    });
    
    return { success: true };
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to update user' 
    };
  }
}

// -----------------------------------------------------------------------------
// Update User Role
// -----------------------------------------------------------------------------

export async function updateUserRole(
  userId: string,
  role: 'admin' | 'user'
): Promise<{ success: boolean; error?: string }> {
  try {
    const admin = await requireAdmin();
    
    // Validate userId
    const validation = uuidSchema.safeParse(userId);
    if (!validation.success) {
      return { success: false, error: 'Invalid user ID' };
    }
    
    const supabase = createServerClient();
    const { error } = await supabase.rpc('admin_update_user_role', {
      p_admin_id: admin.id,
      p_target_user_id: userId,
      p_new_role: role,
    });
    
    if (error) throw error;
    
    // Log the action
    const metadata = await getRequestMetadata();
    await logAuditEvent({
      userId: admin.id,
      action: 'role_changed',
      targetUserId: userId,
      metadata: { newRole: role },
      ...metadata,
    });
    
    return { success: true };
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to update role' 
    };
  }
}

// -----------------------------------------------------------------------------
// Create New User (Admin)
// -----------------------------------------------------------------------------

export async function adminCreateUser(data: {
  username: string;
  password: string;
  full_name?: string;
  role?: 'admin' | 'user';
}): Promise<{ success: boolean; userId?: string; error?: string }> {
  try {
    const admin = await requireAdmin();
    
    // Validate input
    const validation = createUserSchema.safeParse(data);
    if (!validation.success) {
      return { success: false, error: validation.error.errors[0].message };
    }
    
    const { username, password, full_name, role } = validation.data;
    const supabase = createServerClient();
    const passwordHash = await hashPassword(password);
    
    // Check if username already exists
    const { data: existingUser } = await supabase
      .from('users')
      .select('id')
      .eq('username', username)
      .single();
    
    if (existingUser) {
      return { success: false, error: 'Username already exists' };
    }
    
    const { data: newUser, error } = await supabase
      .from('users')
      .insert({
        username,
        password_hash: passwordHash,
        full_name: full_name || null,
        role: role || 'user',
      })
      .select('id')
      .single();
    
    if (error) {
      console.error('Create user error:', error);
      if (error.code === '23505') {
        return { success: false, error: 'Username already exists' };
      }
      return { success: false, error: `Database error: ${error.message}` };
    }
    
    if (!newUser) {
      return { success: false, error: 'Failed to create user - no data returned' };
    }
    
    // Log the action
    try {
      const metadata = await getRequestMetadata();
      await logAuditEvent({
        userId: admin.id,
        action: 'user_created',
        targetUserId: newUser.id,
        metadata: { username, role: role || 'user' },
        ...metadata,
      });
    } catch (auditError) {
      console.error('Audit log error:', auditError);
      // Don't fail the operation if audit log fails
    }
    
    return { success: true, userId: newUser.id };
  } catch (error) {
    console.error('adminCreateUser error:', error);
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to create user' 
    };
  }
}

// -----------------------------------------------------------------------------
// Delete User (Admin)
// -----------------------------------------------------------------------------

export async function adminDeleteUser(userId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const admin = await requireAdmin();
    
    // Validate userId
    const validation = uuidSchema.safeParse(userId);
    if (!validation.success) {
      return { success: false, error: 'Invalid user ID' };
    }
    
    // Prevent self-deletion
    if (userId === admin.id) {
      return { success: false, error: 'Cannot delete yourself' };
    }
    
    const supabase = createServerClient();
    
    // Get username for logging
    const { data: targetUser } = await supabase
      .from('users')
      .select('username')
      .eq('id', userId)
      .single();
    
    const { error } = await supabase
      .from('users')
      .delete()
      .eq('id', userId);
    
    if (error) throw error;
    
    // Log the action
    const metadata = await getRequestMetadata();
    await logAuditEvent({
      userId: admin.id,
      action: 'user_updated',
      targetUserId: userId,
      metadata: { action: 'deleted', username: targetUser?.username },
      ...metadata,
    });
    
    return { success: true };
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to delete user' 
    };
  }
}

// -----------------------------------------------------------------------------
// Reset User Password (Admin)
// -----------------------------------------------------------------------------

export async function adminResetPassword(
  userId: string,
  newPassword: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const admin = await requireAdmin();
    
    // Validate userId
    const validation = uuidSchema.safeParse(userId);
    if (!validation.success) {
      return { success: false, error: 'Invalid user ID' };
    }
    
    // Validate password with complexity requirements
    const { validatePassword } = await import('@/lib/validations');
    const passwordValidation = validatePassword(newPassword);
    if (!passwordValidation.valid) {
      return { success: false, error: passwordValidation.error };
    }
    
    const supabase = createServerClient();
    const passwordHash = await hashPassword(newPassword);
    
    const { error } = await supabase
      .from('users')
      .update({ password_hash: passwordHash })
      .eq('id', userId);
    
    if (error) throw error;
    
    // Log the action
    const metadata = await getRequestMetadata();
    await logAuditEvent({
      userId: admin.id,
      action: 'password_reset',
      targetUserId: userId,
      ...metadata,
    });
    
    return { success: true };
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to reset password' 
    };
  }
}
