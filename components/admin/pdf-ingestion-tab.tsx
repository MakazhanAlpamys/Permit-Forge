'use client';

// ============================================================================
// PDF Ingestion Tab Component — Multi-Document Support
// ============================================================================

import { useState, useEffect, useRef } from 'react';
import { clearDocumentChunks, getIngestionStatus, testRAGQuery } from '@/actions/ingest-pdf';
import { getCSRFTokenAction } from '@/actions/auth';
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
} from 'lucide-react';

import { getAllRegisteredDocuments, type DocumentRecord } from '@/actions/documents';

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

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

export function PdfIngestionTab() {
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [ingestionStatus, setIngestionStatus] = useState<Record<string, IngestionStatus>>({});
  const [ingestionMessages, setIngestionMessages] = useState<Record<string, string>>({});
  const [activeProgress, setActiveProgress] = useState<Record<string, ProgressInfo>>({});
  const csrfTokenRef = useRef<string | null>(null);

  const [diagnostic, setDiagnostic] = useState<DiagnosticInfo>({
    dbConnected: false,
    totalChunkCount: 0,
    documentStats: [],
    rpcWorking: false,
    loading: true,
  });

  // Run diagnostics
  const runDiagnostics = async () => {
    setDiagnostic(prev => ({ ...prev, loading: true }));

    try {
      const dbStatus = await getIngestionStatus();
      const rpcStatus = await testRAGQuery();

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
  };

  const handleIngestDocument = async (documentId: string, pdfPath: string) => {
    setIngestionStatus(prev => ({ ...prev, [documentId]: 'loading' }));
    setIngestionMessages(prev => ({ ...prev, [documentId]: 'Starting ingestion...' }));
    setActiveProgress(prev => ({ ...prev, [documentId]: { stage: 'starting', progress: 0, total: 100, message: 'Connecting...' } }));

    try {
      const response = await fetch('/api/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId, pdfPath }),
      });

      if (!response.ok) {
        throw new Error('Failed to start ingestion');
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) {
        throw new Error('No response stream');
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value);
        const lines = text.split('\n');

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
              // Ignore parse errors
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
  };

  const handleClearDocument = async (documentId: string) => {
    const doc = documents.find(d => d.id === documentId);
    if (!confirm(`Clear all chunks for "${doc?.displayName || documentId}"? This cannot be undone.`)) return;

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

  useEffect(() => {
    getAllRegisteredDocuments().then(r => setDocuments(r.data.filter(d => d.isActive)));
    runDiagnostics();
    getCSRFTokenAction().then(token => { csrfTokenRef.current = token; });
  }, []);

  const getDocChunkCount = (docId: string) => {
    const stat = diagnostic.documentStats.find(s => s.document_name === docId);
    return stat?.chunk_count || 0;
  };

  return (
    <>
      <div className="mb-6">
        <h2 className="text-2xl font-bold">Multi-Document Ingestion Pipeline</h2>
        <p className="text-muted-foreground">Manage document ingestion for RAG queries across multiple building codes</p>
      </div>

      <div className="grid gap-6 max-w-3xl">
        {/* System Diagnostics Card */}
        <Card className={diagnostic.error ? 'border-yellow-500/50' : 'border-violet-500/50'}>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Zap className="h-5 w-5 text-yellow-500" />
                System Diagnostics
              </div>
              <Button variant="ghost" size="sm" onClick={runDiagnostics} disabled={diagnostic.loading}>
                <RefreshCw className={`h-4 w-4 ${diagnostic.loading ? 'animate-spin' : ''}`} />
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {diagnostic.loading ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Running diagnostics...
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm">Database Connection</span>
                  {diagnostic.dbConnected ? (
                    <Badge className="bg-violet-500/20 text-violet-400 border-violet-500/30">
                      <CheckCircle className="h-3 w-3 mr-1" /> Connected
                    </Badge>
                  ) : (
                    <Badge className="bg-red-500/20 text-red-400 border-red-500/30">
                      <XCircle className="h-3 w-3 mr-1" /> Failed
                    </Badge>
                  )}
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-sm">Total Chunks</span>
                  <Badge variant={diagnostic.totalChunkCount > 0 ? 'default' : 'secondary'}>
                    {diagnostic.totalChunkCount} chunks
                  </Badge>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-sm">Hybrid Search RPC</span>
                  {diagnostic.rpcWorking ? (
                    <Badge className="bg-violet-500/20 text-violet-400 border-violet-500/30">
                      <CheckCircle className="h-3 w-3 mr-1" /> Working
                    </Badge>
                  ) : (
                    <Badge className="bg-red-500/20 text-red-400 border-red-500/30">
                      <XCircle className="h-3 w-3 mr-1" /> Not Found
                    </Badge>
                  )}
                </div>

                {/* Per-document stats */}
                {diagnostic.documentStats.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-border space-y-2">
                    <span className="text-xs font-medium text-muted-foreground uppercase">Documents Ingested</span>
                    {diagnostic.documentStats.map(stat => {
                      const doc = documents.find(d => d.id === stat.document_name);
                      return (
                        <div key={stat.document_name} className="flex items-center justify-between text-sm">
                          <div className="flex items-center gap-2">
                            <Badge variant="outline" className={`text-[10px] px-1.5 py-0 h-4 ${doc?.badgeColor || ''}`}>
                              {doc?.shortName || stat.document_name}
                            </Badge>
                            <span className="text-muted-foreground truncate max-w-[200px]">{doc?.displayName || stat.document_name}</span>
                          </div>
                          <span className="text-xs">{stat.chunk_count} chunks (pp. {stat.min_page}-{stat.max_page})</span>
                        </div>
                      );
                    })}
                  </div>
                )}

                {diagnostic.error && (
                  <div className="mt-3 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/30">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="h-4 w-4 text-yellow-500 mt-0.5" />
                      <div>
                        <p className="text-sm font-medium text-yellow-500">Action Required</p>
                        <p className="text-xs text-muted-foreground mt-1">{diagnostic.error}</p>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Document Ingestion Cards */}
        {documents.map(doc => {
          const chunkCount = getDocChunkCount(doc.id);
          const status = ingestionStatus[doc.id] || 'idle';
          const message = ingestionMessages[doc.id] || '';
          const progress = activeProgress[doc.id];
          const isIngested = chunkCount > 0;

          return (
            <Card key={doc.id} className={isIngested ? 'border-violet-500/30' : ''}>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <BookOpen className="h-4 w-4 text-primary" />
                  <span className="flex-1">{doc.displayName}</span>
                  <Badge variant="outline" className={`text-[10px] px-1.5 py-0 h-5 ${doc.badgeColor}`}>
                    {doc.shortName}
                  </Badge>
                  {isIngested && (
                    <Badge className="bg-violet-500/20 text-violet-400 border-violet-500/30 text-[10px]">
                      {chunkCount} chunks
                    </Badge>
                  )}
                </CardTitle>
                <CardDescription className="text-xs">
                  <Database className="h-3 w-3 inline mr-1" />
                  {doc.fileName}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {/* Progress Bar */}
                {progress && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground text-xs">{progress.message}</span>
                      <span className="font-medium text-xs">{progress.progress}%</span>
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
                  <div className={`text-xs p-2 rounded ${status === 'success' ? 'bg-violet-500/10 text-violet-400' : status === 'error' ? 'bg-red-500/10 text-red-400' : 'text-muted-foreground'}`}>
                    {status === 'success' && <CheckCircle className="h-3 w-3 inline mr-1" />}
                    {status === 'error' && <XCircle className="h-3 w-3 inline mr-1" />}
                    {message}
                  </div>
                )}

                {/* Action buttons */}
                <div className="flex gap-2">
                  <Button
                    onClick={async () => {
                      await handleIngestDocument(doc.id, `public/${doc.fileName}`);
                      runDiagnostics();
                    }}
                    disabled={status === 'loading' || !diagnostic.dbConnected}
                    size="sm"
                    className="flex-1"
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
                      onClick={() => handleClearDocument(doc.id)}
                      disabled={status === 'loading'}
                      variant="destructive"
                      size="sm"
                    >
                      <Trash2 className="mr-1.5 h-3 w-3" />
                      Clear
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </>
  );
}
