'use client';

// ============================================================================
// Admin Dashboard - User Management Table (with Modal Dialogs)
// ============================================================================

import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { ConfirmDialog, ResultDialog } from '@/components/ui/confirm-dialog';
import {
  Users,
  Search,
  Shield,
  ShieldOff,
  Ban,
  CheckCircle,
  UserPlus,
  Key,
  Trash2,
  Loader2,
} from 'lucide-react';
import { 
  blockUser, 
  updateUserRole, 
  adminResetPassword,
  adminDeleteUser,
  type AdminUser 
} from '@/actions/admin';
import { getCSRFTokenAction } from '@/actions/auth';
import { validatePasswordClient } from '@/lib/validations';

// -----------------------------------------------------------------------------
// Modal Types
// -----------------------------------------------------------------------------

type ModalType = 'block' | 'role' | 'password' | 'delete' | 'success' | 'error' | null;

interface ModalState {
  type: ModalType;
  user: AdminUser | null;
  message?: string;
}

// -----------------------------------------------------------------------------
// Props
// -----------------------------------------------------------------------------

interface UserManagementProps {
  users: AdminUser[];
  loading?: boolean;
  onRefresh: () => void;
  onSearch: (query: string) => void;
  onCreateUser: () => void;
}

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

export function UserManagement({ 
  users, 
  loading, 
  onRefresh, 
  onSearch,
  onCreateUser
}: UserManagementProps) {
  const { t, i18n } = useTranslation();
  const [searchQuery, setSearchQuery] = useState('');
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>({ type: null, user: null });
  const csrfTokenRef = useRef<string | null>(null);
  // X3: monotonically-increasing token so a slow response from a previous
  // action (e.g. rapid Block → Unblock → Block) can't overwrite the state
  // produced by a later one. The handlers capture the token at call time
  // and drop their result when a newer action has already fired.
  const actionTokenRef = useRef(0);

  // Fetch CSRF token on mount
  useEffect(() => {
    // TS-M-2 / v1.6.0 Part F: catch + log CSRF fetch failure.
    getCSRFTokenAction()
      .then(token => { csrfTokenRef.current = token; })
      .catch(err => console.error('CSRF token fetch failed:', err));
  }, []);

  /**
   * Returns a checker that resolves to true if the action that captured this
   * token is still the most-recent. Use after every `await` before mutating
   * state so stale callbacks become no-ops.
   */
  const beginAction = () => {
    actionTokenRef.current += 1;
    const token = actionTokenRef.current;
    return () => token === actionTokenRef.current;
  };
  
  // Form states for modals
  const [blockReason, setBlockReason] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');

  // -----------------------------------------------------------------------------
  // Handlers
  // -----------------------------------------------------------------------------

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    onSearch(searchQuery);
  };

  const closeModal = () => {
    setModal({ type: null, user: null });
    setBlockReason('');
    setNewPassword('');
    setPasswordError('');
  };

  // Block/Unblock
  const openBlockModal = (user: AdminUser) => {
    setModal({ type: 'block', user });
  };

  const handleBlockConfirm = async () => {
    if (!modal.user) return;

    const isCurrent = beginAction();
    setActionLoading(modal.user.id);
    const result = await blockUser(
      modal.user.id,
      !modal.user.blocked,
      blockReason || undefined,
      csrfTokenRef.current || undefined
    );
    if (!isCurrent()) return;
    setActionLoading(null);

    if (result.success) {
      closeModal();
      onRefresh();
    } else {
      setModal({ type: 'error', user: null, message: result.error || t('errors.generic') });
    }
  };

  // Role change
  const openRoleModal = (user: AdminUser) => {
    setModal({ type: 'role', user });
  };

  const handleRoleConfirm = async () => {
    if (!modal.user) return;

    const newRole = modal.user.role === 'admin' ? 'user' : 'admin';

    const isCurrent = beginAction();
    setActionLoading(modal.user.id);
    const result = await updateUserRole(modal.user.id, newRole, csrfTokenRef.current || undefined);
    if (!isCurrent()) return;
    setActionLoading(null);

    if (result.success) {
      closeModal();
      onRefresh();
    } else {
      setModal({ type: 'error', user: null, message: result.error || t('errors.generic') });
    }
  };

  // Password reset
  const openPasswordModal = (user: AdminUser) => {
    setModal({ type: 'password', user });
    setNewPassword('');
    setPasswordError('');
  };

  // SIM-M-10 / v1.9.0 Part D: client-side preflight is now `validatePasswordClient`
  // from lib/validations, which delegates to the same Zod schema the server
  // actions use. The previous inline copy of the 5 rules was a drift hazard.

  const handlePasswordConfirm = async () => {
    if (!modal.user) return;

    const error = validatePasswordClient(newPassword);
    if (error) {
      setPasswordError(error);
      return;
    }

    const isCurrent = beginAction();
    setActionLoading(modal.user.id);
    const result = await adminResetPassword(modal.user.id, newPassword, csrfTokenRef.current || undefined);
    if (!isCurrent()) return;
    setActionLoading(null);

    if (result.success) {
      setModal({ type: 'success', user: null, message: t('profile.passwordChanged') });
    } else {
      setModal({ type: 'error', user: null, message: result.error || t('errors.generic') });
    }
  };

  // Delete user
  const openDeleteModal = (user: AdminUser) => {
    setModal({ type: 'delete', user });
  };

  const handleDeleteConfirm = async () => {
    if (!modal.user) return;

    const isCurrent = beginAction();
    setActionLoading(modal.user.id);
    const result = await adminDeleteUser(modal.user.id, csrfTokenRef.current || undefined);
    if (!isCurrent()) return;
    setActionLoading(null);

    if (result.success) {
      closeModal();
      onRefresh();
    } else {
      setModal({ type: 'error', user: null, message: result.error || t('errors.generic') });
    }
  };

  // -----------------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------------

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return t('admin.users.neverLoggedIn');
    const locale = i18n.resolvedLanguage || i18n.language || 'en';
    const tag = locale === 'kk' ? 'kk-KZ' : locale === 'ru' ? 'ru-RU' : 'en-US';
    try {
      return new Date(dateStr).toLocaleDateString(tag, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
    } catch {
      return new Date(dateStr).toLocaleDateString();
    }
  };

  // -----------------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------------

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="min-w-0">
              <CardTitle className="flex items-center gap-2">
                <Users className="h-5 w-5 text-primary" />
                {t('admin.users.title')}
              </CardTitle>
            </div>
            <Button onClick={onCreateUser} size="sm" className="shrink-0">
              <UserPlus className="h-4 w-4 mr-2" />
              {t('admin.users.createUser')}
            </Button>
          </div>

          {/* Search */}
          <form onSubmit={handleSearch} className="flex flex-col sm:flex-row gap-2 mt-4">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <label htmlFor="user-search" className="sr-only">{t('common.search')}</label>
              <input
                id="user-search"
                type="text"
                placeholder={t('common.search')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-2 text-sm rounded-md border border-input bg-background"
              />
            </div>
            <Button type="submit" variant="secondary" size="sm">
              {t('common.search')}
            </Button>
          </form>
        </CardHeader>
        
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          ) : users.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              {t('admin.users.title')} — {t('common.none')}
            </div>
          ) : (
            <div className="overflow-x-auto -mx-6 px-6 sm:mx-0 sm:px-0">
              <table className="w-full min-w-[640px]">
                <thead>
                  <tr className="border-b text-left">
                    <th className="pb-3 font-medium text-sm text-muted-foreground">{t('admin.users.username')}</th>
                    <th className="pb-3 font-medium text-sm text-muted-foreground hidden md:table-cell">{t('admin.users.role')}</th>
                    <th className="pb-3 font-medium text-sm text-muted-foreground">{t('admin.users.status')}</th>
                    <th className="pb-3 font-medium text-sm text-muted-foreground hidden lg:table-cell">{t('admin.overview.messages')}</th>
                    <th className="pb-3 font-medium text-sm text-muted-foreground hidden lg:table-cell">{t('admin.users.lastLogin')}</th>
                    <th className="pb-3 font-medium text-sm text-muted-foreground text-right">{t('admin.users.actions')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {users.map((user) => (
                    <tr key={user.id} className="hover:bg-muted/50">
                      <td className="py-4 pr-2 min-w-0">
                        <div className="min-w-0">
                          <p className="font-medium truncate">{user.username}</p>
                          <p className="text-xs text-muted-foreground truncate">
                            {user.fullName || t('common.notAvailable')}
                          </p>
                          {/* Mobile-only inline role badge (since Role column is hidden <md) */}
                          <div className="md:hidden mt-1">
                            <Badge
                              variant={user.role === 'admin' ? 'default' : 'secondary'}
                              className={user.role === 'admin' ? 'bg-purple-500/20 text-purple-700 dark:text-purple-300 border-purple-500/30' : ''}
                            >
                              {user.role === 'admin' && <Shield className="h-3 w-3 mr-1" />}
                              {user.role === 'admin' ? t('admin.users.roleAdmin') : t('admin.users.roleUser')}
                            </Badge>
                          </div>
                        </div>
                      </td>
                      <td className="py-4 hidden md:table-cell">
                        <Badge
                          variant={user.role === 'admin' ? 'default' : 'secondary'}
                          className={user.role === 'admin' ? 'bg-purple-500/20 text-purple-700 dark:text-purple-300 border-purple-500/30' : ''}
                        >
                          {user.role === 'admin' && <Shield className="h-3 w-3 mr-1" />}
                          {user.role}
                        </Badge>
                      </td>
                      <td className="py-4">
                        {user.blocked ? (
                          <Badge variant="destructive" className="bg-red-500/20 text-red-700 dark:text-red-300 border-red-500/30">
                            <Ban className="h-3 w-3 mr-1" />
                            {t('admin.users.blocked')}
                          </Badge>
                        ) : (
                          <Badge className="bg-violet-500/20 text-violet-700 dark:text-violet-300 border-violet-500/30">
                            <CheckCircle className="h-3 w-3 mr-1" />
                            {t('admin.users.active')}
                          </Badge>
                        )}
                      </td>
                      <td className="py-4 hidden lg:table-cell">
                        <div className="text-sm">
                          <p>{user.sessionCount}</p>
                          <p className="text-xs text-muted-foreground">{user.messageCount} {t('admin.overview.messages')}</p>
                        </div>
                      </td>
                      <td className="py-4 text-sm text-muted-foreground hidden lg:table-cell">
                        {formatDate(user.lastLogin)}
                      </td>
                      <td className="py-4">
                        <div className="flex items-center justify-end gap-1 flex-wrap">
                          {actionLoading === user.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => openRoleModal(user)}
                                aria-label={user.role === 'admin' ? `Remove admin role from ${user.username}` : `Make ${user.username} an admin`}
                                title={user.role === 'admin' ? 'Remove admin' : 'Make admin'}
                              >
                                {user.role === 'admin' ? (
                                  <ShieldOff className="h-4 w-4 text-orange-600 dark:text-orange-400" />
                                ) : (
                                  <Shield className="h-4 w-4 text-purple-600 dark:text-purple-400" />
                                )}
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => openBlockModal(user)}
                                aria-label={user.blocked ? `Unblock ${user.username}` : `Block ${user.username}`}
                                title={user.blocked ? 'Unblock user' : 'Block user'}
                              >
                                {user.blocked ? (
                                  <CheckCircle className="h-4 w-4 text-violet-600 dark:text-violet-400" />
                                ) : (
                                  <Ban className="h-4 w-4 text-red-600 dark:text-red-400" />
                                )}
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => openPasswordModal(user)}
                                aria-label={`Reset password for ${user.username}`}
                                title="Reset password"
                              >
                                <Key className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => openDeleteModal(user)}
                                aria-label={`Delete ${user.username}`}
                                title="Delete user"
                              >
                                <Trash2 className="h-4 w-4 text-red-600 dark:text-red-400" />
                              </Button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Block / Unblock */}
      <ConfirmDialog
        open={modal.type === 'block'}
        onOpenChange={(open) => !open && closeModal()}
        title={modal.user?.blocked ? t('admin.users.unblock') : t('admin.users.block')}
        description={t('admin.users.blockConfirm', { username: modal.user?.username ?? '' })}
        body={
          !modal.user?.blocked ? (
            <>
              <label className="text-sm font-medium">{t('admin.users.blockReason')}</label>
              <Input
                placeholder={t('admin.users.blockReason')}
                value={blockReason}
                onChange={(e) => setBlockReason(e.target.value)}
                className="mt-2"
              />
            </>
          ) : undefined
        }
        confirmLabel={modal.user?.blocked ? t('admin.users.unblock') : t('admin.users.block')}
        confirmVariant={modal.user?.blocked ? 'default' : 'destructive'}
        loading={actionLoading === modal.user?.id}
        onConfirm={handleBlockConfirm}
      />

      {/* Role Change */}
      <ConfirmDialog
        open={modal.type === 'role'}
        onOpenChange={(open) => !open && closeModal()}
        title={t('admin.users.role')}
        description={
          <>
            <strong>{modal.user?.username}</strong>:{' '}
            <strong>{modal.user?.role === 'admin' ? t('admin.users.roleUser') : t('admin.users.roleAdmin')}</strong>
          </>
        }
        confirmLabel={t('common.confirm')}
        loading={actionLoading === modal.user?.id}
        onConfirm={handleRoleConfirm}
      />

      {/* Password Reset */}
      <ConfirmDialog
        open={modal.type === 'password'}
        onOpenChange={(open) => !open && closeModal()}
        title={t('admin.users.resetPassword')}
        description={modal.user?.username ? `${t('admin.users.resetPassword')}: ${modal.user.username}` : t('admin.users.resetPassword')}
        body={
          <>
            <label className="text-sm font-medium">{t('profile.newPassword')}</label>
            <Input
              type="password"
              placeholder={t('profile.newPassword')}
              value={newPassword}
              onChange={(e) => {
                setNewPassword(e.target.value);
                setPasswordError('');
              }}
              className="mt-2"
            />
            {passwordError && (
              <p className="text-sm text-red-500 mt-2">{passwordError}</p>
            )}
            <p className="text-xs text-muted-foreground mt-2">
              {t('auth.register.passwordPlaceholder')}
            </p>
          </>
        }
        confirmLabel={t('admin.users.resetPassword')}
        loading={actionLoading === modal.user?.id}
        disabled={!newPassword}
        onConfirm={handlePasswordConfirm}
      />

      {/* Delete User */}
      <ConfirmDialog
        open={modal.type === 'delete'}
        onOpenChange={(open) => !open && closeModal()}
        title={t('admin.users.delete')}
        destructive
        description={t('admin.users.deleteConfirm', { username: modal.user?.username ?? '' })}
        confirmLabel={t('admin.users.delete')}
        confirmVariant="destructive"
        loading={actionLoading === modal.user?.id}
        onConfirm={handleDeleteConfirm}
      />

      {/* Success */}
      <ResultDialog
        open={modal.type === 'success'}
        onOpenChange={(open) => !open && closeModal()}
        variant="success"
        message={modal.message}
      />

      {/* Error */}
      <ResultDialog
        open={modal.type === 'error'}
        onOpenChange={(open) => !open && closeModal()}
        variant="error"
        message={modal.message}
      />
    </>
  );
}
