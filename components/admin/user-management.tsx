'use client';

// ============================================================================
// Admin Dashboard - User Management Table
// ============================================================================

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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
  Loader2
} from 'lucide-react';
import { 
  blockUser, 
  updateUserRole, 
  adminResetPassword,
  adminDeleteUser,
  type AdminUser 
} from '@/actions/admin';

interface UserManagementProps {
  users: AdminUser[];
  loading?: boolean;
  onRefresh: () => void;
  onSearch: (query: string) => void;
  onCreateUser: () => void;
}

export function UserManagement({ 
  users, 
  loading, 
  onRefresh, 
  onSearch,
  onCreateUser 
}: UserManagementProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    onSearch(searchQuery);
  };

  const handleBlockToggle = async (user: AdminUser) => {
    if (actionLoading) return;
    
    const reason = !user.blocked ? prompt('Enter reason for blocking (optional):') : undefined;
    
    setActionLoading(user.id);
    const result = await blockUser(user.id, !user.blocked, reason || undefined);
    setActionLoading(null);
    
    if (result.success) {
      onRefresh();
    } else {
      alert(result.error || 'Failed to update user');
    }
  };

  const handleRoleToggle = async (user: AdminUser) => {
    if (actionLoading) return;
    
    const newRole = user.role === 'admin' ? 'user' : 'admin';
    const confirmed = confirm(`Change ${user.username}'s role to ${newRole}?`);
    if (!confirmed) return;
    
    setActionLoading(user.id);
    const result = await updateUserRole(user.id, newRole);
    setActionLoading(null);
    
    if (result.success) {
      onRefresh();
    } else {
      alert(result.error || 'Failed to update role');
    }
  };

  const handleResetPassword = async (user: AdminUser) => {
    if (actionLoading) return;
    
    const newPassword = prompt(`Enter new password for ${user.username}:`);
    if (!newPassword) return;
    
    if (newPassword.length < 8) {
      alert('Password must be at least 8 characters');
      return;
    }
    
    setActionLoading(user.id);
    const result = await adminResetPassword(user.id, newPassword);
    setActionLoading(null);
    
    if (result.success) {
      alert('Password reset successfully');
    } else {
      alert(result.error || 'Failed to reset password');
    }
  };

  const handleDeleteUser = async (user: AdminUser) => {
    if (actionLoading) return;
    
    const confirmed = confirm(`Are you sure you want to delete ${user.username}? This action cannot be undone.`);
    if (!confirmed) return;
    
    setActionLoading(user.id);
    const result = await adminDeleteUser(user.id);
    setActionLoading(null);
    
    if (result.success) {
      onRefresh();
    } else {
      alert(result.error || 'Failed to delete user');
    }
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return 'Never';
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  return (
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
                              onClick={() => handleRoleToggle(user)}
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
                              onClick={() => handleBlockToggle(user)}
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
                              onClick={() => handleResetPassword(user)}
                              title="Reset password"
                            >
                              <Key className="h-4 w-4 text-blue-500" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handleDeleteUser(user)}
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
  );
}
