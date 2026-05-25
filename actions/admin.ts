'use server';

// ============================================================================
// Admin Dashboard Server Actions
// ============================================================================

import { createAdminClient } from '@/lib/supabase-server';
import { logAuditWithMeta, hashPassword } from '@/lib/auth';
import { invalidateBlockStatus } from '@/lib/block-status-cache';
import { uuidSchema, createUserSchema, validatePassword } from '@/lib/validations';
import { requireAdmin, withMutation } from '@/lib/security';
import { z } from 'zod';

// -----------------------------------------------------------------------------
// RPC Response Types (matching Supabase functions)
// -----------------------------------------------------------------------------

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
    const authCheck = await requireAdmin();
    if (!authCheck.success) {
      return { data: [], error: authCheck.error };
    }
    
    const supabase = createAdminClient();
    const { data, error } = await supabase.rpc('get_recent_audit_logs', {
      p_limit: Math.max(1, Math.min(limit, 500)),
      p_action_filter: actionFilter || null,
    });
    
    if (error) {
      console.error('getAuditLogs RPC error:', error);
      throw error;
    }
    
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
    console.error('getAuditLogs error:', error);
    return { 
      data: [], 
      error: 'Failed to fetch logs' 
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

export interface UserPageCursor {
  createdAt: string;
  id: string;
}

export async function getAllUsers(
  limit: number = 50,
  offset: number = 0,
  search?: string,
  /**
   * D12/M21: optional keyset cursor (last row of previous page). When
   * supplied, OFFSET is bypassed and the RPC seeks via
   * (created_at DESC, id DESC). Backward compatible: existing callers
   * that omit it keep offset-based pagination.
   */
  cursor?: UserPageCursor | null
): Promise<{ data: AdminUser[]; error?: string }> {
  try {
    const authCheck = await requireAdmin();
    if (!authCheck.success || !authCheck.user) {
      return { data: [], error: authCheck.error };
    }

    const supabase = createAdminClient();
    const { data, error } = await supabase.rpc('get_all_users_admin', {
      p_admin_id: authCheck.user.id,
      p_limit: Math.max(1, Math.min(limit, 100)),
      p_offset: Math.max(0, offset),
      p_search: search || null,
      p_after_created_at: cursor?.createdAt ?? null,
      p_after_id: cursor?.id ?? null,
    });
    
    if (error) {
      console.error('getAllUsers RPC error:', error);
      throw error;
    }
    
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
        sessionCount: Number(item.session_count) || 0,
        messageCount: Number(item.message_count) || 0,
      }))
    };
  } catch (error) {
    console.error('getAllUsers error:', error);
    return { 
      data: [], 
      error: 'Failed to fetch users' 
    };
  }
}

// -----------------------------------------------------------------------------
// Block/Unblock User
// -----------------------------------------------------------------------------

export async function blockUser(
  userId: string,
  blocked: boolean,
  reason?: string,
  csrfToken?: string
): Promise<{ success: boolean; error?: string }> {
  return withMutation(
    {
      admin: true,
      csrfToken,
      rateLimitAction: 'blockUser',
      schema: uuidSchema,
      input: userId,
      fallbackErrorMessage: 'Failed to update user',
    },
    async ({ user, parsed }) => {
      // Prevent admin from blocking themselves
      if (blocked && user.id === parsed) {
        return { success: false, error: 'You cannot block your own account' };
      }

      const supabase = createAdminClient();
      const { error } = await supabase.rpc('admin_block_user', {
        p_admin_id: user.id,
        p_target_user_id: parsed,
        p_blocked: blocked,
        p_reason: reason || null,
      });

      if (error) throw error;

      // B13/H7-clickpath: drop the middleware block-status cache so the next
      // request from this user re-reads the DB rather than serving stale state.
      // NOTE: Edge isolate cache not invalidated cross-runtime — TTL is the floor
      // (v1.1.0 Part C: tightened to 30s; production needs Redis).
      invalidateBlockStatus(parsed);

      await logAuditWithMeta(user.id, blocked ? 'user_blocked' : 'user_unblocked', {
        targetUserId: parsed,
        metadata: { reason },
      });

      return {};
    },
  );
}

// -----------------------------------------------------------------------------
// Update User Role
// -----------------------------------------------------------------------------

const updateUserRoleSchema = z.object({
  userId: uuidSchema,
  role: z.enum(['admin', 'user']),
});

