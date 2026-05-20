'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PermitStatusBadge } from './permit-status-badge';
import { PROJECT_TYPES } from '@/lib/constants';
import { Building2, MapPin, Ruler, ParkingSquare, Layers } from 'lucide-react';
import type { PermitApplication } from '@/types';

interface PermitDetailViewProps {
  permit: PermitApplication;
}

export function PermitDetailView({ permit }: PermitDetailViewProps) {
  const typeLabel = PROJECT_TYPES.find(t => t.value === permit.projectType)?.label || permit.projectType;
  const bd = permit.buildingDetails;
  const hasBuildingDetails = bd && bd.numberOfFloors;

  return (
    <div className="space-y-4">
      {/* Header */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-xl font-bold">{permit.projectName}</h2>
              <div className="flex items-center gap-3 mt-2 text-sm text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Building2 className="h-4 w-4" />
                  {typeLabel}
                </span>
                <span className="flex items-center gap-1">
                  <MapPin className="h-4 w-4" />
                  {permit.projectAddress}
                </span>
              </div>
              {permit.plotNumber && (
                <p className="text-sm text-muted-foreground mt-1">Plot: {permit.plotNumber}</p>
              )}
              {permit.projectDescription && (
                <p className="text-sm text-muted-foreground mt-2">{permit.projectDescription}</p>
              )}
            </div>
            <PermitStatusBadge status={permit.status} />
          </div>
        </CardContent>
      </Card>

      {/* Building Details */}
      {hasBuildingDetails && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Layers className="h-4 w-4" />
              Building Details
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <DetailItem label="Floors" value={String(bd.numberOfFloors)} />
              <DetailItem label="Height" value={`${bd.buildingHeight}m`} />
              <DetailItem label="Built-Up Area" value={`${bd.totalBuiltUpArea} m²`} />
              <DetailItem label="Plot Area" value={`${bd.plotArea} m²`} />
              <DetailItem label="Units" value={String(bd.numberOfUnits || 0)} />
              <DetailItem
                label="Parking"
                value={String(bd.numberOfParkingSpaces || 0)}
                icon={<ParkingSquare className="h-3 w-3" />}
              />
              <DetailItem label="Occupancy" value={bd.occupancyType || 'N/A'} />
              <DetailItem label="Construction" value={bd.constructionType || 'N/A'} />
            </div>

            {bd.plotArea && bd.totalBuiltUpArea && (
              <div className="mt-4 p-3 rounded-lg bg-muted/50">
                <div className="flex items-center gap-2">
                  <Ruler className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm">
                    <span className="font-medium">FAR:</span>{' '}
                    {bd.totalBuiltUpArea && bd.plotArea
                      ? (bd.totalBuiltUpArea / bd.plotArea).toFixed(2)
                      : '—'}
                    {' · '}
                    <span className="font-medium">Coverage:</span>{' '}
                    {bd.totalBuiltUpArea && bd.plotArea && (bd.numberOfFloors ?? 0) > 0
                      ? ((bd.totalBuiltUpArea / (bd.numberOfFloors as number) / bd.plotArea) * 100).toFixed(1) + '%'
                      : '—'}
                  </span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Compliance Requirements */}
      {permit.complianceRequirements && Object.keys(permit.complianceRequirements).length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Compliance Requirements</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {permit.complianceRequirements.fireSafety && <RequirementBadge label="Fire Safety" />}
              {permit.complianceRequirements.accessibility && <RequirementBadge label="Accessibility" />}
              {permit.complianceRequirements.parkingCompliance && <RequirementBadge label="Parking" />}
              {permit.complianceRequirements.structuralSafety && <RequirementBadge label="Structural Safety" />}
              {permit.complianceRequirements.mepSystems && <RequirementBadge label="MEP Systems" />}
              {permit.complianceRequirements.energyEfficiency && <RequirementBadge label="Energy Efficiency" />}
            </div>
            {permit.complianceRequirements.additionalNotes && (
              <p className="text-sm text-muted-foreground mt-3">
                {permit.complianceRequirements.additionalNotes}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Review Comments */}
      {permit.reviewComments && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Review Comments</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm">{permit.reviewComments}</p>
            {permit.reviewedAt && (
              <p className="text-xs text-muted-foreground mt-2">
                Reviewed: {new Date(permit.reviewedAt).toLocaleString()}
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function DetailItem({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground flex items-center gap-1">
        {icon}
        {label}
      </p>
      <p className="text-sm font-medium mt-0.5">{value}</p>
    </div>
  );
}

function RequirementBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-primary/10 text-primary border border-primary/20">
      {label}
    </span>
  );
}
