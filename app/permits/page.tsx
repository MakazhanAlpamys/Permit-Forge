'use client';

// ============================================================================
// Permit Applications Dashboard
// ============================================================================

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Header } from '@/components/dashboard';
import { PermitList } from '@/components/permits';
import { getMyPermits, deletePermit } from '@/actions/permits';
import { getCSRFTokenAction } from '@/actions/auth';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { ResultDialog } from '@/components/ui/confirm-dialog';
import { useServerAction } from '@/hooks/use-server-action';
import { Plus, RefreshCw, ArrowLeft, Loader2 } from 'lucide-react';
import type { PermitApplication } from '@/types';

export default function PermitsPage() {
  const router = useRouter();
  const [permits, setPermits] = useState<PermitApplication[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [permitToDelete, setPermitToDelete] = useState<string | null>(null);
  const [csrfToken, setCsrfToken] = useState<string | null>(null);

  const loadPermits = useCallback(async (options: { silent?: boolean } = {}) => {
    if (!options.silent) setLoading(true);
    const result = await getMyPermits();
    setPermits(result.data);
    if (!options.silent) setLoading(false);
  }, []);

  useEffect(() => {
    loadPermits();
    getCSRFTokenAction().then(setCsrfToken);
  }, [loadPermits]);

  // X6: poll for status changes every 60s so an admin's approve/reject is
  // visible without manual refresh. Polling pauses when the tab is hidden
  // (battery / cost win) and the silent-flag avoids flashing the skeleton.
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const POLL_INTERVAL_MS = 60_000;
    let timer: ReturnType<typeof setInterval> | null = null;

    const tick = () => {
      if (!isMountedRef.current) return;
      if (typeof document !== 'undefined' && document.hidden) return;
      void loadPermits({ silent: true });
    };

    timer = setInterval(tick, POLL_INTERVAL_MS);
    const handleVisibilityChange = () => {
      if (typeof document !== 'undefined' && !document.hidden) {
        tick();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      if (timer) clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [loadPermits]);

  const handleView = (id: string) => {
    router.push(`/permits/${id}`);
  };

  const handleDelete = (id: string) => {
    setPermitToDelete(id);
    setDeleteDialogOpen(true);
  };

  // CP-C-2/CP-C-3 (v1.2.0 Part A): route deletePermit through useServerAction
  // so a failed delete surfaces as an error dialog rather than silently
  // closing the confirm modal.
  const deleteAction = useServerAction(deletePermit, {
    fallbackErrorMessage: 'Failed to delete permit',
    onSuccess: () => {
      setPermits(prev => prev.filter(p => p.id !== permitToDelete));
      setDeleteDialogOpen(false);
      setPermitToDelete(null);
    },
  });

  const confirmDelete = async () => {
    if (!permitToDelete) return;
    await deleteAction.run(permitToDelete, csrfToken || '');
  };

  return (
    <div className="min-h-screen bg-background">
      <Header />

      <main className="max-w-4xl mx-auto px-4 py-6">
        {/* Back button */}
        <Button
          variant="ghost"
          size="sm"
          className="mb-4"
          onClick={() => router.push('/')}
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Home
        </Button>

        {/* Page header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold">Permit Applications</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Manage your building code permit applications
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" onClick={() => loadPermits()} disabled={loading}>
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
            <Button onClick={() => router.push('/permits/new')}>
              <Plus className="h-4 w-4 mr-2" />
              New Application
            </Button>
          </div>
        </div>

        {/* Permits list */}
        <PermitList
          permits={permits}
          loading={loading}
          onView={handleView}
          onDelete={handleDelete}
        />
      </main>

      {/* Delete confirmation */}
      <Dialog
        open={deleteDialogOpen}
        onOpenChange={(open) => {
          // CP-C-7-family: don't allow backdrop-close while delete is in flight.
          if (deleteAction.isLoading) return;
          if (!open) setDeleteDialogOpen(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Draft Permit</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this draft permit? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteDialogOpen(false)}
              disabled={deleteAction.isLoading}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDelete}
              disabled={deleteAction.isLoading}
            >
              {deleteAction.isLoading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* CP-C-2/CP-C-3: visible error feedback when delete fails. */}
      <ResultDialog
        open={!!deleteAction.error}
        onOpenChange={(open) => { if (!open) deleteAction.clearError(); }}
        variant="error"
        message={deleteAction.error}
      />
    </div>
  );
}
