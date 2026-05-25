'use client';

// ============================================================================
// Document Management Component — Phase 4: Dynamic Document Registry
// Combined view: document list + add/edit + ingestion + per-document stats
// ============================================================================

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  getAllRegisteredDocuments,
  upsertDocument,
  deleteDocument,
  restoreDocument,
  checkPdfReingest,
  type DocumentRecord,
} from '@/actions/documents';
import { clearDocumentChunks, getIngestionStatus, testRAGQuery } from '@/actions/ingest-pdf';
import { getCSRFTokenAction } from '@/actions/auth';
import { useIngestionStream } from '@/hooks/use-ingestion-stream';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Upload,
  Trash2,
  CheckCircle,
  XCircle,
  Loader2,
  Database,
  RefreshCw,
  AlertTriangle,
  Zap,
  BookOpen,
  Plus,
  Pencil,
  RotateCcw,
  Archive,
  X,
} from 'lucide-react';
import { DocumentForm, type DocumentFormValues } from './document-form';
import { ConfirmDialog, ResultDialog } from '@/components/ui/confirm-dialog';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface DiagnosticInfo {
  dbConnected: boolean;
  totalChunkCount: number;
  documentStats: { document_name: string; chunk_count: number; min_page: number; max_page: number }[];
  rpcWorking: boolean;
  loading: boolean;
  error?: string;
}

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

