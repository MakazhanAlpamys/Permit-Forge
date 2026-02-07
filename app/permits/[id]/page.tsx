'use client';

// ============================================================================
// Permit Application Detail View
// ============================================================================

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Header } from '@/components/dashboard';
import {
  PermitDetailView,
  ComplianceCheckPanel,
  PermitStatusTimeline,
} from '@/components/permits';
import { getPermitById, getPermitHistory, runComplianceCheck, submitPermit, deletePermit } from '@/actions/permits';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { ArrowLeft, Send, ShieldCheck, Trash2, Loader2 } from 'lucide-react';
import type { PermitApplication, PermitStatusHistoryEntry } from '@/types';

export default function PermitDetailPage() {
  const params = useParams();
  const router = useRouter();
  const permitId = params.id as string;

  const [permit, setPermit] = useState<PermitApplication | null>(null);
  const [history, setHistory] = useState<PermitStatusHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [error, setError] = useState('');

  const loadPermit = useCallback(async () => {
    setLoading(true);
    const [permitResult, historyResult] = await Promise.all([
      getPermitById(permitId),
      getPermitHistory(permitId),
    ]);

    if (permitResult.data) {
      setPermit(permitResult.data);
    } else {
      setError(permitResult.error || 'Permit not found');
    }

    setHistory(historyResult.data);
    setLoading(false);
  }, [permitId]);

  useEffect(() => {
    loadPermit();
  }, [loadPermit]);

  const handleRunCheck = async () => {
    setActionLoading('check');
    setError('');
    const result = await runComplianceCheck(permitId);
    setActionLoading(null);

    if (result.success) {
      await loadPermit();
    } else {
      setError(result.error || 'Failed to run compliance check');
    }
  };

  const handleSubmit = async () => {
    setActionLoading('submit');
    setError('');
    const result = await submitPermit(permitId);
    setActionLoading(null);

    if (result.success) {
      await loadPermit();
    } else {
      setError(result.error || 'Failed to submit');
    }
  };

  const handleDelete = async () => {
    const result = await deletePermit(permitId);
    if (result.success) {
      router.push('/permits');
    } else {
      setError(result.error || 'Failed to delete');
    }
    setDeleteDialogOpen(false);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background">
        <Header />
        <main className="max-w-4xl mx-auto px-4 py-6">
          <div className="space-y-4">
            <div className="h-32 rounded-lg bg-muted animate-pulse" />
            <div className="h-48 rounded-lg bg-muted animate-pulse" />
          </div>
        </main>
      </div>
    );
  }

  if (!permit) {
    return (
      <div className="min-h-screen bg-background">
        <Header />
        <main className="max-w-4xl mx-auto px-4 py-6">
          <p className="text-muted-foreground">{error || 'Permit not found'}</p>
          <Button variant="outline" className="mt-4" onClick={() => router.push('/permits')}>
            Back to Permits
          </Button>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Header />

      <main className="max-w-4xl mx-auto px-4 py-6">
        {/* Back + Actions */}
        <div className="flex items-center justify-between mb-6">
          <Button variant="ghost" size="sm" onClick={() => router.push('/permits')}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Permits
          </Button>

          {permit.status === 'draft' && (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleRunCheck}
                disabled={actionLoading !== null}
              >
                {actionLoading === 'check' ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <ShieldCheck className="h-4 w-4 mr-2" />
                )}
                AI Check
              </Button>
              <Button
                size="sm"
                onClick={handleSubmit}
                disabled={actionLoading !== null}
              >
                {actionLoading === 'submit' ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Send className="h-4 w-4 mr-2" />
                )}
                Submit
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setDeleteDialogOpen(true)}
                disabled={actionLoading !== null}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>

        {error && (
          <div className="mb-4 p-3 rounded-md bg-red-500/10 border border-red-500/30 text-red-500 text-sm">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Main content */}
          <div className="lg:col-span-2 space-y-4">
            <PermitDetailView permit={permit} />

            {permit.complianceCheckResult && (
              <ComplianceCheckPanel result={permit.complianceCheckResult} />
            )}
          </div>

          {/* Sidebar — Timeline */}
          <div>
            <h3 className="text-sm font-semibold mb-3">Status History</h3>
            <PermitStatusTimeline history={history} />
          </div>
        </div>
      </main>

      {/* Delete confirmation */}
      <Dialog open={deleteDialogOpen} onOpenChange={(open) => !open && setDeleteDialogOpen(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Draft Permit</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete &quot;{permit.projectName}&quot;? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
