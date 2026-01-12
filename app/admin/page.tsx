'use client';

// ============================================================================
// Admin Dashboard - Complete Admin Panel
// ============================================================================

import { useState, useEffect, useCallback } from 'react';
import { ingestPDF, clearChunks, getIngestionStatus, testRAGQuery } from '@/actions/ingest-pdf';
import { 
  getDashboardStats, 
  getWeeklyActivity, 
  getAuditLogs, 
  getAllUsers,
  type DashboardStats,
  type WeeklyActivity,
  type AuditLogEntry,
  type AdminUser
} from '@/actions/admin';
import { logoutAction } from '@/actions/auth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ThemeToggle } from '@/components/theme-toggle';
import { 
  StatsCards, 
  ActivityChart, 
  UserManagement, 
  AuditLogs, 
  CreateUserDialog 
} from '@/components/admin';
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
  LogOut,
  LayoutDashboard,
  Users,
  History
} from 'lucide-react';

type Tab = 'overview' | 'users' | 'pdf' | 'logs';
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
  // Tab state
  const [activeTab, setActiveTab] = useState<Tab>('overview');
  
  // Dashboard data
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [weeklyActivity, setWeeklyActivity] = useState<WeeklyActivity[]>([]);
  const [auditLogs, setAuditLogsData] = useState<AuditLogEntry[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [dataLoading, setDataLoading] = useState(true);
  
  // User dialog
  const [createUserOpen, setCreateUserOpen] = useState(false);
  
  // PDF Ingestion state
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

  // Load dashboard data
  const loadDashboardData = useCallback(async () => {
    setDataLoading(true);
    
    const [statsResult, activityResult, logsResult] = await Promise.all([
      getDashboardStats(),
      getWeeklyActivity(),
      getAuditLogs(50),
    ]);
    
    if (statsResult.data) setStats(statsResult.data);
    setWeeklyActivity(activityResult.data);
    setAuditLogsData(logsResult.data);
    
    setDataLoading(false);
  }, []);

  // Load users
  const loadUsers = useCallback(async (search?: string) => {
    setDataLoading(true);
    const result = await getAllUsers(50, 0, search);
    setUsers(result.data);
    setDataLoading(false);
  }, []);

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

  // Initial load
  useEffect(() => {
    loadDashboardData();
    runDiagnostics();
  }, [loadDashboardData]);

  // Load users when tab changes
  useEffect(() => {
    if (activeTab === 'users') {
      loadUsers();
    }
  }, [activeTab, loadUsers]);

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

  const tabs = [
    { id: 'overview' as Tab, label: 'Overview', icon: LayoutDashboard },
    { id: 'users' as Tab, label: 'Users', icon: Users },
    { id: 'pdf' as Tab, label: 'PDF Ingestion', icon: FileText },
    { id: 'logs' as Tab, label: 'Audit Logs', icon: History },
  ];

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card sticky top-0 z-40">
        <div className="container mx-auto px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Badge variant="outline" className="text-orange-500 border-orange-500">
                Admin Panel
              </Badge>
              <h1 className="text-lg font-semibold hidden sm:block">Emirate Forge</h1>
            </div>
            <div className="flex items-center gap-2">
              <Button 
                variant="ghost" 
                size="sm" 
                onClick={() => loadDashboardData()}
                disabled={dataLoading}
              >
                <RefreshCw className={`h-4 w-4 ${dataLoading ? 'animate-spin' : ''}`} />
              </Button>
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

      <div className="flex">
        {/* Sidebar Navigation */}
        <aside className="w-64 border-r border-border bg-card/50 min-h-[calc(100vh-57px)] hidden md:block">
          <nav className="p-4 space-y-2">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-colors ${
                  activeTab === tab.id
                    ? 'bg-primary text-primary-foreground'
                    : 'hover:bg-muted text-muted-foreground hover:text-foreground'
                }`}
              >
                <tab.icon className="h-5 w-5" />
                {tab.label}
              </button>
            ))}
          </nav>
        </aside>

        {/* Mobile Tab Bar */}
        <div className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-card border-t border-border p-2">
          <div className="flex justify-around">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex flex-col items-center gap-1 px-4 py-2 rounded-lg ${
                  activeTab === tab.id
                    ? 'text-primary'
                    : 'text-muted-foreground'
                }`}
              >
                <tab.icon className="h-5 w-5" />
                <span className="text-xs">{tab.label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Main Content */}
        <main className="flex-1 p-6 pb-24 md:pb-6">
          <div className="max-w-7xl mx-auto space-y-6">
            
            {/* Overview Tab */}
            {activeTab === 'overview' && (
              <>
                <div className="mb-6">
                  <h2 className="text-2xl font-bold">Dashboard Overview</h2>
                  <p className="text-muted-foreground">Monitor system activity and performance</p>
                </div>
                
                <StatsCards stats={stats} loading={dataLoading} />
                
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-6">
                  <ActivityChart data={weeklyActivity} loading={dataLoading} />
                  <AuditLogs logs={auditLogs.slice(0, 10)} loading={dataLoading} />
                </div>
              </>
            )}

            {/* Users Tab */}
            {activeTab === 'users' && (
              <>
                <div className="mb-6">
                  <h2 className="text-2xl font-bold">User Management</h2>
                  <p className="text-muted-foreground">Manage user accounts and permissions</p>
                </div>
                
                <UserManagement
                  users={users}
                  loading={dataLoading}
                  onRefresh={() => loadUsers()}
                  onSearch={(query) => loadUsers(query)}
                  onCreateUser={() => setCreateUserOpen(true)}
                />
                
                <CreateUserDialog
                  isOpen={createUserOpen}
                  onClose={() => setCreateUserOpen(false)}
                  onSuccess={() => loadUsers()}
                />
              </>
            )}

            {/* PDF Ingestion Tab */}
            {activeTab === 'pdf' && (
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
            )}

            {/* Audit Logs Tab */}
            {activeTab === 'logs' && (
              <>
                <div className="mb-6">
                  <h2 className="text-2xl font-bold">Audit Logs</h2>
                  <p className="text-muted-foreground">View security events and admin actions</p>
                </div>
                
                <AuditLogs logs={auditLogs} loading={dataLoading} />
              </>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
