'use client';

// ============================================================================
// Document Management Component — Phase 4: Dynamic Document Registry
// Combined view: document list + add/edit + ingestion + per-document stats
// ============================================================================

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  getAllRegisteredDocuments,
  upsertDocument,
  uploadDocumentPDF,
  deleteDocument,
  restoreDocument,
  checkPdfReingest,
  type DocumentRecord,
} from '@/actions/documents';
import { clearDocumentChunks, getIngestionStatus, testRAGQuery } from '@/actions/ingest-pdf';
import { getCSRFTokenAction } from '@/actions/auth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
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

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

type IngestionStatus = 'idle' | 'loading' | 'success' | 'error';

interface ProgressInfo {
  stage: string;
  progress: number;
  total: number;
  message: string;
  chunksProcessed?: number;
}

interface DiagnosticInfo {
  dbConnected: boolean;
  totalChunkCount: number;
  documentStats: { document_name: string; chunk_count: number; min_page: number; max_page: number }[];
  rpcWorking: boolean;
  loading: boolean;
  error?: string;
}

interface DocumentFormData {
  id: string;
  displayName: string;
  shortName: string;
  fileName: string;
  sourceUrl: string;
  authority: string;
  description: string;
  badgeColor: string;
  keywords: string;
  categories: string;
}

const EMPTY_FORM: DocumentFormData = {
  id: '',
  displayName: '',
  shortName: '',
  fileName: '',
  sourceUrl: '',
  authority: '',
  description: '',
  badgeColor: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
  keywords: '',
  categories: '',
};

