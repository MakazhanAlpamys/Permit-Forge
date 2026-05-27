'use client';

// ============================================================================
// Admin Permit Management Component
// ============================================================================

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { PermitStatusBadge } from '@/components/permits/permit-status-badge';
import { PROJECT_TYPES, PERMIT_STATUS_FILTERS } from '@/lib/constants';
import { reviewPermit, setPermitUnderReview } from '@/actions/admin-permits';
import { useCsrfAction } from '@/hooks/use-csrf-action';
import { isOperationAllowed } from '@/lib/permit-state-machine';
import {
  ClipboardCheck,
  Eye,
  CheckCircle2,
  XCircle,
  RotateCcw,
  Loader2,
  Building2,
  MapPin,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import type { PermitApplication, PermitStats } from '@/types';

interface PermitManagementProps {
  permits: (PermitApplication & { username?: string })[];
  stats: PermitStats | null;
  loading: boolean;
  onRefresh: () => void;
  onFilterStatus: (status: string) => void;
}

export function PermitManagement({ permits, stats, loading, onRefresh, onFilterStatus }: PermitManagementProps) {
  const { t } = useTranslation();
  const filterLabel = (value: string, fallback: string): string => {
    const map: Record<string, string> = {
      all: 'permits.list.filterAll',
      draft: 'permits.list.filterDraft',
      submitted: 'permits.list.filterSubmitted',
      under_review: 'permits.list.filterUnderReview',
      approved: 'permits.list.filterApproved',
      rejected: 'permits.list.filterRejected',
      revision_requested: 'permits.list.filterRevisionRequested',
    };
    return t(map[value] ?? '', { defaultValue: fallback });
  };
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const initialFilter = searchParams?.get('status') || 'all';

  const [activeFilter, setActiveFilter] = useState(initialFilter);
  const [expandedPermit, setExpandedPermit] = useState<string | null>(null);
  const [reviewDialog, setReviewDialog] = useState<{ permit: PermitApplication; action: 'approve' | 'reject' | 'request_revision' } | null>(null);
  const [reviewComments, setReviewComments] = useState('');
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState('');
  // B8: notification dispatch can fail without invalidating the status change.
  // Show the warning inline next to the error banner; auto-clears after 6s.
  const [warning, setWarning] = useState('');

  // B12: useCsrfAction handles initial fetch + refetch-and-retry-once when
  // the action layer rejects a stale token.
  const { runWithCsrf } = useCsrfAction();

  // Track the warning-clear timer so an unmount cancels it instead of firing
  // setWarning() on a dead component (mirrors the X12 pattern in app/admin/page.tsx).
  const warningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (warningTimerRef.current) clearTimeout(warningTimerRef.current);
    };
  }, []);

  // X2: notify the parent of the initial filter so the underlying permit
  // query starts in sync with the URL on first mount.
  useEffect(() => {
    if (initialFilter !== 'all') {
      onFilterStatus(initialFilter);
    }
    // Only on mount — subsequent changes go through handleFilter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFilter = (status: string) => {
    setActiveFilter(status);
    onFilterStatus(status);

    // X2: mirror to URL. Use replace + scroll:false to keep the scroll position
    // and avoid stacking history entries on quick filter taps.
    const params = new URLSearchParams(searchParams?.toString() || '');
    if (status === 'all') {
      params.delete('status');
    } else {
      params.set('status', status);
    }
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  const flashWarning = (msg: string) => {
    setWarning(msg);
    if (warningTimerRef.current) clearTimeout(warningTimerRef.current);
    warningTimerRef.current = setTimeout(() => {
      setWarning(prev => (prev === msg ? '' : prev));
      warningTimerRef.current = null;
    }, 6000);
  };

  const handleStartReview = async (permit: PermitApplication) => {
    if (permit.status !== 'submitted') return;
    setActionLoading(permit.id);
    const result = await runWithCsrf(token => setPermitUnderReview(permit.id, token));
    setActionLoading(null);
    if (result.success) {
      if (result.warning) flashWarning(result.warning);
      onRefresh();
    } else {
      setError(result.error || t('errors.generic'));
    }
  };

  const handleReviewConfirm = async () => {
    if (!reviewDialog) return;
    setActionLoading(reviewDialog.permit.id);
    setError('');

    const result = await runWithCsrf(token =>
      reviewPermit({
        permitId: reviewDialog.permit.id,
        action: reviewDialog.action,
        comments: reviewComments,
      }, token),
    );

    setActionLoading(null);

    if (result.success) {
      setReviewDialog(null);
      setReviewComments('');
      if (result.warning) flashWarning(result.warning);
      onRefresh();
    } else {
      setError(result.error || t('errors.generic'));
    }
  };

  return (
    <div className="space-y-6">
      {/* Stats row */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-8 gap-3">
          <StatMini label={t('admin.overview.totalPermits')} value={stats.totalPermits} />
          <StatMini label={t('permits.status.draft')} value={stats.draftCount} color="text-muted-foreground" />
          <StatMini label={t('permits.status.submitted')} value={stats.submittedCount} color="text-blue-600 dark:text-blue-400" />
          <StatMini label={t('permits.status.under_review')} value={stats.underReviewCount} color="text-yellow-600 dark:text-yellow-400" />
          <StatMini label={t('permits.status.approved')} value={stats.approvedCount} color="text-violet-600 dark:text-violet-400" />
          <StatMini label={t('permits.status.rejected')} value={stats.rejectedCount} color="text-red-600 dark:text-red-400" />
          <StatMini label={t('permits.status.revision_requested')} value={stats.revisionRequestedCount} color="text-orange-600 dark:text-orange-400" />
          <StatMini label={t('common.today')} value={stats.permitsToday} />
        </div>
      )}

      {/* Filter pills */}
      <div className="flex flex-wrap gap-2">
        {PERMIT_STATUS_FILTERS.map(sf => (
          <Button
            key={sf.value}
            variant={activeFilter === sf.value ? 'default' : 'outline'}
            size="sm"
            onClick={() => handleFilter(sf.value)}
            className="text-xs"
          >
            {filterLabel(sf.value, sf.label)}
          </Button>
        ))}
      </div>

      {error && (
        <div role="alert" className="p-3 rounded-md bg-red-500/10 border border-red-500/30 text-red-700 dark:text-red-300 text-sm">
          {error}
        </div>
      )}

      {warning && (
        <div role="status" className="p-3 rounded-md bg-yellow-500/10 border border-yellow-500/30 text-yellow-700 dark:text-yellow-300 text-sm">
          {warning}
        </div>
      )}

      {/* Permits table */}
      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-20 rounded-lg bg-muted animate-pulse" />
          ))}
        </div>
      ) : permits.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <ClipboardCheck className="h-12 w-12 mx-auto mb-3 opacity-30" />
          <p className="text-sm">{t('permits.list.empty')}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {permits.map(permit => {
            const isExpanded = expandedPermit === permit.id;
            const typeLabel = t(`permits.step1.type.${permit.projectType}`, {
              defaultValue: PROJECT_TYPES.find(x => x.value === permit.projectType)?.label || permit.projectType,
            });

            return (
              <Card key={permit.id} className="overflow-hidden">
                <div
                  role="button"
                  tabIndex={0}
                  aria-expanded={isExpanded}
                  aria-label={`${isExpanded ? 'Collapse' : 'Expand'} permit ${permit.projectName}`}
                  className="p-4 cursor-pointer hover:bg-muted/30 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  onClick={() => setExpandedPermit(isExpanded ? null : permit.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setExpandedPermit(isExpanded ? null : permit.id);
                    }
                  }}
                >
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-sm truncate">{permit.projectName}</span>
                        <PermitStatusBadge status={permit.status} />
                        {permit.username && (
                          <Badge variant="secondary" className="text-xs">
                            {permit.username}
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground flex-wrap">
                        <span className="flex items-center gap-1 min-w-0">
                          <Building2 className="h-3 w-3 shrink-0" />
                          <span className="truncate">{typeLabel}</span>
                        </span>
                        <span className="flex items-center gap-1 min-w-0">
                          <MapPin className="h-3 w-3 shrink-0" />
                          <span className="truncate">{permit.projectAddress}</span>
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap justify-end shrink-0">
                      {/* A-M-2 / v1.7.0 Part A: route show/hide decisions
                          through the central state machine so adding (or
                          renaming) a status only requires touching
                          permit-state-machine.ts. */}
                      {isOperationAllowed(permit.status, 'start_review') && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleStartReview(permit);
                          }}
                          disabled={actionLoading === permit.id}
                        >
                          {actionLoading === permit.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <>
                              <Eye className="h-3 w-3 mr-1" />
                              {t('admin.permits.startReview')}
                            </>
                          )}
                        </Button>
                      )}
                      {isOperationAllowed(permit.status, 'review') && (
                        <>
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-violet-600 dark:text-violet-400 border-violet-500/30 hover:bg-violet-500/10"
                            onClick={(e) => {
                              e.stopPropagation();
                              setReviewDialog({ permit, action: 'approve' });
                            }}
                          >
                            <CheckCircle2 className="h-3 w-3 mr-1" />
                            {t('admin.permits.approve')}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-orange-600 dark:text-orange-400 border-orange-500/30 hover:bg-orange-500/10"
                            onClick={(e) => {
                              e.stopPropagation();
                              setReviewDialog({ permit, action: 'request_revision' });
                            }}
                          >
                            <RotateCcw className="h-3 w-3 mr-1" />
                            {t('admin.permits.requestRevision')}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-red-600 dark:text-red-400 border-red-500/30 hover:bg-red-500/10"
                            onClick={(e) => {
                              e.stopPropagation();
                              setReviewDialog({ permit, action: 'reject' });
                            }}
                          >
                            <XCircle className="h-3 w-3 mr-1" />
                            {t('admin.permits.reject')}
                          </Button>
                        </>
                      )}
                      <span aria-hidden="true" className="shrink-0">
                        {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Expanded details */}
                {isExpanded && (
                  <CardContent className="border-t border-border pt-4">
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
                      {permit.buildingDetails?.numberOfFloors && (
                        <>
                          <div className="min-w-0">
                            <p className="text-xs text-muted-foreground">{t('permits.step2.floorsShort')}</p>
                            <p className="font-medium truncate">{permit.buildingDetails.numberOfFloors}</p>
                          </div>
                          <div className="min-w-0">
                            <p className="text-xs text-muted-foreground">{t('permits.step2.heightShort')}</p>
                            <p className="font-medium truncate">{permit.buildingDetails.buildingHeight}m</p>
                          </div>
                          <div className="min-w-0">
                            <p className="text-xs text-muted-foreground">{t('permits.step2.builtUpAreaShort')}</p>
                            <p className="font-medium truncate">{permit.buildingDetails.totalBuiltUpArea} m²</p>
                          </div>
                          <div className="min-w-0">
                            <p className="text-xs text-muted-foreground">{t('permits.step2.parkingShort')}</p>
                            <p className="font-medium truncate">{permit.buildingDetails.numberOfParkingSpaces}</p>
                          </div>
                        </>
                      )}
                    </div>
                    {permit.complianceCheckResult && (
                      <div className="mt-3 p-3 rounded-lg bg-muted/50">
                        <p className="text-xs font-medium">{t('permits.actions.runCompliance')}: {' '}
                          <span className={
                            permit.complianceCheckResult.overallStatus === 'compliant' ? 'text-violet-600 dark:text-violet-400' :
                            permit.complianceCheckResult.overallStatus === 'non_compliant' ? 'text-red-600 dark:text-red-400' :
                            'text-yellow-600 dark:text-yellow-400'
                          }>
                            {t(`permits.compliance.${permit.complianceCheckResult.overallStatus}`, {
                              defaultValue: permit.complianceCheckResult.overallStatus.replace('_', ' '),
                            })}
                          </span>
                        </p>
                        <p className="text-xs text-muted-foreground mt-1">{permit.complianceCheckResult.summary}</p>
                      </div>
                    )}
                    {permit.reviewComments && (
                      <div className="mt-3 p-3 rounded-lg border border-border">
                        <p className="text-xs font-medium">{t('permits.detail.reviewComments')}:</p>
                        <p className="text-sm mt-1">{permit.reviewComments}</p>
                      </div>
                    )}
                  </CardContent>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {/* Review Dialog */}
      {/* CP-D-6 (v1.2.0): block backdrop / Escape close while review is in
          flight so an accidental click doesn't cancel an admin's
          approve/reject mid-request. */}
      <Dialog
        open={reviewDialog !== null}
        onOpenChange={(open) => {
          if (actionLoading) return;
          if (!open) setReviewDialog(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {reviewDialog?.action === 'approve' ? t('admin.permits.approve') : reviewDialog?.action === 'request_revision' ? t('admin.permits.requestRevision') : t('admin.permits.reject')}
            </DialogTitle>
            <DialogDescription>
              {reviewDialog?.action === 'approve'
                ? t('admin.permits.approveConfirm')
                : t('admin.permits.rejectConfirm')}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <label className="text-sm font-medium">{t('admin.permits.comment')} *</label>
            <textarea
              value={reviewComments}
              onChange={(e) => setReviewComments(e.target.value)}
              className="w-full mt-2 px-3 py-2 rounded-md border border-input bg-background text-sm min-h-[100px] resize-none"
              placeholder={t('admin.permits.comment')}
              required
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setReviewDialog(null); setReviewComments(''); }}>
              {t('common.cancel')}
            </Button>
            <Button
              variant={reviewDialog?.action === 'approve' ? 'default' : reviewDialog?.action === 'request_revision' ? 'outline' : 'destructive'}
              onClick={handleReviewConfirm}
              disabled={!reviewComments.trim() || actionLoading !== null}
            >
              {actionLoading ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : null}
              {reviewDialog?.action === 'approve' ? t('admin.permits.approve') : reviewDialog?.action === 'request_revision' ? t('admin.permits.requestRevision') : t('admin.permits.reject')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StatMini({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <Card>
      <CardContent className="p-3 text-center">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className={`text-lg font-bold ${color || ''}`}>{value}</p>
      </CardContent>
    </Card>
  );
}
