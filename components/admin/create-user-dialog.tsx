'use client';

// ============================================================================
// Admin Dashboard - Create User Dialog
// ============================================================================

import { useState, useEffect, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { 
  UserPlus,
  X,
  Loader2,
  Eye,
  EyeOff
} from 'lucide-react';
import { adminCreateUser } from '@/actions/admin';
import { getCSRFTokenAction } from '@/actions/auth';

interface CreateUserDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export function CreateUserDialog({ isOpen, onClose, onSuccess }: CreateUserDialogProps) {
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const csrfTokenRef = useRef<string | null>(null);
  const [formData, setFormData] = useState({
    username: '',
    password: '',
    full_name: '',
    role: 'user' as 'admin' | 'user',
  });

  useEffect(() => {
    if (isOpen) {
      // TS-M-2 / v1.6.0 Part F: catch + log CSRF fetch failure.
      getCSRFTokenAction()
        .then(token => { csrfTokenRef.current = token; })
        .catch(err => console.error('CSRF token fetch failed:', err));
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    const result = await adminCreateUser(formData, csrfTokenRef.current || undefined);

    setLoading(false);

    if (result.success) {
      // X11: close the dialog first, then clear local form state, then ask
      // the parent to refresh the user list. The previous order
      // (`onSuccess` -> `onClose`) made the parent re-render with the dialog
      // still mounted, causing a one-frame flicker as the user table
      // repopulated under the open modal.
      onClose();
      setFormData({ username: '', password: '', full_name: '', role: 'user' });
      onSuccess();
    } else {
      setError(result.error || 'Failed to create user');
    }
  };

  // CP-D-5 (v1.2.0): block backdrop / X close while submit is in flight, so
  // a quick click outside doesn't cancel a half-finished create + leak the
  // password from local form state.
  const safeClose = () => { if (!loading) onClose(); };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-user-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={safeClose}
        aria-hidden="true"
      />

      {/* Dialog */}
      <Card className="relative z-10 w-full max-w-md max-h-[90vh] overflow-y-auto">
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle id="create-user-dialog-title" className="flex items-center gap-2 min-w-0">
              <UserPlus className="h-5 w-5 text-primary shrink-0" />
              <span className="truncate">Create New User</span>
            </CardTitle>
            <Button
              variant="ghost"
              size="icon"
              onClick={safeClose}
              disabled={loading}
              aria-label="Close create user dialog"
              className="shrink-0"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          <CardDescription>
            Add a new user to the system
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Username */}
            <div className="space-y-2">
              <label htmlFor="create-user-username" className="text-sm font-medium">Username *</label>
              <input
                id="create-user-username"
                type="text"
                required
                autoComplete="username"
                value={formData.username}
                onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm"
                placeholder="Enter username"
                disabled={loading}
              />
            </div>

            {/* Full Name */}
            <div className="space-y-2">
              <label htmlFor="create-user-fullname" className="text-sm font-medium">Full Name</label>
              <input
                id="create-user-fullname"
                type="text"
                autoComplete="name"
                value={formData.full_name}
                onChange={(e) => setFormData({ ...formData, full_name: e.target.value })}
                className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm"
                placeholder="Enter full name (optional)"
                disabled={loading}
              />
            </div>

            {/* Password */}
            <div className="space-y-2">
              <label htmlFor="create-user-password" className="text-sm font-medium">Password *</label>
              <div className="relative">
                <input
                  id="create-user-password"
                  type={showPassword ? 'text' : 'password'}
                  required
                  minLength={8}
                  autoComplete="new-password"
                  value={formData.password}
                  onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                  className="w-full px-3 py-2 pr-10 rounded-md border border-input bg-background text-sm"
                  placeholder="Minimum 8 characters"
                  disabled={loading}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {/* Role */}
            <div className="space-y-2">
              <label htmlFor="create-user-role" className="text-sm font-medium">Role *</label>
              <select
                id="create-user-role"
                value={formData.role}
                onChange={(e) => setFormData({ ...formData, role: e.target.value as 'admin' | 'user' })}
                className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm"
                disabled={loading}
              >
                <option value="user">User</option>
                <option value="admin">Admin</option>
              </select>
            </div>

            {/* Error */}
            {error && (
              <div role="alert" className="p-3 rounded-md bg-red-500/10 border border-red-500/30 text-red-700 dark:text-red-300 text-sm">
                {error}
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-3 pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={safeClose}
                disabled={loading}
                className="flex-1"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={loading}
                className="flex-1"
              >
                {loading ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Creating...
                  </>
                ) : (
                  <>
                    <UserPlus className="h-4 w-4 mr-2" />
                    Create User
                  </>
                )}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
