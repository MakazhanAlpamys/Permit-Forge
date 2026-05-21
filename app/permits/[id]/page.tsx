'use client';

// ============================================================================
// Permit Application Detail View
// ============================================================================

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Header } from '@/components/dashboard';
import {
  PermitDetailView,
  ComplianceCheckPanel,
  PermitStatusTimeline,
  FileUploadZone,
  AttachmentList,
} from '@/components/permits';
import { getPermitById, getPermitHistory, runComplianceCheck, submitPermit, deletePermit, revisePermit } from '@/actions/permits';
import { getCSRFTokenAction } from '@/actions/auth';
import { getPermitAttachments } from '@/actions/permit-attachments';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { ArrowLeft, Send, ShieldCheck, Trash2, Loader2, Download, RotateCcw } from 'lucide-react';
import type { PermitApplication, PermitStatusHistoryEntry, PermitAttachment } from '@/types';

export default function PermitDetailPage() {
  const params = useParams();
  const router = useRouter();
  const permitId = params.id as string;

  const [permit, setPermit] = useState<PermitApplication | null>(null);
  const [history, setHistory] = useState<PermitStatusHistoryEntry[]>([]);
  const [attachments, setAttachments] = useState<PermitAttachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');
  const [csrfToken, setCsrfToken] = useState<string | null>(null);

  const flashWarning = (msg: string) => {
    setWarning(msg);
    setTimeout(() => setWarning(prev => (prev === msg ? '' : prev)), 6000);
  };

  // B8: when navigating in from /permits/new on submit, the flash warning is
  // stashed in sessionStorage so it survives the navigation. Drain it on mount.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const flashKey = `permit-warning-${permitId}`;
    const flash = window.sessionStorage.getItem(flashKey);
    if (flash) {
      window.sessionStorage.removeItem(flashKey);
      flashWarning(flash);
    }
  }, [permitId]);

  const loadPermit = useCallback(async () => {
    setLoading(true);
    const [permitResult, historyResult, attachResult] = await Promise.all([
      getPermitById(permitId),
      getPermitHistory(permitId),
      getPermitAttachments(permitId),
    ]);

    if (permitResult.data) {
      setPermit(permitResult.data);
    } else {
      setError(permitResult.error || 'Permit not found');
    }

    setHistory(historyResult.data);
    setAttachments(attachResult.data);
    setLoading(false);
  }, [permitId]);

  useEffect(() => {
    loadPermit();
    getCSRFTokenAction().then(setCsrfToken);
  }, [loadPermit]);

  const handleRunCheck = async () => {
    setActionLoading('check');
    setError('');
    const result = await runComplianceCheck(permitId, csrfToken || '');
    setActionLoading(null);

    if (result.success) {
      await loadPermit();
    } else {
      setError(result.error || 'Failed to run compliance check');
    }
  };

  // B7: ref-based in-flight guard. React state updates trail user clicks by a
  // render, so a fast double-tap on Submit can dispatch two server actions
  // before `actionLoading` flips. The ref short-circuits the second call
  // synchronously.
  const submitInFlightRef = useRef(false);
  const reviseInFlightRef = useRef(false);

  const handleSubmit = async () => {
    if (submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    setActionLoading('submit');
    setError('');
    try {
      const result = await submitPermit(permitId, csrfToken || '');
      if (result.success) {
        if (result.warning) flashWarning(result.warning);
        await loadPermit();
      } else {
        setError(result.error || 'Failed to submit');
      }
    } finally {
      setActionLoading(null);
      submitInFlightRef.current = false;
    }
  };

  const handleDelete = async () => {
    const result = await deletePermit(permitId, csrfToken || '');
    if (result.success) {
      router.push('/permits');
    } else {
      setError(result.error || 'Failed to delete');
    }
    setDeleteDialogOpen(false);
  };

  const handleRevise = async () => {
    if (reviseInFlightRef.current) return;
    reviseInFlightRef.current = true;
    setActionLoading('revise');
    setError('');
    try {
      const result = await revisePermit(permitId, csrfToken || '');
      if (result.success) {
        await loadPermit();
      } else {
        setError(result.error || 'Failed to start revision');
      }
    } finally {
      setActionLoading(null);
      reviseInFlightRef.current = false;
    }
  };

  const handleDownloadCertificate = async () => {
    setActionLoading('certificate');
    setError('');
    try {
      const response = await fetch(`/api/permits/${permitId}/certificate`);
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to download certificate');
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `permit-certificate-${permitId}.pdf`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to download certificate');
    } finally {
      // X8: ensure the "Downloading..." spinner clears even if the fetch /
      // blob path threw mid-way. Previously the unconditional line below the
      // try/catch was unreachable on certain throw paths in browsers.
      setActionLoading(null);
    }
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

  const isDraft = permit.status === 'draft';
  const canRevise = permit.status === 'rejected' || permit.status === 'revision_requested';

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

          <div className="flex items-center gap-2">
            {/* Draft actions */}
            {isDraft && (
              <>
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
              </>
            )}

            {/* Approved — Download Certificate */}
            {permit.status === 'approved' && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleDownloadCertificate}
                disabled={actionLoading !== null}
              >
                {actionLoading === 'certificate' ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Download className="h-4 w-4 mr-2" />
                )}
                Download Certificate
              </Button>
            )}

            {/* Rejected/Revision Requested — Revise & Resubmit */}
            {canRevise && (
              <Button
                size="sm"
                onClick={handleRevise}
                disabled={actionLoading !== null}
              >
                {actionLoading === 'revise' ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <RotateCcw className="h-4 w-4 mr-2" />
                )}
                Revise & Resubmit
              </Button>
            )}
          </div>
        </div>

        {/* Revision Notes Banner */}
        {permit.status === 'revision_requested' && permit.revisionNotes && (
          <div className="mb-4 p-4 rounded-lg bg-orange-500/10 border border-orange-500/30">
            <h4 className="text-sm font-semibold text-orange-400 mb-1">Revision Required</h4>
            <p className="text-sm text-orange-300/90">{permit.revisionNotes}</p>
          </div>
        )}

        {error && (
          <div className="mb-4 p-3 rounded-md bg-red-500/10 border border-red-500/30 text-red-500 text-sm">
            {error}
          </div>
        )}

        {warning && (
          <div className="mb-4 p-3 rounded-md bg-yellow-500/10 border border-yellow-500/30 text-yellow-600 text-sm">
            {warning}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Main content */}
          <div className="lg:col-span-2 space-y-4">
            <PermitDetailView permit={permit} />

            {permit.complianceCheckResult && (
              <ComplianceCheckPanel result={permit.complianceCheckResult} />
            )}

            {/* Attachments Section */}
            <div className="rounded-lg border border-border bg-card p-4">
              {isDraft ? (
                <FileUploadZone
                  permitId={permitId}
                  attachments={attachments}
                  onUpdate={loadPermit}
                />
              ) : (
                <AttachmentList attachments={attachments} />
              )}
            </div>
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
