'use client';

// ============================================================================
// Admin Dashboard - Complete Admin Panel
// ============================================================================

import { useState, useEffect, useCallback } from 'react';
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
import { Badge } from '@/components/ui/badge';
import { ThemeToggle } from '@/components/theme-toggle';
import { 
  StatsCards, 
  ActivityChart, 
  UserManagement, 
  AuditLogs, 
  CreateUserDialog,
  PdfIngestionTab,
} from '@/components/admin';
import { 
  FileText, 
  RefreshCw,
  LogOut,
  LayoutDashboard,
  Users,
  History
} from 'lucide-react';

type Tab = 'overview' | 'users' | 'pdf' | 'logs';

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

  // Initial load
  useEffect(() => {
    loadDashboardData();
  }, [loadDashboardData]);

  // Load users when tab changes
  useEffect(() => {
    if (activeTab === 'users') {
      loadUsers();
    }
  }, [activeTab, loadUsers]);

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
            {activeTab === 'pdf' && <PdfIngestionTab />}

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