export function DocumentManagement() {
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingDocument, setEditingDocument] = useState<DocumentRecord | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const csrfTokenRef = useRef<string | null>(null);

  // X9: unified confirmation dialog state. Each call-site stashes its details
  // here and the single <ConfirmDialog> at the bottom of the tree renders it.
  // Replaces 4 `window.confirm()` calls that were inconsistent with the rest
  // of the admin UI (which already uses shadcn dialogs everywhere else).
  interface PendingConfirm {
    title: string;
    description: React.ReactNode;
    confirmLabel: string;
    destructive?: boolean;
    onConfirm: () => Promise<void> | void;
  }
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const [confirmLoading, setConfirmLoading] = useState(false);

  const runConfirm = async () => {
    if (!pendingConfirm) return;
    setConfirmLoading(true);
    try {
      await pendingConfirm.onConfirm();
    } finally {
      setConfirmLoading(false);
      setPendingConfirm(null);
    }
  };

  const [diagnostic, setDiagnostic] = useState<DiagnosticInfo>({
    dbConnected: false,
    totalChunkCount: 0,
    documentStats: [],
    rpcWorking: false,
    loading: true,
  });

  // Load documents from DB
  const loadDocuments = useCallback(async () => {
    setLoading(true);
    const result = await getAllRegisteredDocuments();
    if (result.data) {
      setDocuments(result.data);
    }
    setLoading(false);
  }, []);

  // Run diagnostics
  const runDiagnostics = useCallback(async () => {
    setDiagnostic(prev => ({ ...prev, loading: true }));
    try {
      const [dbStatus, rpcStatus] = await Promise.all([
        getIngestionStatus(),
        testRAGQuery(),
      ]);
      setDiagnostic({
        dbConnected: dbStatus.dbConnected,
        totalChunkCount: dbStatus.chunkCount,
        documentStats: dbStatus.documentStats || [],
        rpcWorking: rpcStatus.success,
        loading: false,
        error: dbStatus.error || rpcStatus.error,
      });
    } catch (error) {
      setDiagnostic({
        dbConnected: false,
        totalChunkCount: 0,
        documentStats: [],
        rpcWorking: false,
        loading: false,
        error: error instanceof Error ? error.message : 'Diagnostic failed',
      });
    }
  }, []);

  // Ingestion stream — encapsulates SSE parsing, AbortController, and per-doc
  // status / progress state (F17).
  const {
    statuses: ingestionStatus,
    messages: ingestionMessages,
    activeProgress,
    startIngestion,
    cancelIngestion,
    setStatus: setIngestionStatus,
  } = useIngestionStream({
    onComplete: () => {
      // Refresh per-document chunk stats once each ingestion finishes.
      void runDiagnostics();
    },
  });

  useEffect(() => {
    loadDocuments();
    runDiagnostics();
    // TS-M-2 / v1.6.0 Part F: catch + log CSRF fetch failure.
    getCSRFTokenAction()
      .then(token => { csrfTokenRef.current = token; })
      .catch(err => console.error('CSRF token fetch failed:', err));
  }, [loadDocuments, runDiagnostics]);

  // Form handlers
  const openAddForm = () => {
    setEditingDocument(null);
    setFormError(null);
    setShowForm(true);
  };

  const openEditForm = (doc: DocumentRecord) => {
    setEditingDocument(doc);
    setFormError(null);
    setShowForm(true);
  };

  const handleSave = async (formData: DocumentFormValues, pdfFile: File | null) => {
    if (!formData.displayName || !formData.shortName) {
      setFormError('Display Name and Short Name are required');
      return;
    }

    const editingId = editingDocument?.id ?? null;

    // For new documents, require either a PDF file or a filename
    if (!editingId && !pdfFile && !formData.fileName) {
      setFormError('Please select a PDF file');
      return;
    }

    const docId = editingId || formData.id || formData.displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-');
    const fileName = pdfFile ? pdfFile.name : formData.fileName;

    setSaving(true);
    setFormError(null);

    try {
      // Step 1: Save metadata
      const result = await upsertDocument({
        id: docId,
        displayName: formData.displayName,
        shortName: formData.shortName,
        fileName,
        sourceUrl: formData.sourceUrl,
        authority: formData.authority,
        description: formData.description,
        badgeColor: formData.badgeColor,
        keywords: formData.keywords.split(',').map(k => k.trim()).filter(Boolean),
        categories: formData.categories.split(',').map(c => c.trim()).filter(Boolean),
      }, csrfTokenRef.current || '');

      if (!result.success) {
        // CP-C-4 (v1.2.0 Part B): when the action reports a soft-deleted
        // collision, route the user into the restore confirm flow rather
        // than leaving them staring at a generic "save failed" message.
        if (result.code === 'soft_deleted') {
          setShowForm(false);
          setFormError(null);
          handleRestore(docId, formData.displayName);
          return;
        }
        setFormError(result.error || 'Failed to save');
        return;
      }

      // Step 2: Upload PDF if selected.
      // C5H/H6: uploads go through /api/admin/documents/upload (an API route)
      // instead of the uploadDocumentPDF server action, so we don't need a
      // 100MB body cap on every server action.
      if (pdfFile) {
        setUploading(true);
        const uploadData = new FormData();
        uploadData.append('documentId', docId);
        uploadData.append('file', pdfFile);

        let uploadResult: { success: boolean; error?: string };
        try {
          const resp = await fetch('/api/admin/documents/upload', {
            method: 'POST',
            headers: { 'x-csrf-token': csrfTokenRef.current || '' },
            body: uploadData,
          });
          uploadResult = await resp.json().catch(() => ({
            success: false,
            error: `Upload failed: HTTP ${resp.status}`,
          }));
        } finally {
          setUploading(false);
        }

        if (!uploadResult.success) {
          // B14: the metadata row was just inserted (or updated) but the PDF
          // never landed. Behavior depends on whether this is a new-document
          // flow or an edit:
          //   - NEW (no editingId): compensating-delete the row so we don't
          //     leave an empty registry entry behind. Hard-delete (clearChunks
          //     true) because the doc has no chunks yet anyway.
          //   - EDIT: keep the row and surface a sticky warning — the existing
          //     PDF (if any) and chunks are still valid; only the new upload
          //     attempt failed.
          if (!editingId) {
            await deleteDocument(docId, true, csrfTokenRef.current || '');
            setFormError(
              (uploadResult.error || 'PDF upload failed') +
                ' — the document entry was rolled back. Please try again.',
            );
          } else {
            setFormError(
              (uploadResult.error || 'PDF upload failed') +
                ' — metadata was saved but the new PDF was not uploaded. The previous PDF (if any) is unchanged.',
            );
          }
          loadDocuments();
          return;
        }
      }

      setShowForm(false);
      setEditingDocument(null);
      loadDocuments();
      runDiagnostics();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'An unexpected error occurred');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = (docId: string, docName: string) => {
    setPendingConfirm({
      title: 'Deactivate Document',
      description: (
        <>
          Deactivate <strong>{docName}</strong>? This will hide it from search but preserve its data.
        </>
      ),
      confirmLabel: 'Deactivate',
      onConfirm: async () => {
        const result = await deleteDocument(docId, false, csrfTokenRef.current || '');
        if (result.success) {
          loadDocuments();
        } else {
          // v1.2.0 re-audit follow-up: was silent on failure (audit flagged
          // it as the same silent-else family v1.2.0 set out to fix).
          setRestoreError(result.error || 'Failed to deactivate document');
        }
      },
    });
  };

  const handleDeleteWithChunks = (docId: string, docName: string) => {
    setPendingConfirm({
      title: 'Delete Document',
      description: (
        <>
          Delete <strong>{docName}</strong> and all its chunks? This cannot be undone.
        </>
      ),
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: async () => {
        const result = await deleteDocument(docId, true, csrfTokenRef.current || '');
        if (result.success) {
          loadDocuments();
          runDiagnostics();
        } else {
          // v1.2.0 re-audit follow-up: was silent on failure.
          setRestoreError(result.error || 'Failed to delete document');
        }
      },
    });
  };

  // CP-C-5 (v1.2.0 Part B): route restore through the unified ConfirmDialog so
  // it matches every other destructive/state-changing action in the admin UI,
  // and surface failures as a sticky error (was: button click silently no-op'd
  // if the action failed).
  const [restoreError, setRestoreError] = useState<string | null>(null);

  const handleRestore = (docId: string, docName?: string) => {
    setPendingConfirm({
      title: 'Restore Document',
      description: (
        <>
          Restore <strong>{docName || docId}</strong>? It will become active and visible to users again.
        </>
      ),
      confirmLabel: 'Restore',
      destructive: false,
      onConfirm: async () => {
        const result = await restoreDocument(docId, csrfTokenRef.current || '');
        if (result.success) {
          loadDocuments();
        } else {
          setRestoreError(result.error || 'Failed to restore document');
        }
      },
    });
  };

  // Ingestion handlers
  const handleIngestDocument = async (documentId: string) => {
    // B5: when the uploaded PDF differs from the one that produced the
    // existing chunk set, mixing old + new chunks would silently corrupt
    // search results. Prompt before continuing.
    let reingestInfo: { hashChanged: boolean; chunkCount: number } | null = null;
    try {
      const reingest = await checkPdfReingest(documentId);
      if (reingest.hashChanged && reingest.chunkCount > 0) {
        reingestInfo = { hashChanged: true, chunkCount: reingest.chunkCount };
      }
    } catch {
      // If the hash-check call fails, fall through to the normal ingest path
      // — better to risk a duplicate-chunks warning than to block re-ingest.
    }

    if (reingestInfo) {
      const chunkCount = reingestInfo.chunkCount;
      setPendingConfirm({
        title: 'Replace existing chunks?',
        description: (
          <>
            The uploaded PDF differs from the one that produced the current {chunkCount} chunks.
            Replace existing {chunkCount} chunks before re-ingesting?
          </>
        ),
        confirmLabel: 'Replace and re-ingest',
        destructive: true,
        onConfirm: async () => {
          await startIngestion(documentId, csrfTokenRef.current, true);
        },
      });
      return;
    }

    await startIngestion(documentId, csrfTokenRef.current, false);
  };

  // B4: cancel an in-flight ingestion. Server route listens on request.signal
  // between stages and stamps ingestion_state='aborted'.
  const handleCancelIngestion = (documentId: string) => {
    cancelIngestion(documentId);
  };

  const handleClearChunks = (documentId: string, displayName: string) => {
    setPendingConfirm({
      title: 'Clear all chunks',
      description: (
        <>
          Clear all chunks for <strong>{displayName}</strong>? This cannot be undone.
        </>
      ),
      confirmLabel: 'Clear',
      destructive: true,
      onConfirm: async () => {
        setIngestionStatus(documentId, 'loading');
        try {
          const result = await clearDocumentChunks(documentId, csrfTokenRef.current || '');
          if (result.success) {
            setIngestionStatus(documentId, 'idle', `Cleared ${result.deletedCount || 0} chunks`);
            runDiagnostics();
          } else {
            setIngestionStatus(documentId, 'error', result.error || 'Failed to clear');
          }
        } catch (error) {
          setIngestionStatus(documentId, 'error', error instanceof Error ? error.message : 'Failed');
        }
      },
    });
  };

  const getDocChunkCount = (docId: string) => {
    const stat = diagnostic.documentStats.find(s => s.document_name === docId);
    return stat?.chunk_count || 0;
  };

  const getDocPageRange = (docId: string) => {
    const stat = diagnostic.documentStats.find(s => s.document_name === docId);
    if (!stat || stat.chunk_count === 0) return null;
    return `pp. ${stat.min_page}-${stat.max_page}`;
  };

  const activeDocuments = documents.filter(d => d.isActive);
  const inactiveDocuments = documents.filter(d => !d.isActive);

  return (
    <>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Document Management</h2>
          <p className="text-muted-foreground">Manage documents, ingestion, and search configuration</p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => { loadDocuments(); runDiagnostics(); }}>
            <RefreshCw className={`h-4 w-4 ${loading || diagnostic.loading ? 'animate-spin' : ''}`} />
          </Button>
          <Button onClick={openAddForm} size="sm">
            <Plus className="h-4 w-4 mr-1" />
            Add Document
          </Button>
        </div>
      </div>

      <div className="grid gap-6 max-w-4xl">
        {/* System Diagnostics */}
        <Card className={diagnostic.error ? 'border-yellow-500/50' : 'border-violet-500/50'}>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Zap className="h-4 w-4 text-yellow-500" />
              System Status
            </CardTitle>
          </CardHeader>
          <CardContent>
            {diagnostic.loading ? (
              <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <Loader2 className="h-4 w-4 animate-spin" /> Running diagnostics...
              </div>
            ) : (
              <div className="flex flex-wrap gap-4 text-sm">
                <div className="flex items-center gap-1.5">
                  {diagnostic.dbConnected ? <CheckCircle className="h-3.5 w-3.5 text-green-500" /> : <XCircle className="h-3.5 w-3.5 text-red-500" />}
                  Database
                </div>
                <div className="flex items-center gap-1.5">
                  {diagnostic.rpcWorking ? <CheckCircle className="h-3.5 w-3.5 text-green-500" /> : <XCircle className="h-3.5 w-3.5 text-red-500" />}
                  Hybrid Search
                </div>
                <div className="flex items-center gap-1.5">
                  <Database className="h-3.5 w-3.5 text-muted-foreground" />
                  {diagnostic.totalChunkCount} total chunks
                </div>
                <div className="flex items-center gap-1.5">
                  <BookOpen className="h-3.5 w-3.5 text-muted-foreground" />
                  {activeDocuments.length} active documents
                </div>
                {diagnostic.error && (
                  <div className="w-full mt-2 p-2 rounded bg-yellow-500/10 border border-yellow-500/30 flex items-start gap-2">
                    <AlertTriangle className="h-4 w-4 text-yellow-500 mt-0.5 shrink-0" />
                    <span className="text-xs text-muted-foreground">{diagnostic.error}</span>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Add/Edit Form */}
        {showForm && (
          <DocumentForm
            editingDocument={editingDocument}
            saving={saving}
            uploading={uploading}
            error={formError}
            onSave={handleSave}
            onCancel={() => {
              setShowForm(false);
              setEditingDocument(null);
              setFormError(null);
            }}
          />
        )}

        {/* Document Cards */}
        {loading ? (
          <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading documents...
          </div>
        ) : (
          <>
            {activeDocuments.map(doc => {
              const chunkCount = getDocChunkCount(doc.id);
              const pageRange = getDocPageRange(doc.id);
              const status = ingestionStatus[doc.id] || 'idle';
              const message = ingestionMessages[doc.id] || '';
              const progress = activeProgress[doc.id];
              const isIngested = chunkCount > 0;

              return (
                <Card key={doc.id} className={isIngested ? 'border-violet-500/30' : ''}>
                  <CardHeader className="pb-3">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <BookOpen className="h-4 w-4 text-primary" />
                      <span className="flex-1 truncate">{doc.displayName}</span>
                      <Badge variant="outline" className={`text-[10px] px-1.5 py-0 h-5 shrink-0 ${doc.badgeColor}`}>
                        {doc.shortName}
                      </Badge>
                      {doc.storagePath ? (
                        <Badge className="bg-green-500/20 text-green-400 border-green-500/30 text-[10px] shrink-0">
                          PDF
                        </Badge>
                      ) : (
                        <Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/30 text-[10px] shrink-0">
                          No PDF
                        </Badge>
                      )}
                      {isIngested && (
                        <Badge className="bg-violet-500/20 text-violet-400 border-violet-500/30 text-[10px] shrink-0">
                          {chunkCount} chunks
                        </Badge>
                      )}
                      <Button variant="ghost" size="sm" className="h-7 w-7 p-0 shrink-0" onClick={() => openEditForm(doc)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                    </CardTitle>
                    <CardDescription className="text-xs flex items-center gap-3">
                      <span className="flex items-center gap-1">
                        <Database className="h-3 w-3" />
                        {doc.fileName}
                      </span>
                      {pageRange && <span className="text-muted-foreground">{pageRange}</span>}
                      {doc.keywords.length > 0 && (
                        <span className="text-muted-foreground">{doc.keywords.length} keywords</span>
                      )}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {/* Progress Bar */}
                    {progress && (
                      <div className="space-y-2">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-muted-foreground">{progress.message}</span>
                          <span className="font-medium">{progress.progress}%</span>
                        </div>
                        <div className="h-2 w-full bg-muted rounded-full overflow-hidden">
                          <div
                            className="h-full bg-primary transition-all duration-300 ease-out"
                            style={{ width: `${progress.progress}%` }}
                          />
                        </div>
                        {progress.chunksProcessed !== undefined && progress.chunksProcessed > 0 && (
                          <p className="text-[10px] text-muted-foreground text-center">
                            {progress.chunksProcessed} chunks processed
                          </p>
                        )}
                      </div>
                    )}

                    {/* Status message */}
                    {message && !progress && (
                      <div className={`text-xs p-2 rounded ${
                        status === 'success' ? 'bg-violet-500/10 text-violet-400' :
                        status === 'error' ? 'bg-red-500/10 text-red-400' : 'text-muted-foreground'
                      }`}>
                        {status === 'success' && <CheckCircle className="h-3 w-3 inline mr-1" />}
                        {status === 'error' && <XCircle className="h-3 w-3 inline mr-1" />}
                        {message}
                      </div>
                    )}

                    {/* Action buttons */}
                    <div className="flex gap-2">
                      <Button
                        onClick={() => handleIngestDocument(doc.id)}
                        disabled={status === 'loading' || !diagnostic.dbConnected || !doc.storagePath}
                        size="sm"
                        className="flex-1"
                        title={!doc.storagePath ? 'Upload a PDF first' : undefined}
                      >
                        {status === 'loading' ? (
                          <>
                            <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                            {progress ? `${progress.progress}%` : 'Processing...'}
                          </>
                        ) : (
                          <>
                            <Upload className="mr-1.5 h-3 w-3" />
                            {isIngested ? 'Re-ingest' : 'Ingest'}
                          </>
                        )}
                      </Button>

                      {/* B4: surface a Cancel button only while an ingestion is
                          actually streaming for this doc. */}
                      {status === 'loading' && (
                        <Button
                          onClick={() => handleCancelIngestion(doc.id)}
                          variant="outline"
                          size="sm"
                          title="Cancel ingestion"
                        >
                          <X className="mr-1.5 h-3 w-3" />
                          Cancel
                        </Button>
                      )}

                      {isIngested && status !== 'loading' && (
                        <Button
                          onClick={() => handleClearChunks(doc.id, doc.displayName)}
                          variant="outline"
                          size="sm"
                        >
                          <Trash2 className="mr-1.5 h-3 w-3" />
                          Clear
                        </Button>
                      )}

                      <Button
                        onClick={() => handleDelete(doc.id, doc.displayName)}
                        disabled={status === 'loading'}
                        variant="ghost"
                        size="sm"
                        className="text-muted-foreground hover:text-red-400"
                      >
                        <Archive className="h-3 w-3" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}

            {/* Inactive Documents */}
            {inactiveDocuments.length > 0 && (
              <div className="pt-4">
                <button
                  onClick={() => setShowInactive(!showInactive)}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
                >
                  <Archive className="h-3 w-3" />
                  {showInactive ? 'Hide' : 'Show'} {inactiveDocuments.length} deactivated document{inactiveDocuments.length > 1 ? 's' : ''}
                </button>

                {showInactive && (
                  <div className="mt-3 space-y-3">
                    {inactiveDocuments.map(doc => (
                      <Card key={doc.id} className="opacity-60 border-dashed">
                        <CardContent className="flex items-center justify-between py-3">
                          <div className="flex items-center gap-2">
                            <Badge variant="outline" className={`text-[10px] px-1.5 py-0 h-5 ${doc.badgeColor}`}>
                              {doc.shortName}
                            </Badge>
                            <span className="text-sm text-muted-foreground">{doc.displayName}</span>
                          </div>
                          <div className="flex gap-2">
                            <Button size="sm" variant="outline" onClick={() => handleRestore(doc.id, doc.displayName)}>
                              <RotateCcw className="h-3 w-3 mr-1" />
                              Restore
                            </Button>
                            <Button
                              size="sm"
                              variant="destructive"
                              onClick={() => handleDeleteWithChunks(doc.id, doc.displayName)}
                            >
                              <Trash2 className="h-3 w-3 mr-1" />
                              Delete + Chunks
                            </Button>
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      <ConfirmDialog
        open={pendingConfirm !== null}
        onOpenChange={(open) => { if (!open) setPendingConfirm(null); }}
        title={pendingConfirm?.title ?? ''}
        description={pendingConfirm?.description}
        confirmLabel={pendingConfirm?.confirmLabel ?? 'Confirm'}
        confirmVariant={pendingConfirm?.destructive ? 'destructive' : 'default'}
        destructive={pendingConfirm?.destructive}
        loading={confirmLoading}
        onConfirm={runConfirm}
      />

      {/* CP-C-5: visible error feedback when restore fails. */}
      <ResultDialog
        open={!!restoreError}
        onOpenChange={(open) => { if (!open) setRestoreError(null); }}
        variant="error"
        message={restoreError}
      />
    </>
  );
}
