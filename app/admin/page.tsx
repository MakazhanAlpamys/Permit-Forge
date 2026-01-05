'use client';

// ============================================================================
// Admin Page - PDF Ingestion Dashboard with Diagnostics
// ============================================================================

import { useState, useEffect } from 'react';
import { ingestPDF, clearChunks, getIngestionStatus, testRAGQuery } from '@/actions/ingest-pdf';
import { logoutAction } from '@/actions/auth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ThemeToggle } from '@/components/theme-toggle';
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
  LogOut
} from 'lucide-react';

type IngestionStatus = 'idle' | 'loading' | 'success' | 'error';

interface StatusInfo {
  ingestion: IngestionStatus;
  clearing: IngestionStatus;
  message: string;
  chunksProcessed: number;
}

interface DiagnosticInfo {
  dbConnected: boolean;
  chunkCount: number;
  rpcWorking: boolean;
  loading: boolean;
  error?: string;
}

export default function AdminPage() {
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

  // Run diagnostics on mount
  useEffect(() => {
    runDiagnostics();
  }, []);

  const runDiagnostics = async () => {
    setDiagnostic(prev => ({ ...prev, loading: true }));
    
    try {
      // Check database connection and chunk count
      const dbStatus = await getIngestionStatus();
      
      // Test RPC function
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
    
    try {
      const result = await ingestPDF();
      
      if (result.success) {
        setStatus({
          ingestion: 'success',
          clearing: 'idle',
          message: `Successfully ingested ${result.chunksProcessed} chunks from Dubai Building Code`,
          chunksProcessed: result.chunksProcessed,
        });
      } else {
        setStatus({
          ingestion: 'error',
          clearing: 'idle',
          message: result.error || 'Unknown error occurred',
          chunksProcessed: 0,
        });
      }
    } catch (error) {
      setStatus({
        ingestion: 'error',
        clearing: 'idle',
        message: error instanceof Error ? error.message : 'Failed to ingest PDF',
        chunksProcessed: 0,
      });
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

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <Badge variant="outline" className="text-orange-500 border-orange-500">
              Admin Panel
            </Badge>
            <div className="flex items-center gap-2">
              <ThemeToggle variant="text" />
              <form action={logoutAction}>
                <Button variant="ghost" size="sm" type="submit">
                  <LogOut className="h-4 w-4 mr-2" />
                  Logout
                </Button>
              </form>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-4 py-8">
        <div className="max-w-2xl mx-auto space-y-6">
          {/* Title */}
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold text-foreground mb-2">
              PDF Ingestion Pipeline
            </h1>
            <p className="text-muted-foreground">
              Manage Dubai Building Code document ingestion for RAG queries
            </p>
          </div>

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
                  {/* Database Connection */}
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
                  
                  {/* Chunks Count */}
                  <div className="flex items-center justify-between">
                    <span className="text-sm">Chunks in Database</span>
                    <Badge variant={diagnostic.chunkCount > 0 ? 'default' : 'secondary'}>
                      {diagnostic.chunkCount} chunks
                    </Badge>
                  </div>
                  
                  {/* RPC Function */}
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
                  
                  {/* Error Message */}
                  {diagnostic.error && (
                    <div className="mt-3 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/30">
                      <div className="flex items-start gap-2">
                        <AlertTriangle className="h-4 w-4 text-yellow-500 mt-0.5" />
                        <div>
                          <p className="text-sm font-medium text-yellow-500">Action Required</p>
                          <p className="text-xs text-muted-foreground mt-1">{diagnostic.error}</p>
                          <p className="text-xs text-muted-foreground mt-2">
                            Run the SQL migration from <code className="bg-muted px-1 py-0.5 rounded">supabase/migrations/001_setup_rag.sql</code> in your Supabase SQL Editor.
                          </p>
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
                Make sure the file is placed at <code className="bg-muted px-1 py-0.5 rounded text-xs">public/dubai-code.pdf</code>
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Database className="h-4 w-4" />
                <span>Chunk size: 1000 chars | Overlap: 200 chars | Model: text-embedding-004</span>
              </div>
              
              <Button 
                onClick={async () => {
                  await handleIngestPDF();
                  runDiagnostics(); // Refresh diagnostics after ingestion
                }}
                disabled={status.ingestion === 'loading' || !diagnostic.dbConnected}
                className="w-full"
                size="lg"
              >
                {status.ingestion === 'loading' ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Processing...
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
                  runDiagnostics(); // Refresh diagnostics after clearing
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
                        Processed {status.chunksProcessed} chunks with 768-dimensional embeddings
                      </p>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Info Card */}
          <Card className="bg-muted/50">
            <CardContent className="pt-6">
              <h3 className="font-semibold mb-2">Ingestion Process</h3>
              <ol className="list-decimal list-inside space-y-1 text-sm text-muted-foreground">
                <li>Read PDF from <code className="bg-background px-1 py-0.5 rounded">public/dubai-code.pdf</code></li>
                <li>Split text using RecursiveCharacterTextSplitter (LangChain)</li>
                <li>Extract metadata (page numbers, sections)</li>
                <li>Generate embeddings with Gemini text-embedding-004</li>
                <li>Upsert chunks to Supabase dubai_code_chunks table</li>
              </ol>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
