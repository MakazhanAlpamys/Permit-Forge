'use client';

// ============================================================================
// Admin Dashboard - User Management Table (with Modal Dialogs)
// ============================================================================

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
  AlertTriangle
} from 'lucide-react';
import { 
  blockUser, 
  updateUserRole, 
  adminResetPassword,
  adminDeleteUser,
  type AdminUser 
} from '@/actions/admin';

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
  const [searchQuery, setSearchQuery] = useState('');
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>({ type: null, user: null });
  
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
    
    setActionLoading(modal.user.id);
    const result = await blockUser(
      modal.user.id, 
      !modal.user.blocked, 
      blockReason || undefined
    );
    setActionLoading(null);
    
    if (result.success) {
      closeModal();
      onRefresh();
    } else {
      setModal({ type: 'error', user: null, message: result.error || 'Failed to update user' });
    }
  };

  // Role change
  const openRoleModal = (user: AdminUser) => {
    setModal({ type: 'role', user });
  };

  const handleRoleConfirm = async () => {
    if (!modal.user) return;
    
    const newRole = modal.user.role === 'admin' ? 'user' : 'admin';
    
    setActionLoading(modal.user.id);
    const result = await updateUserRole(modal.user.id, newRole);
    setActionLoading(null);
    
    if (result.success) {
      closeModal();
      onRefresh();
    } else {
      setModal({ type: 'error', user: null, message: result.error || 'Failed to update role' });
    }
  };

  // Password reset
  const openPasswordModal = (user: AdminUser) => {
    setModal({ type: 'password', user });
    setNewPassword('');
    setPasswordError('');
  };

  const validatePassword = (password: string): string | null => {
    if (password.length < 8) return 'Password must be at least 8 characters';
    if (!/[A-Z]/.test(password)) return 'Password must contain an uppercase letter';
    if (!/[a-z]/.test(password)) return 'Password must contain a lowercase letter';
    if (!/[0-9]/.test(password)) return 'Password must contain a digit';
    if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/.test(password)) {
      return 'Password must contain a special character';
    }
    return null;
  };

  const handlePasswordConfirm = async () => {
    if (!modal.user) return;
    
    const error = validatePassword(newPassword);
    if (error) {
      setPasswordError(error);
      return;
    }
    
    setActionLoading(modal.user.id);
    const result = await adminResetPassword(modal.user.id, newPassword);
    setActionLoading(null);
    
    if (result.success) {
      setModal({ type: 'success', user: null, message: 'Password reset successfully' });
    } else {
      setModal({ type: 'error', user: null, message: result.error || 'Failed to reset password' });
    }
  };

  // Delete user
  const openDeleteModal = (user: AdminUser) => {
    setModal({ type: 'delete', user });
  };

  const handleDeleteConfirm = async () => {
    if (!modal.user) return;
    
    setActionLoading(modal.user.id);
    const result = await adminDeleteUser(modal.user.id);
    setActionLoading(null);
    
    if (result.success) {
      closeModal();
      onRefresh();
    } else {
      setModal({ type: 'error', user: null, message: result.error || 'Failed to delete user' });
    }
  };

  // -----------------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------------

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return 'Never';
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  // -----------------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------------

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Users className="h-5 w-5 text-primary" />
                User Management
              </CardTitle>
              <CardDescription>
                Manage user accounts, roles, and access
              </CardDescription>
            </div>
            <Button onClick={onCreateUser} size="sm">
              <UserPlus className="h-4 w-4 mr-2" />
              Add User
            </Button>
          </div>
          
          {/* Search */}
          <form onSubmit={handleSearch} className="flex gap-2 mt-4">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <input
                type="text"
                placeholder="Search users..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-2 text-sm rounded-md border border-input bg-background"
              />
            </div>
            <Button type="submit" variant="secondary" size="sm">
              Search
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
              No users found
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b text-left">
                    <th className="pb-3 font-medium text-sm text-muted-foreground">User</th>
                    <th className="pb-3 font-medium text-sm text-muted-foreground">Role</th>
                    <th className="pb-3 font-medium text-sm text-muted-foreground">Status</th>
                    <th className="pb-3 font-medium text-sm text-muted-foreground">Activity</th>
                    <th className="pb-3 font-medium text-sm text-muted-foreground">Last Login</th>
                    <th className="pb-3 font-medium text-sm text-muted-foreground text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {users.map((user) => (
                    <tr key={user.id} className="hover:bg-muted/50">
                      <td className="py-4">
                        <div>
                          <p className="font-medium">{user.username}</p>
                          <p className="text-xs text-muted-foreground">
                            {user.fullName || 'No name'}
                          </p>
                        </div>
                      </td>
                      <td className="py-4">
                        <Badge 
                          variant={user.role === 'admin' ? 'default' : 'secondary'}
                          className={user.role === 'admin' ? 'bg-purple-500/20 text-purple-400 border-purple-500/30' : ''}
                        >
                          {user.role === 'admin' && <Shield className="h-3 w-3 mr-1" />}
                          {user.role}
                        </Badge>
                      </td>
                      <td className="py-4">
                        {user.blocked ? (
                          <Badge variant="destructive" className="bg-red-500/20 text-red-400 border-red-500/30">
                            <Ban className="h-3 w-3 mr-1" />
                            Blocked
                          </Badge>
                        ) : (
                          <Badge className="bg-green-500/20 text-green-400 border-green-500/30">
                            <CheckCircle className="h-3 w-3 mr-1" />
                            Active
                          </Badge>
                        )}
                      </td>
                      <td className="py-4">
                        <div className="text-sm">
                          <p>{user.sessionCount} sessions</p>
                          <p className="text-xs text-muted-foreground">{user.messageCount} messages</p>
                        </div>
                      </td>
                      <td className="py-4 text-sm text-muted-foreground">
                        {formatDate(user.lastLogin)}
                      </td>
                      <td className="py-4">
                        <div className="flex items-center justify-end gap-2">
                          {actionLoading === user.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => openRoleModal(user)}
                                title={user.role === 'admin' ? 'Remove admin' : 'Make admin'}
                              >
                                {user.role === 'admin' ? (
                                  <ShieldOff className="h-4 w-4 text-orange-500" />
                                ) : (
                                  <Shield className="h-4 w-4 text-purple-500" />
                                )}
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => openBlockModal(user)}
                                title={user.blocked ? 'Unblock user' : 'Block user'}
                              >
                                {user.blocked ? (
                                  <CheckCircle className="h-4 w-4 text-green-500" />
                                ) : (
                                  <Ban className="h-4 w-4 text-red-500" />
                                )}
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => openPasswordModal(user)}
                                title="Reset password"
                              >
                                <Key className="h-4 w-4 text-blue-500" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => openDeleteModal(user)}
                                title="Delete user"
                              >
                                <Trash2 className="h-4 w-4 text-red-500" />
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

      {/* Block/Unblock Modal */}
      <Dialog open={modal.type === 'block'} onOpenChange={(open) => !open && closeModal()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {modal.user?.blocked ? 'Unblock User' : 'Block User'}
            </DialogTitle>
            <DialogDescription>
              {modal.user?.blocked 
                ? `Are you sure you want to unblock ${modal.user?.username}?`
                : `Are you sure you want to block ${modal.user?.username}? They will not be able to log in.`
              }
            </DialogDescription>
          </DialogHeader>
          
          {!modal.user?.blocked && (
            <div className="py-4">
              <label className="text-sm font-medium">Reason (optional)</label>
              <Input
                placeholder="Enter reason for blocking..."
                value={blockReason}
                onChange={(e) => setBlockReason(e.target.value)}
                className="mt-2"
              />
            </div>
          )}
          
          <DialogFooter>
            <Button variant="outline" onClick={closeModal}>
              Cancel
            </Button>
            <Button 
              variant={modal.user?.blocked ? 'default' : 'destructive'}
              onClick={handleBlockConfirm}
              disabled={actionLoading === modal.user?.id}
            >
              {actionLoading === modal.user?.id && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {modal.user?.blocked ? 'Unblock' : 'Block'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Role Change Modal */}
      <Dialog open={modal.type === 'role'} onOpenChange={(open) => !open && closeModal()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change User Role</DialogTitle>
            <DialogDescription>
              Change {modal.user?.username}&apos;s role from{' '}
              <strong>{modal.user?.role}</strong> to{' '}
              <strong>{modal.user?.role === 'admin' ? 'user' : 'admin'}</strong>?
            </DialogDescription>
          </DialogHeader>
          
          <DialogFooter>
            <Button variant="outline" onClick={closeModal}>
              Cancel
            </Button>
            <Button 
              onClick={handleRoleConfirm}
              disabled={actionLoading === modal.user?.id}
            >
              {actionLoading === modal.user?.id && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Change Role
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Password Reset Modal */}
      <Dialog open={modal.type === 'password'} onOpenChange={(open) => !open && closeModal()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset Password</DialogTitle>
            <DialogDescription>
              Enter a new password for {modal.user?.username}
            </DialogDescription>
          </DialogHeader>
          
          <div className="py-4">
            <label className="text-sm font-medium">New Password</label>
            <Input
              type="password"
              placeholder="Enter new password..."
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
              Password must be at least 8 characters with uppercase, lowercase, digit, and special character.
            </p>
          </div>
          
          <DialogFooter>
            <Button variant="outline" onClick={closeModal}>
              Cancel
            </Button>
            <Button 
              onClick={handlePasswordConfirm}
              disabled={actionLoading === modal.user?.id || !newPassword}
            >
              {actionLoading === modal.user?.id && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Reset Password
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete User Modal */}
      <Dialog open={modal.type === 'delete'} onOpenChange={(open) => !open && closeModal()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-500">
              <AlertTriangle className="h-5 w-5" />
              Delete User
            </DialogTitle>
            <DialogDescription>
              Are you sure you want to delete <strong>{modal.user?.username}</strong>? 
              This action cannot be undone. All user data including chat history will be permanently deleted.
            </DialogDescription>
          </DialogHeader>
          
          <DialogFooter>
            <Button variant="outline" onClick={closeModal}>
              Cancel
            </Button>
            <Button 
              variant="destructive"
              onClick={handleDeleteConfirm}
              disabled={actionLoading === modal.user?.id}
            >
              {actionLoading === modal.user?.id && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Delete User
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Success Modal */}
      <Dialog open={modal.type === 'success'} onOpenChange={(open) => !open && closeModal()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-green-500">
              <CheckCircle className="h-5 w-5" />
              Success
            </DialogTitle>
            <DialogDescription>
              {modal.message}
            </DialogDescription>
          </DialogHeader>
          
          <DialogFooter>
            <Button onClick={closeModal}>
              OK
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Error Modal */}
      <Dialog open={modal.type === 'error'} onOpenChange={(open) => !open && closeModal()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-500">
              <AlertTriangle className="h-5 w-5" />
              Error
            </DialogTitle>
            <DialogDescription>
              {modal.message}
            </DialogDescription>
          </DialogHeader>
          
          <DialogFooter>
            <Button onClick={closeModal}>
              OK
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
