'use client';

// ============================================================================
// PDF Ingestion Tab Component
// ============================================================================

import { useState } from 'react';
import { clearChunks, getIngestionStatus, testRAGQuery } from '@/actions/ingest-pdf';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { 
  FileText, 
  Upload, 
  Trash2, 
  CheckCircle, 
  XCircle, 
  Loader2,
  Database,
  RefreshCw,
  AlertTriangle,
  Zap,
} from 'lucide-react';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

type IngestionStatus = 'idle' | 'loading' | 'success' | 'error';

interface StatusInfo {
  ingestion: IngestionStatus;
  clearing: IngestionStatus;
  message: string;
  chunksProcessed: number;
}

interface ProgressInfo {
  stage: string;
  progress: number;
  total: number;
  message: string;
  chunksProcessed?: number;
}

interface DiagnosticInfo {
  dbConnected: boolean;
  chunkCount: number;
  rpcWorking: boolean;
  loading: boolean;
  error?: string;
}

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

export function PdfIngestionTab() {
  const [status, setStatus] = useState<StatusInfo>({
    ingestion: 'idle',
    clearing: 'idle',
    message: '',
    chunksProcessed: 0,
  });
  
  const [diagnostic, setDiagnostic] = useState<DiagnosticInfo>({
    dbConnected: false,
    chunkCount: 0,
    rpcWorking: false,
    loading: true,
  });

  const [progress, setProgress] = useState<ProgressInfo | null>(null);

  // Run diagnostics
  const runDiagnostics = async () => {
    setDiagnostic(prev => ({ ...prev, loading: true }));
    
    try {
      const dbStatus = await getIngestionStatus();
      const rpcStatus = await testRAGQuery();
      
      setDiagnostic({
        dbConnected: dbStatus.dbConnected,
        chunkCount: dbStatus.chunkCount,
        rpcWorking: rpcStatus.success,
        loading: false,
        error: dbStatus.error || rpcStatus.error,
      });
    } catch (error) {
      setDiagnostic({
        dbConnected: false,
        chunkCount: 0,
        rpcWorking: false,
        loading: false,
        error: error instanceof Error ? error.message : 'Diagnostic failed',
      });
    }
  };

  const handleIngestPDF = async () => {
    setStatus(prev => ({ ...prev, ingestion: 'loading', message: 'Starting PDF ingestion...' }));
    setProgress({ stage: 'starting', progress: 0, total: 100, message: 'Connecting...' });
    
    try {
      const response = await fetch('/api/ingest', {
        method: 'POST',
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
              
              setProgress({
                stage: data.stage,
                progress: data.progress,
                total: data.total,
                message: data.message,
                chunksProcessed: data.chunksProcessed,
              });

              if (data.done) {
                if (data.error) {
                  setStatus({
                    ingestion: 'error',
                    clearing: 'idle',
                    message: data.error,
                    chunksProcessed: data.chunksProcessed || 0,
                  });
                } else {
                  setStatus({
                    ingestion: 'success',
                    clearing: 'idle',
                    message: data.message,
                    chunksProcessed: data.chunksProcessed || 0,
                  });
                }
                setProgress(null);
              }
            } catch {
              // Ignore parse errors for incomplete chunks
            }
          }
        }
      }
    } catch (error) {
      setStatus({
        ingestion: 'error',
        clearing: 'idle',
        message: error instanceof Error ? error.message : 'Failed to ingest PDF',
        chunksProcessed: 0,
      });
      setProgress(null);
    }
  };

  const handleClearDatabase = async () => {
    if (!confirm('Are you sure you want to clear all chunks from the database? This action cannot be undone.')) {
      return;
    }

    setStatus(prev => ({ ...prev, clearing: 'loading', message: 'Clearing database...' }));
    
    try {
      const result = await clearChunks();
      
      if (result.success) {
        setStatus({
          ingestion: 'idle',
          clearing: 'success',
          message: 'Database cleared successfully',
          chunksProcessed: 0,
        });
      } else {
        setStatus(prev => ({
          ...prev,
          clearing: 'error',
          message: result.error || 'Failed to clear database',
        }));
      }
    } catch (error) {
      setStatus(prev => ({
        ...prev,
        clearing: 'error',
        message: error instanceof Error ? error.message : 'Failed to clear database',
      }));
    }
  };

  // Initial load
  useState(() => {
    runDiagnostics();
  });

  return (
    <>
      <div className="mb-6">
        <h2 className="text-2xl font-bold">PDF Ingestion Pipeline</h2>
        <p className="text-muted-foreground">Manage Dubai Building Code document ingestion for RAG queries</p>
      </div>

      <div className="grid gap-6 max-w-2xl">
        {/* System Diagnostics Card */}
        <Card className={diagnostic.error ? 'border-yellow-500/50' : 'border-green-500/50'}>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Zap className="h-5 w-5 text-yellow-500" />
                System Diagnostics
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={runDiagnostics}
                disabled={diagnostic.loading}
              >
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
                    <Badge className="bg-green-500/20 text-green-400 border-green-500/30">
                      <CheckCircle className="h-3 w-3 mr-1" /> Connected
                    </Badge>
                  ) : (
                    <Badge className="bg-red-500/20 text-red-400 border-red-500/30">
                      <XCircle className="h-3 w-3 mr-1" /> Failed
                    </Badge>
                  )}
                </div>
                
                <div className="flex items-center justify-between">
                  <span className="text-sm">Chunks in Database</span>
                  <Badge variant={diagnostic.chunkCount > 0 ? 'default' : 'secondary'}>
                    {diagnostic.chunkCount} chunks
                  </Badge>
                </div>
                
                <div className="flex items-center justify-between">
                  <span className="text-sm">match_dubai_code RPC</span>
                  {diagnostic.rpcWorking ? (
                    <Badge className="bg-green-500/20 text-green-400 border-green-500/30">
                      <CheckCircle className="h-3 w-3 mr-1" /> Working
                    </Badge>
                  ) : (
                    <Badge className="bg-red-500/20 text-red-400 border-red-500/30">
                      <XCircle className="h-3 w-3 mr-1" /> Not Found
                    </Badge>
                  )}
                </div>
                
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

        {/* Ingestion Card */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5 text-primary" />
              Ingest Dubai Building Code
            </CardTitle>
            <CardDescription>
              Read the PDF file, split into chunks, generate embeddings, and store in Supabase.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Database className="h-4 w-4" />
              <span>Chunk size: 800 chars | Overlap: 150 chars</span>
            </div>
            
            {/* Progress Bar */}
            {progress && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">{progress.message}</span>
                  <span className="font-medium">{progress.progress}%</span>
                </div>
                <div className="h-3 w-full bg-muted rounded-full overflow-hidden">
                  <div 
                    className="h-full bg-primary transition-all duration-300 ease-out"
                    style={{ width: `${progress.progress}%` }}
                  />
                </div>
                {progress.chunksProcessed !== undefined && progress.chunksProcessed > 0 && (
                  <p className="text-xs text-muted-foreground text-center">
                    {progress.chunksProcessed} chunks processed
                  </p>
                )}
              </div>
            )}
            
            <Button 
              onClick={async () => {
                await handleIngestPDF();
                runDiagnostics();
              }}
              disabled={status.ingestion === 'loading' || !diagnostic.dbConnected}
              className="w-full"
              size="lg"
            >
              {status.ingestion === 'loading' ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {progress ? `${progress.progress}% - ${progress.stage}` : 'Processing...'}
                </>
              ) : (
                <>
                  <Upload className="mr-2 h-4 w-4" />
                  Ingest PDF
                </>
              )}
            </Button>
          </CardContent>
        </Card>

        {/* Clear Database Card */}
        <Card className="border-destructive/50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-destructive">
              <Trash2 className="h-5 w-5" />
              Clear Database
            </CardTitle>
            <CardDescription>
              Remove all chunks from the database. Use this before re-ingesting the PDF.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button 
              onClick={async () => {
                await handleClearDatabase();
                runDiagnostics();
              }}
              disabled={status.clearing === 'loading'}
              variant="destructive"
              className="w-full"
            >
              {status.clearing === 'loading' ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Clearing...
                </>
              ) : (
                <>
                  <Trash2 className="mr-2 h-4 w-4" />
                  Clear All Chunks
                </>
              )}
            </Button>
          </CardContent>
        </Card>

        {/* Status Card */}
        {status.message && (
          <Card className={
            status.ingestion === 'success' || status.clearing === 'success' 
              ? 'border-green-500/50 bg-green-500/5' 
              : status.ingestion === 'error' || status.clearing === 'error'
              ? 'border-destructive/50 bg-destructive/5'
              : 'border-primary/50 bg-primary/5'
          }>
            <CardContent className="pt-6">
              <div className="flex items-start gap-3">
                {(status.ingestion === 'success' || status.clearing === 'success') && (
                  <CheckCircle className="h-5 w-5 text-green-500 mt-0.5" />
                )}
                {(status.ingestion === 'error' || status.clearing === 'error') && (
                  <XCircle className="h-5 w-5 text-destructive mt-0.5" />
                )}
                {(status.ingestion === 'loading' || status.clearing === 'loading') && (
                  <Loader2 className="h-5 w-5 text-primary animate-spin mt-0.5" />
                )}
                <div>
                  <p className="font-medium">{status.message}</p>
                  {status.chunksProcessed > 0 && (
                    <p className="text-sm text-muted-foreground mt-1">
                      Processed {status.chunksProcessed} chunks with embeddings
                    </p>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}
