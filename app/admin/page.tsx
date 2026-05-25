'use client';

// ============================================================================
// Admin Dashboard - Complete Admin Panel
// ============================================================================

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  getAuditLogs,
  getAllUsers,
  type AuditLogEntry,
  type AdminUser
} from '@/actions/admin';
import {
  getAnalyticsDashboardStats,
  getMessageActivity30d,
  getDocumentUsageStats,
  getPermitStatusBreakdown,
  getTopActiveUsers,
  refreshAnalytics,
  type AnalyticsDashboardStats,
  type MessageActivityDay,
  type DocumentUsageStat,
  type PermitStatusBreakdown,
  type TopActiveUser,
} from '@/actions/analytics';
import { getAdminPermits, getPermitStats } from '@/actions/admin-permits';
import { logoutAction, getCSRFTokenAction } from '@/actions/auth';
import { adminChangePasswordAction } from '@/actions/profile';
import Image from 'next/image';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useTheme } from '@/components/theme-provider';
import { ThemeToggle } from '@/components/theme-toggle';
import {
  UserManagement,
  AuditLogs,
  CreateUserDialog,
  DocumentManagement,
  PermitManagement,
  EnhancedStatsCards,
  MessageActivityChart,
  DocumentUsageChart,
  PermitStatusChart,
  TopUsersTable,
} from '@/components/admin';
import {
  RefreshCw,
  LogOut,
  LayoutDashboard,
  Users,
  History,
  ClipboardCheck,
  BookOpen,
  UserCircle,
  Eye,
  EyeOff,
  Loader2,
  CheckCircle2,
  X,
} from 'lucide-react';
import type { PermitApplication, PermitStats } from '@/types';

type Tab = 'overview' | 'users' | 'permits' | 'documents' | 'logs';

