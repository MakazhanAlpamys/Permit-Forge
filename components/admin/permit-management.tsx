'use client';

// ============================================================================
// Admin Permit Management Component
// ============================================================================

import { useState, useEffect, useRef } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { PermitStatusBadge } from '@/components/permits/permit-status-badge';
import { PROJECT_TYPES, PERMIT_STATUS_FILTERS } from '@/lib/constants';
import { reviewPermit, setPermitUnderReview } from '@/actions/admin-permits';
import { getCSRFTokenAction } from '@/actions/auth';
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
  const [activeFilter, setActiveFilter] = useState('all');
  const [expandedPermit, setExpandedPermit] = useState<string | null>(null);
  const [reviewDialog, setReviewDialog] = useState<{ permit: PermitApplication; action: 'approve' | 'reject' | 'request_revision' } | null>(null);
  const [reviewComments, setReviewComments] = useState('');
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState('');

  const csrfTokenRef = useRef<string | null>(null);
  useEffect(() => {
    getCSRFTokenAction().then(token => { csrfTokenRef.current = token; });
  }, []);

  const handleFilter = (status: string) => {
    setActiveFilter(status);
    onFilterStatus(status);
  };

  const handleStartReview = async (permit: PermitApplication) => {
    if (permit.status !== 'submitted') return;
    setActionLoading(permit.id);
    const result = await setPermitUnderReview(permit.id, csrfTokenRef.current || undefined);
    setActionLoading(null);
    if (result.success) {
      onRefresh();
    } else {
      setError(result.error || 'Failed to start review');
    }
  };

  const handleReviewConfirm = async () => {
    if (!reviewDialog) return;
    setActionLoading(reviewDialog.permit.id);
    setError('');

    const result = await reviewPermit({
      permitId: reviewDialog.permit.id,
      action: reviewDialog.action,
      comments: reviewComments,
    }, csrfTokenRef.current || undefined);

    setActionLoading(null);

    if (result.success) {
      setReviewDialog(null);
      setReviewComments('');
      onRefresh();
    } else {
      setError(result.error || 'Failed to review permit');
    }
  };

  return (
    <div className="space-y-6">
      {/* Stats row */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3">
          <StatMini label="Total" value={stats.totalPermits} />
          <StatMini label="Drafts" value={stats.draftCount} color="text-muted-foreground" />
          <StatMini label="Submitted" value={stats.submittedCount} color="text-blue-400" />
          <StatMini label="Under Review" value={stats.underReviewCount} color="text-yellow-400" />
          <StatMini label="Approved" value={stats.approvedCount} color="text-violet-400" />
          <StatMini label="Rejected" value={stats.rejectedCount} color="text-red-400" />
          <StatMini label="Revision" value={stats.revisionRequestedCount} color="text-orange-400" />
          <StatMini label="Today" value={stats.permitsToday} />
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
            {sf.label}
          </Button>
        ))}
      </div>

      {error && (
        <div className="p-3 rounded-md bg-red-500/10 border border-red-500/30 text-red-500 text-sm">
          {error}
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
          <p className="text-sm">No permits found</p>
        </div>
      ) : (
        <div className="space-y-2">
          {permits.map(permit => {
            const isExpanded = expandedPermit === permit.id;
            const typeLabel = PROJECT_TYPES.find(t => t.value === permit.projectType)?.label || permit.projectType;

            return (
              <Card key={permit.id} className="overflow-hidden">
                <div
                  className="p-4 cursor-pointer hover:bg-muted/30 transition-colors"
                  onClick={() => setExpandedPermit(isExpanded ? null : permit.id)}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-sm">{permit.projectName}</span>
                        <PermitStatusBadge status={permit.status} />
                        {permit.username && (
                          <Badge variant="secondary" className="text-xs">
                            {permit.username}
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <Building2 className="h-3 w-3" />
                          {typeLabel}
                        </span>
                        <span className="flex items-center gap-1">
                          <MapPin className="h-3 w-3" />
                          {permit.projectAddress}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {permit.status === 'submitted' && (
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
                              Start Review
                            </>
                          )}
                        </Button>
                      )}
                      {(permit.status === 'submitted' || permit.status === 'under_review') && (
                        <>
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-violet-500 border-violet-500/30 hover:bg-violet-500/10"
                            onClick={(e) => {
                              e.stopPropagation();
                              setReviewDialog({ permit, action: 'approve' });
                            }}
                          >
                            <CheckCircle2 className="h-3 w-3 mr-1" />
                            Approve
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-orange-500 border-orange-500/30 hover:bg-orange-500/10"
                            onClick={(e) => {
                              e.stopPropagation();
                              setReviewDialog({ permit, action: 'request_revision' });
                            }}
                          >
                            <RotateCcw className="h-3 w-3 mr-1" />
                            Revise
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-red-500 border-red-500/30 hover:bg-red-500/10"
                            onClick={(e) => {
                              e.stopPropagation();
                              setReviewDialog({ permit, action: 'reject' });
                            }}
                          >
                            <XCircle className="h-3 w-3 mr-1" />
                            Reject
                          </Button>
                        </>
                      )}
                      {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                    </div>
                  </div>
                </div>

                {/* Expanded details */}
                {isExpanded && (
                  <CardContent className="border-t border-border pt-4">
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
                      {permit.buildingDetails?.numberOfFloors && (
                        <>
                          <div>
                            <p className="text-xs text-muted-foreground">Floors</p>
                            <p className="font-medium">{permit.buildingDetails.numberOfFloors}</p>
                          </div>
                          <div>
                            <p className="text-xs text-muted-foreground">Height</p>
                            <p className="font-medium">{permit.buildingDetails.buildingHeight}m</p>
                          </div>
                          <div>
                            <p className="text-xs text-muted-foreground">Built-Up Area</p>
                            <p className="font-medium">{permit.buildingDetails.totalBuiltUpArea} m²</p>
                          </div>
                          <div>
                            <p className="text-xs text-muted-foreground">Parking</p>
                            <p className="font-medium">{permit.buildingDetails.numberOfParkingSpaces}</p>
                          </div>
                        </>
                      )}
                    </div>
                    {permit.complianceCheckResult && (
                      <div className="mt-3 p-3 rounded-lg bg-muted/50">
                        <p className="text-xs font-medium">AI Compliance: {' '}
                          <span className={
                            permit.complianceCheckResult.overallStatus === 'compliant' ? 'text-violet-400' :
                            permit.complianceCheckResult.overallStatus === 'non_compliant' ? 'text-red-400' :
                            'text-yellow-400'
                          }>
                            {permit.complianceCheckResult.overallStatus.replace('_', ' ')}
                          </span>
                        </p>
                        <p className="text-xs text-muted-foreground mt-1">{permit.complianceCheckResult.summary}</p>
                      </div>
                    )}
                    {permit.reviewComments && (
                      <div className="mt-3 p-3 rounded-lg border border-border">
                        <p className="text-xs font-medium">Review Comments:</p>
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
      <Dialog open={reviewDialog !== null} onOpenChange={(open) => !open && setReviewDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {reviewDialog?.action === 'approve' ? 'Approve' : reviewDialog?.action === 'request_revision' ? 'Request Revision' : 'Reject'} Permit
            </DialogTitle>
            <DialogDescription>
              {reviewDialog?.action === 'approve'
                ? `Approve "${reviewDialog.permit.projectName}"?`
                : reviewDialog?.action === 'request_revision'
                  ? `Request revisions for "${reviewDialog?.permit.projectName}"?`
                  : `Reject "${reviewDialog?.permit.projectName}"?`}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <label className="text-sm font-medium">Review Comments *</label>
            <textarea
              value={reviewComments}
              onChange={(e) => setReviewComments(e.target.value)}
              className="w-full mt-2 px-3 py-2 rounded-md border border-input bg-background text-sm min-h-[100px] resize-none"
              placeholder="Enter your review comments..."
              required
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setReviewDialog(null); setReviewComments(''); }}>
              Cancel
            </Button>
            <Button
              variant={reviewDialog?.action === 'approve' ? 'default' : reviewDialog?.action === 'request_revision' ? 'outline' : 'destructive'}
              onClick={handleReviewConfirm}
              disabled={!reviewComments.trim() || actionLoading !== null}
            >
              {actionLoading ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : null}
              {reviewDialog?.action === 'approve' ? 'Approve' : reviewDialog?.action === 'request_revision' ? 'Request Revision' : 'Reject'}
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
