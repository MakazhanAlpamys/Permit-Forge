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
import { LanguageToggle } from '@/components/language-toggle';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
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
      setProfileError(t('errors.tryAgain'));
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
    { id: 'overview' as Tab, label: t('admin.tabs.overview'), icon: LayoutDashboard },
    { id: 'users' as Tab, label: t('admin.tabs.users'), icon: Users },
    { id: 'permits' as Tab, label: t('admin.tabs.permits'), icon: ClipboardCheck },
    { id: 'documents' as Tab, label: t('admin.tabs.documents'), icon: BookOpen },
    { id: 'logs' as Tab, label: t('admin.tabs.audit'), icon: History },
  ];

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card sticky top-0 z-40">
        <div className="container mx-auto px-4 py-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-3 min-w-0">
              <Image
                src={theme === 'dark' ? '/white-icon.svg' : '/black-icon.svg'}
                alt="PermitForge"
                width={48}
                height={48}
                className="h-10 w-auto"
              />
              <Badge variant="outline" className="text-orange-600 dark:text-orange-400 border-orange-500">
                {t('admin.title')}
              </Badge>
            </div>
            <div className="flex items-center gap-1 sm:gap-2 flex-wrap justify-end">
              <Button
                variant="ghost"
                size="sm"
                aria-label={t('common.refresh')}
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
              <LanguageToggle variant="text" />
              <ThemeToggle variant="text" />
              <Button
                variant="ghost"
                size="sm"
                aria-label={t('dashboard.header.profile')}
                onClick={() => { setProfileOpen(true); setProfileError(''); setProfileSuccess(false); }}
              >
                <UserCircle className="h-4 w-4 sm:mr-2" />
                <span className="hidden sm:inline">{t('dashboard.header.profile')}</span>
              </Button>
              <form action={logoutAction}>
                <input type="hidden" name="csrfToken" value={csrfToken} />
                <Button variant="ghost" size="sm" type="submit" aria-label={t('common.signOut')}>
                  <LogOut className="h-4 w-4 sm:mr-2" />
                  <span className="hidden sm:inline">{t('common.signOut')}</span>
                </Button>
              </form>
            </div>
          </div>
        </div>
      </header>

      <div className="flex">
        {/* Sidebar Navigation */}
        <aside className="w-64 border-r border-border bg-card/50 min-h-[calc(100vh-57px)] hidden md:block">
          <nav role="tablist" aria-label="Admin sections" aria-orientation="vertical" className="p-4 space-y-2">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                role="tab"
                aria-selected={activeTab === tab.id}
                aria-controls={`admin-panel-${tab.id}`}
                id={`admin-tab-${tab.id}`}
                tabIndex={activeTab === tab.id ? 0 : -1}
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
          <div role="tablist" aria-label="Admin sections" className="flex justify-around">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                role="tab"
                aria-selected={activeTab === tab.id}
                aria-controls={`admin-panel-${tab.id}`}
                id={`admin-mtab-${tab.id}`}
                tabIndex={activeTab === tab.id ? 0 : -1}
                onClick={() => setActiveTab(tab.id)}
                className={`flex-1 min-w-0 flex flex-col items-center gap-1 px-2 sm:px-4 py-2 rounded-lg ${
                  activeTab === tab.id
                    ? 'text-primary'
                    : 'text-muted-foreground'
                }`}
              >
                <tab.icon className="h-5 w-5 shrink-0" />
                <span className="text-[10px] sm:text-xs truncate max-w-full">{tab.label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Main Content */}
        <main className="flex-1 p-4 sm:p-6 pb-24 md:pb-6">
          <div className="max-w-7xl mx-auto space-y-6">
            
            {/* Overview Tab */}
            {activeTab === 'overview' && (
              <section role="tabpanel" id="admin-panel-overview" aria-labelledby="admin-tab-overview">
                <div className="mb-6">
                  <h2 className="text-2xl font-bold">{t('admin.tabs.overview')}</h2>
                  <p className="text-muted-foreground">{t('admin.overview.messageActivity')}</p>
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
              </section>
            )}

            {/* Users Tab */}
            {activeTab === 'users' && (
              <section role="tabpanel" id="admin-panel-users" aria-labelledby="admin-tab-users">
                <div className="mb-6">
                  <h2 className="text-2xl font-bold">{t('admin.users.title')}</h2>
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
              </section>
            )}

            {/* Permits Tab */}
            {activeTab === 'permits' && (
              <section role="tabpanel" id="admin-panel-permits" aria-labelledby="admin-tab-permits">
                <div className="mb-6">
                  <h2 className="text-2xl font-bold">{t('admin.permits.title')}</h2>
                </div>

                <PermitManagement
                  permits={permits}
                  stats={permitStats}
                  loading={permitsLoading}
                  onRefresh={() => loadPermits()}
                  onFilterStatus={(status) => loadPermits(status)}
                />
              </section>
            )}

            {/* Documents Tab */}
            {activeTab === 'documents' && (
              <section role="tabpanel" id="admin-panel-documents" aria-labelledby="admin-tab-documents">
                <DocumentManagement />
              </section>
            )}

            {/* Audit Logs Tab */}
            {activeTab === 'logs' && (
              <section role="tabpanel" id="admin-panel-logs" aria-labelledby="admin-tab-logs">
                <div className="mb-6">
                  <h2 className="text-2xl font-bold">{t('admin.audit.title')}</h2>
                </div>

                <AuditLogs logs={auditLogs} loading={dataLoading} />
              </section>
            )}
          </div>
        </main>
      </div>

      {/* Admin Profile Dialog */}
      {profileOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="admin-profile-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4"
          onClick={(e) => { if (e.target === e.currentTarget) closeProfileDialog(); }}
        >
          <div className="bg-card border border-border rounded-lg p-6 max-w-sm w-full max-h-[90vh] overflow-y-auto shadow-lg">
            <div className="flex items-center justify-between mb-4">
              <h3 id="admin-profile-title" className="text-lg font-semibold">{t('profile.title')}</h3>
              <button
                onClick={closeProfileDialog}
                aria-label={t('common.close')}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {profileSuccess ? (
              <div className="flex flex-col items-center gap-3 py-6">
                <CheckCircle2 className="h-12 w-12 text-green-500" />
                <p className="text-sm text-muted-foreground">{t('profile.passwordChanged')}</p>
              </div>
            ) : (
              <form onSubmit={handleAdminPasswordChange} className="space-y-4">
                <p className="text-sm text-muted-foreground">{t('profile.changePassword')}</p>

                <div className="space-y-2">
                  <label htmlFor="currentPw" className="text-sm font-medium">{t('profile.currentPassword')}</label>
                  <div className="relative">
                    <input
                      id="currentPw"
                      type={showCurrentPw ? 'text' : 'password'}
                      value={currentPassword}
                      onChange={(e) => setCurrentPassword(e.target.value)}
                      required
                      disabled={profileLoading}
                      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 pr-10 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
                      placeholder={t('profile.currentPassword')}
                    />
                    <button type="button" onClick={() => setShowCurrentPw(!showCurrentPw)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" tabIndex={-1}>
                      {showCurrentPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>

                <div className="space-y-2">
                  <label htmlFor="newPw" className="text-sm font-medium">{t('profile.newPassword')}</label>
                  <div className="relative">
                    <input
                      id="newPw"
                      type={showNewPw ? 'text' : 'password'}
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      required
                      disabled={profileLoading}
                      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 pr-10 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
                      placeholder={t('auth.register.passwordPlaceholder')}
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
                  <Button variant="outline" type="button" onClick={closeProfileDialog}>{t('common.cancel')}</Button>
                  <Button type="submit" disabled={profileLoading}>
                    {profileLoading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                    {t('profile.changePassword')}
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
