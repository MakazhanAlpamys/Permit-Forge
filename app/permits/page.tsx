'use client';

// ============================================================================
// Permit Applications Dashboard
// ============================================================================

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Header } from '@/components/dashboard';
import { PermitList } from '@/components/permits';
import { getMyPermits, deletePermit } from '@/actions/permits';
import { getCSRFTokenAction } from '@/actions/auth';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Plus, RefreshCw, ArrowLeft } from 'lucide-react';
import type { PermitApplication } from '@/types';

export default function PermitsPage() {
  const router = useRouter();
  const [permits, setPermits] = useState<PermitApplication[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [permitToDelete, setPermitToDelete] = useState<string | null>(null);
  const [csrfToken, setCsrfToken] = useState<string | null>(null);

  const loadPermits = useCallback(async () => {
    setLoading(true);
    const result = await getMyPermits();
    setPermits(result.data);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadPermits();
    getCSRFTokenAction().then(setCsrfToken);
    // P2-M10: poll every 30 s so a status flip from the admin (under_review →
    // approved/rejected) is visible without a manual refresh. The
    // notification bell already polls at the same interval — keep them
    // aligned but offset by a small jitter to avoid synchronised waves
    // of requests across many tabs (P2-L4).
    const jitter = Math.floor(Math.random() * 5_000);
    const interval = setInterval(loadPermits, 30_000 + jitter);
    return () => clearInterval(interval);
  }, [loadPermits]);

  const handleView = (id: string) => {
    router.push(`/permits/${id}`);
  };

  const handleDelete = (id: string) => {
    setPermitToDelete(id);
    setDeleteDialogOpen(true);
  };

  const confirmDelete = async () => {
    if (!permitToDelete) return;
    const result = await deletePermit(permitToDelete, csrfToken || '');
    if (result.success) {
      setPermits(prev => prev.filter(p => p.id !== permitToDelete));
    }
    setDeleteDialogOpen(false);
    setPermitToDelete(null);
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
            <Button variant="outline" size="icon" onClick={loadPermits} disabled={loading}>
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
      <Dialog open={deleteDialogOpen} onOpenChange={(open) => !open && setDeleteDialogOpen(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Draft Permit</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this draft permit? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={confirmDelete}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