export default function AdminPage() {
  const { theme } = useTheme();
  // Tab state
  const [activeTab, setActiveTab] = useState<Tab>('overview');
  
  // Dashboard data
  const [auditLogs, setAuditLogsData] = useState<AuditLogEntry[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [permits, setPermits] = useState<(PermitApplication & { username?: string })[]>([]);
  const [permitStats, setPermitStatsData] = useState<PermitStats | null>(null);
  const [dataLoading, setDataLoading] = useState(true);
  const [usersLoading, setUsersLoading] = useState(false);
  const [permitsLoading, setPermitsLoading] = useState(false);

  // Analytics data
  const [analyticsStats, setAnalyticsStats] = useState<AnalyticsDashboardStats | null>(null);
  const [messageActivity, setMessageActivity] = useState<MessageActivityDay[]>([]);
  const [documentUsage, setDocumentUsage] = useState<DocumentUsageStat[]>([]);
  const [permitBreakdown, setPermitBreakdown] = useState<PermitStatusBreakdown | null>(null);
  const [topUsers, setTopUsers] = useState<TopActiveUser[]>([]);

  // User dialog
  const [createUserOpen, setCreateUserOpen] = useState(false);

  // CSRF token (needed for logout form per C20H)
  const [csrfToken, setCsrfToken] = useState('');
  useEffect(() => {
    // TS-M-2 / v1.6.0 Part F: catch + log CSRF fetch failure.
    getCSRFTokenAction()
      .then((t) => setCsrfToken(t ?? ''))
      .catch(err => console.error('CSRF token fetch failed:', err));
  }, []);

  // Admin profile dialog
  const [profileOpen, setProfileOpen] = useState(false);
  // X12: stash the auto-close setTimeout id so manually closing the dialog
  // cancels it. Previously, closing the dialog by hand left the timer alive
  // and a stale `setProfileOpen(false)` fired ~1.5s later — no visible effect
  // when already closed, but a misleading state flap if the user reopened it.
  const profileCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const closeProfileDialog = useCallback(() => {
    if (profileCloseTimerRef.current) {
      clearTimeout(profileCloseTimerRef.current);
      profileCloseTimerRef.current = null;
    }
    setProfileOpen(false);
  }, []);

  // Cancel any pending auto-close on unmount.
  useEffect(() => {
    return () => {
      if (profileCloseTimerRef.current) clearTimeout(profileCloseTimerRef.current);
    };
  }, []);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [showCurrentPw, setShowCurrentPw] = useState(false);
  const [showNewPw, setShowNewPw] = useState(false);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState('');
  const [profileSuccess, setProfileSuccess] = useState(false);

  // Load dashboard data
  const loadDashboardData = useCallback(async () => {
    setDataLoading(true);

    const [
      logsResult,
      analyticsResult,
      msgActivityResult,
      docUsageResult,
      permitBreakdownResult,
      topUsersResult,
    ] = await Promise.all([
      getAuditLogs(50),
      getAnalyticsDashboardStats(),
      getMessageActivity30d(),
      getDocumentUsageStats(),
      getPermitStatusBreakdown(),
      getTopActiveUsers(),
    ]);

    setAuditLogsData(logsResult.data);
    if (analyticsResult.data) setAnalyticsStats(analyticsResult.data);
    setMessageActivity(msgActivityResult.data);
    setDocumentUsage(docUsageResult.data);
    if (permitBreakdownResult.data) setPermitBreakdown(permitBreakdownResult.data);
    setTopUsers(topUsersResult.data);

    setDataLoading(false);
  }, []);

  // Load users
  const loadUsers = useCallback(async (search?: string) => {
    setUsersLoading(true);
    const result = await getAllUsers(50, 0, search);
    setUsers(result.data);
    setUsersLoading(false);
  }, []);

  // Initial load
  useEffect(() => {
    loadDashboardData();
  }, [loadDashboardData]);

  // Load permits
  const loadPermits = useCallback(async (status?: string) => {
    setPermitsLoading(true);
    const [permitsResult, statsResult] = await Promise.all([
      getAdminPermits(status),
      getPermitStats(),
    ]);
    setPermits(permitsResult.data);
    if (statsResult.data) setPermitStatsData(statsResult.data);
    setPermitsLoading(false);
  }, []);

  // Load data when tab changes
  useEffect(() => {
    if (activeTab === 'users') {
      loadUsers();
    } else if (activeTab === 'permits') {
      loadPermits();
    }
  }, [activeTab, loadUsers, loadPermits]);

  const handleAdminPasswordChange = async (e: React.FormEvent) => {
    e.preventDefault();
    setProfileLoading(true);
    setProfileError('');
    setProfileSuccess(false);

    const csrfToken = await getCSRFTokenAction();
    if (!csrfToken) {
      setProfileError('Session expired. Please refresh.');
      setProfileLoading(false);
      return;
    }

    const result = await adminChangePasswordAction(currentPassword, newPassword, csrfToken);
    if (result.error) {
      setProfileError(result.error);
    } else {
      setProfileSuccess(true);
      setCurrentPassword('');
      setNewPassword('');
      // X12: store the timer id so we can cancel it if the user closes the
      // dialog manually before it fires.
      if (profileCloseTimerRef.current) clearTimeout(profileCloseTimerRef.current);
      profileCloseTimerRef.current = setTimeout(() => {
        setProfileOpen(false);
        setProfileSuccess(false);
        profileCloseTimerRef.current = null;
      }, 1500);
    }
    setProfileLoading(false);
  };

  const tabs = [
    { id: 'overview' as Tab, label: 'Overview', icon: LayoutDashboard },
    { id: 'users' as Tab, label: 'Users', icon: Users },
    { id: 'permits' as Tab, label: 'Permits', icon: ClipboardCheck },
    { id: 'documents' as Tab, label: 'Documents', icon: BookOpen },
    { id: 'logs' as Tab, label: 'Audit Logs', icon: History },
  ];

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card sticky top-0 z-40">
        <div className="container mx-auto px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Image
                src={theme === 'dark' ? '/white-icon.svg' : '/black-icon.svg'}
                alt="PermitForge"
                width={48}
                height={48}
                className="h-10 w-auto"
              />
              <Badge variant="outline" className="text-orange-500 border-orange-500">
                Admin Panel
              </Badge>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  // D2: refresh the analytics_daily MV before reloading so
                  // the dashboard reflects the latest pre-aggregated data.
                  // Failures are silent — loadDashboardData still runs.
                  await refreshAnalytics();
                  await loadDashboardData();
                }}
                disabled={dataLoading}
              >
                <RefreshCw className={`h-4 w-4 ${dataLoading ? 'animate-spin' : ''}`} />
              </Button>
              <ThemeToggle variant="text" />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { setProfileOpen(true); setProfileError(''); setProfileSuccess(false); }}
              >
                <UserCircle className="h-4 w-4 mr-2" />
                Profile
              </Button>
              <form action={logoutAction}>
                <input type="hidden" name="csrfToken" value={csrfToken} />
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

                {/* Enhanced Stats Cards with Trends */}
                <EnhancedStatsCards stats={analyticsStats} loading={dataLoading} />

                {/* 30-Day Message Activity Chart */}
                <div className="mt-6">
                  <MessageActivityChart data={messageActivity} loading={dataLoading} />
                </div>

                {/* Document Usage + Permit Status (2-col) */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-6">
                  <DocumentUsageChart
                    data={documentUsage}
                    loading={dataLoading}
                    displayNames={Object.fromEntries(
                      documentUsage.map(d => [d.documentName, d.displayName || d.documentName])
                    )}
                  />
                  <PermitStatusChart data={permitBreakdown} loading={dataLoading} />
                </div>

                {/* Top Users + Audit Logs (2-col) */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-6">
                  <TopUsersTable data={topUsers} loading={dataLoading} />
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
                  loading={usersLoading}
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

            {/* Permits Tab */}
            {activeTab === 'permits' && (
              <>
                <div className="mb-6">
                  <h2 className="text-2xl font-bold">Permit Applications</h2>
                  <p className="text-muted-foreground">Review and manage permit applications</p>
                </div>

                <PermitManagement
                  permits={permits}
                  stats={permitStats}
                  loading={permitsLoading}
                  onRefresh={() => loadPermits()}
                  onFilterStatus={(status) => loadPermits(status)}
                />
              </>
            )}

            {/* Documents Tab */}
            {activeTab === 'documents' && <DocumentManagement />}

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

      {/* Admin Profile Dialog */}
      {profileOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="bg-card border border-border rounded-lg p-6 max-w-sm w-full mx-4 shadow-lg">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">Admin Profile</h3>
              <button onClick={closeProfileDialog} className="text-muted-foreground hover:text-foreground">
                <X className="h-4 w-4" />
              </button>
            </div>

            {profileSuccess ? (
              <div className="flex flex-col items-center gap-3 py-6">
                <CheckCircle2 className="h-12 w-12 text-green-500" />
                <p className="text-sm text-muted-foreground">Password changed successfully!</p>
              </div>
            ) : (
              <form onSubmit={handleAdminPasswordChange} className="space-y-4">
                <p className="text-sm text-muted-foreground">Change your password</p>

                <div className="space-y-2">
                  <label htmlFor="currentPw" className="text-sm font-medium">Current Password</label>
                  <div className="relative">
                    <input
                      id="currentPw"
                      type={showCurrentPw ? 'text' : 'password'}
                      value={currentPassword}
                      onChange={(e) => setCurrentPassword(e.target.value)}
                      required
                      disabled={profileLoading}
                      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 pr-10 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
                      placeholder="Current password"
                    />
                    <button type="button" onClick={() => setShowCurrentPw(!showCurrentPw)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" tabIndex={-1}>
                      {showCurrentPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>

                <div className="space-y-2">
                  <label htmlFor="newPw" className="text-sm font-medium">New Password</label>
                  <div className="relative">
                    <input
                      id="newPw"
                      type={showNewPw ? 'text' : 'password'}
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      required
                      disabled={profileLoading}
                      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 pr-10 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
                      placeholder="Min 8 chars, uppercase, lowercase, digit, special"
                    />
                    <button type="button" onClick={() => setShowNewPw(!showNewPw)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" tabIndex={-1}>
                      {showNewPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>

                {profileError && (
                  <div className="p-3 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md">
                    {profileError}
                  </div>
                )}

                <div className="flex gap-3 justify-end">
                  <Button variant="outline" type="button" onClick={closeProfileDialog}>Cancel</Button>
                  <Button type="submit" disabled={profileLoading}>
                    {profileLoading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                    Change Password
                  </Button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