const BADGE_COLORS = [
  { label: 'Blue', value: 'bg-blue-500/20 text-blue-400 border-blue-500/30' },
  { label: 'Red', value: 'bg-red-500/20 text-red-400 border-red-500/30' },
  { label: 'Violet', value: 'bg-violet-500/20 text-violet-400 border-violet-500/30' },
  { label: 'Purple', value: 'bg-purple-500/20 text-purple-400 border-purple-500/30' },
  { label: 'Cyan', value: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30' },
  { label: 'Green', value: 'bg-green-500/20 text-green-400 border-green-500/30' },
  { label: 'Orange', value: 'bg-orange-500/20 text-orange-400 border-orange-500/30' },
  { label: 'Yellow', value: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30' },
  { label: 'Gray', value: 'bg-gray-500/20 text-gray-400 border-gray-500/30' },
];

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

export function DocumentManagement() {
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState<DocumentFormData>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const csrfTokenRef = useRef<string | null>(null);

  // Ingestion state
  const [ingestionStatus, setIngestionStatus] = useState<Record<string, IngestionStatus>>({});
  const [ingestionMessages, setIngestionMessages] = useState<Record<string, string>>({});
  const [activeProgress, setActiveProgress] = useState<Record<string, ProgressInfo>>({});

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

  useEffect(() => {
    loadDocuments();
    runDiagnostics();
    getCSRFTokenAction().then(token => { csrfTokenRef.current = token; });
  }, [loadDocuments, runDiagnostics]);

  // Form handlers
  const openAddForm = () => {
    setEditingId(null);
    setFormData(EMPTY_FORM);
    setFormError(null);
    setPdfFile(null);
    setShowForm(true);
  };

  const openEditForm = (doc: DocumentRecord) => {
    setEditingId(doc.id);
    setFormData({
      id: doc.id,
      displayName: doc.displayName,
      shortName: doc.shortName,
      fileName: doc.fileName,
      sourceUrl: doc.sourceUrl,
      authority: doc.authority,
      description: doc.description,
      badgeColor: doc.badgeColor,
      keywords: doc.keywords.join(', '),
      categories: doc.categories.join(', '),
    });
    setFormError(null);
    setPdfFile(null);
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!formData.displayName || !formData.shortName) {
      setFormError('Display Name and Short Name are required');
      return;
    }

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
        setFormError(result.error || 'Failed to save');
        return;
      }

      // Step 2: Upload PDF if selected
      if (pdfFile) {
        setUploading(true);
        const uploadData = new FormData();
        uploadData.append('file', pdfFile);

        let uploadResult: { success: boolean; error?: string };
        try {
          uploadResult = await uploadDocumentPDF(docId, uploadData, csrfTokenRef.current || '');
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
      setPdfFile(null);
      loadDocuments();
      runDiagnostics();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'An unexpected error occurred');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (docId: string, docName: string) => {
    if (!confirm(`Deactivate "${docName}"? This will hide it from search but preserve its data.`)) return;

    const result = await deleteDocument(docId, false, csrfTokenRef.current || '');
    if (result.success) {
      loadDocuments();
    }
  };

  const handleDeleteWithChunks = async (docId: string, docName: string) => {
    if (!confirm(`DELETE "${docName}" and all its chunks? This cannot be undone.`)) return;

    const result = await deleteDocument(docId, true, csrfTokenRef.current || '');
    if (result.success) {
      loadDocuments();
      runDiagnostics();
    }
  };

  const handleRestore = async (docId: string) => {
    const result = await restoreDocument(docId, csrfTokenRef.current || '');
    if (result.success) {
      loadDocuments();
    }
  };

  // Ingestion handlers
  const handleIngestDocument = async (documentId: string) => {
    // B5: when the uploaded PDF differs from the one that produced the
    // existing chunk set, mixing old + new chunks would silently corrupt
    // search results. Prompt before continuing.
    let replaceChunks = false;
    try {
      const reingest = await checkPdfReingest(documentId);
      if (reingest.hashChanged && reingest.chunkCount > 0) {
        const ok = window.confirm(
          `The uploaded PDF differs from the one that produced the current ${reingest.chunkCount} chunks. ` +
            `Replace existing ${reingest.chunkCount} chunks before re-ingesting?\n\n` +
            `Click OK to clear prior chunks and re-ingest, Cancel to abort.`,
        );
        if (!ok) return;
        replaceChunks = true;
      }
    } catch {
      // If the hash-check call fails, fall through to the normal ingest path
      // — better to risk a duplicate-chunks warning than to block re-ingest.
    }

    setIngestionStatus(prev => ({ ...prev, [documentId]: 'loading' }));
    setIngestionMessages(prev => ({ ...prev, [documentId]: 'Starting ingestion...' }));
    setActiveProgress(prev => ({ ...prev, [documentId]: { stage: 'starting', progress: 0, total: 100, message: 'Connecting...' } }));

    try {
      const response = await fetch('/api/ingest', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-csrf-token': csrfTokenRef.current || '',
        },
        body: JSON.stringify({ documentId, replaceChunks }),
      });

      if (!response.ok) throw new Error('Failed to start ingestion');

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      if (!reader) throw new Error('No response stream');

      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        // Keep the last (potentially incomplete) line in the buffer
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              setActiveProgress(prev => ({
                ...prev,
                [documentId]: {
                  stage: data.stage,
                  progress: data.progress,
                  total: data.total,
                  message: data.message,
                  chunksProcessed: data.chunksProcessed,
                },
              }));

              if (data.done) {
                if (data.error) {
                  setIngestionStatus(prev => ({ ...prev, [documentId]: 'error' }));
                  setIngestionMessages(prev => ({ ...prev, [documentId]: data.error }));
                } else {
                  setIngestionStatus(prev => ({ ...prev, [documentId]: 'success' }));
                  setIngestionMessages(prev => ({ ...prev, [documentId]: `${data.chunksProcessed || 0} chunks ingested` }));
                }
                setActiveProgress(prev => {
                  const next = { ...prev };
                  delete next[documentId];
                  return next;
                });
              }
            } catch {
              // Ignore parse errors for incomplete lines
            }
          }
        }
      }
    } catch (error) {
      setIngestionStatus(prev => ({ ...prev, [documentId]: 'error' }));
      setIngestionMessages(prev => ({ ...prev, [documentId]: error instanceof Error ? error.message : 'Failed' }));
      setActiveProgress(prev => {
        const next = { ...prev };
        delete next[documentId];
        return next;
      });
    }

    runDiagnostics();
  };

  const handleClearChunks = async (documentId: string, displayName: string) => {
    if (!confirm(`Clear all chunks for "${displayName}"? This cannot be undone.`)) return;

    setIngestionStatus(prev => ({ ...prev, [documentId]: 'loading' }));
    try {
      const result = await clearDocumentChunks(documentId, csrfTokenRef.current || '');
      if (result.success) {
        setIngestionStatus(prev => ({ ...prev, [documentId]: 'idle' }));
        setIngestionMessages(prev => ({ ...prev, [documentId]: `Cleared ${result.deletedCount || 0} chunks` }));
        runDiagnostics();
      } else {
        setIngestionStatus(prev => ({ ...prev, [documentId]: 'error' }));
        setIngestionMessages(prev => ({ ...prev, [documentId]: result.error || 'Failed to clear' }));
      }
    } catch (error) {
      setIngestionStatus(prev => ({ ...prev, [documentId]: 'error' }));
      setIngestionMessages(prev => ({ ...prev, [documentId]: error instanceof Error ? error.message : 'Failed' }));
    }
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
          <Card className="border-primary/50">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center justify-between text-base">
                <span>{editingId ? 'Edit Document' : 'Register New Document'}</span>
                <Button variant="ghost" size="sm" onClick={() => setShowForm(false)}>
                  <X className="h-4 w-4" />
                </Button>
              </CardTitle>
              <CardDescription>
                {editingId ? 'Update document metadata. Select a new PDF to replace the existing one.' : 'Add a new document and upload its PDF file.'}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Display Name *</label>
                  <Input
                    value={formData.displayName}
                    onChange={e => setFormData(prev => ({ ...prev, displayName: e.target.value }))}
                    placeholder="Building Code 2021"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Short Name *</label>
                  <Input
                    value={formData.shortName}
                    onChange={e => setFormData(prev => ({ ...prev, shortName: e.target.value }))}
                    placeholder="DBC"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">PDF File *</label>
                  <input
                    type="file"
                    accept=".pdf,application/pdf"
                    onChange={e => {
                      const file = e.target.files?.[0] || null;
                      setPdfFile(file);
                      if (file) {
                        setFormData(prev => ({ ...prev, fileName: file.name }));
                      }
                    }}
                    className="block w-full text-sm text-muted-foreground file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:text-xs file:font-medium file:bg-primary file:text-primary-foreground hover:file:bg-primary/90 file:cursor-pointer cursor-pointer mt-1"
                  />
                  {editingId && !pdfFile && formData.fileName && (
                    <p className="text-[10px] text-muted-foreground mt-1">
                      Current: {formData.fileName}
                    </p>
                  )}
                  {pdfFile && (
                    <p className="text-[10px] text-muted-foreground mt-1">
                      {pdfFile.name} ({(pdfFile.size / 1024 / 1024).toFixed(1)} MB)
                    </p>
                  )}
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Authority</label>
                  <Input
                    value={formData.authority}
                    onChange={e => setFormData(prev => ({ ...prev, authority: e.target.value }))}
                    placeholder="e.g., City Authority"
                  />
                </div>
              </div>

              {!editingId && (
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Document ID (auto-generated from name if empty)</label>
                  <Input
                    value={formData.id}
                    onChange={e => setFormData(prev => ({ ...prev, id: e.target.value }))}
                    placeholder="building-code-2021"
                  />
                </div>
              )}

              <div>
                <label className="text-xs font-medium text-muted-foreground">Description</label>
                <Input
                  value={formData.description}
                  onChange={e => setFormData(prev => ({ ...prev, description: e.target.value }))}
                  placeholder="Brief description of the document"
                />
              </div>

              <div>
                <label className="text-xs font-medium text-muted-foreground">Source URL</label>
                <Input
                  value={formData.sourceUrl}
                  onChange={e => setFormData(prev => ({ ...prev, sourceUrl: e.target.value }))}
                  placeholder="https://..."
                />
              </div>

              <div>
                <label className="text-xs font-medium text-muted-foreground">Keywords (comma-separated, for search routing)</label>
                <Input
                  value={formData.keywords}
                  onChange={e => setFormData(prev => ({ ...prev, keywords: e.target.value }))}
                  placeholder="building, code, construction, parking"
                />
              </div>

              <div>
                <label className="text-xs font-medium text-muted-foreground">Categories (comma-separated)</label>
                <Input
                  value={formData.categories}
                  onChange={e => setFormData(prev => ({ ...prev, categories: e.target.value }))}
                  placeholder="structural, general"
                />
              </div>

              <div>
                <label className="text-xs font-medium text-muted-foreground">Badge Color</label>
                <div className="flex flex-wrap gap-2 mt-1">
                  {BADGE_COLORS.map(color => (
                    <button
                      key={color.label}
                      onClick={() => setFormData(prev => ({ ...prev, badgeColor: color.value }))}
                      className={`px-2 py-1 rounded text-xs border transition-all ${color.value} ${
                        formData.badgeColor === color.value ? 'ring-2 ring-primary ring-offset-1 ring-offset-background' : ''
                      }`}
                    >
                      {color.label}
                    </button>
                  ))}
                </div>
              </div>

              {formError && (
                <div className="p-2 rounded bg-red-500/10 border border-red-500/30 text-xs text-red-400">
                  {formError}
                </div>
              )}

              <div className="flex gap-2 pt-2">
                <Button onClick={handleSave} disabled={saving || uploading} size="sm">
                  {(saving || uploading) ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
                  {uploading ? 'Uploading PDF...' : saving ? 'Saving...' : editingId ? 'Update' : 'Register'}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setShowForm(false)}>Cancel</Button>
              </div>
            </CardContent>
          </Card>
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

                      {isIngested && (
                        <Button
                          onClick={() => handleClearChunks(doc.id, doc.displayName)}
                          disabled={status === 'loading'}
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
                            <Button size="sm" variant="outline" onClick={() => handleRestore(doc.id)}>
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
    </>
  );
}