export async function updateUserRole(
  userId: string,
  role: 'admin' | 'user',
  csrfToken?: string
): Promise<{ success: boolean; error?: string }> {
  return withMutation(
    {
      admin: true,
      csrfToken,
      rateLimitAction: 'updateUserRole',
      schema: updateUserRoleSchema,
      input: { userId, role },
      fallbackErrorMessage: 'Failed to update role',
    },
    async ({ user, parsed }) => {
      const supabase = createAdminClient();
      const { error } = await supabase.rpc('admin_update_user_role', {
        p_admin_id: user.id,
        p_target_user_id: parsed.userId,
        p_new_role: parsed.role,
      });

      if (error) throw error;

      // B13: drop cached state so the next middleware hit reflects the new role.
      // NOTE: Edge isolate cache not invalidated cross-runtime — TTL is the floor
      // (v1.1.0 Part C: tightened to 30s; production needs Redis).
      invalidateBlockStatus(parsed.userId);

      await logAuditWithMeta(user.id, 'role_changed', {
        targetUserId: parsed.userId,
        metadata: { newRole: parsed.role },
      });

      return {};
    },
  );
}

// -----------------------------------------------------------------------------
// Create New User (Admin)
// -----------------------------------------------------------------------------

export async function adminCreateUser(data: {
  username: string;
  password: string;
  full_name?: string;
  role?: 'admin' | 'user';
}, csrfToken?: string): Promise<{ success: boolean; userId?: string; error?: string }> {
  return withMutation(
    {
      admin: true,
      csrfToken,
      rateLimitAction: 'adminCreateUser',
      schema: createUserSchema,
      input: data,
      fallbackErrorMessage: 'Failed to create user',
    },
    async ({ user, parsed }) => {
      const { username, password, full_name, role } = parsed;
      const supabase = createAdminClient();
      const passwordHash = await hashPassword(password);

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

      try {
        await logAuditWithMeta(user.id, 'user_created', {
          targetUserId: newUser.id,
          metadata: { username, role: role || 'user' },
        });
      } catch (auditError) {
        console.error('Audit log error:', auditError);
      }

      return { userId: newUser.id };
    },
  );
}

// -----------------------------------------------------------------------------
// Delete User (Admin)
// -----------------------------------------------------------------------------

export async function adminDeleteUser(userId: string, csrfToken?: string): Promise<{ success: boolean; error?: string }> {
  return withMutation(
    {
      admin: true,
      csrfToken,
      rateLimitAction: 'adminDeleteUser',
      schema: uuidSchema,
      input: userId,
      fallbackErrorMessage: 'Failed to delete user',
    },
    async ({ user, parsed }) => {
      if (parsed === user.id) {
        return { success: false, error: 'Cannot delete yourself' };
      }

      const supabase = createAdminClient();

      const { data: targetUser } = await supabase
        .from('users')
        .select('username')
        .eq('id', parsed)
        .single();

      const { error } = await supabase
        .from('users')
        .delete()
        .eq('id', parsed);

      if (error) throw error;

      // B13: drop the cache so a still-pending request with this user's JWT
      // is treated as "not found" → forced logout on its next middleware pass.
      // NOTE: Edge isolate cache not invalidated cross-runtime — TTL is the floor
      // (v1.1.0 Part C: tightened to 30s; production needs Redis).
      invalidateBlockStatus(parsed);

      await logAuditWithMeta(user.id, 'user_deleted', {
        targetUserId: parsed,
        metadata: { action: 'deleted', username: targetUser?.username },
      });

      return {};
    },
  );
}

// -----------------------------------------------------------------------------
// Reset User Password (Admin)
// -----------------------------------------------------------------------------

export async function adminResetPassword(
  userId: string,
  newPassword: string,
  csrfToken?: string
): Promise<{ success: boolean; error?: string }> {
  return withMutation(
    {
      admin: true,
      csrfToken,
      rateLimitAction: 'adminResetPassword',
      schema: uuidSchema,
      input: userId,
      fallbackErrorMessage: 'Failed to reset password',
    },
    async ({ user, parsed }) => {
      // Password complexity is validated outside the schema (kept as separate
      // helper for backward compatibility with the existing error messages).
      const passwordValidation = validatePassword(newPassword);
      if (!passwordValidation.valid) {
        return { success: false, error: passwordValidation.error ?? 'Invalid password' };
      }

      const supabase = createAdminClient();
      const passwordHash = await hashPassword(newPassword);

      const { error } = await supabase
        .from('users')
        .update({ password_hash: passwordHash })
        .eq('id', parsed);

      if (error) throw error;

      // C14H: bump target user's token_version so any device still holding
      // their old JWT is logged out on the next middleware hop.
      await supabase.rpc('bump_user_token_version', { p_user_id: parsed });

      await logAuditWithMeta(user.id, 'password_reset', {
        targetUserId: parsed,
      });

      return {};
    },
  );
}
