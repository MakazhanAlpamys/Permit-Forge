'use client';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ShieldCheck, Loader2 } from 'lucide-react';
import type { ComplianceRequirements } from '@/types';

interface PermitFormStep3Props {
  data: ComplianceRequirements;
  onChange: (data: ComplianceRequirements) => void;
  onBack: () => void;
  onSaveDraft: () => void;
  onSubmit: () => void;
  onRunCheck: () => void;
  loading: boolean;
  checkLoading: boolean;
  error: string;
  /** ISO timestamp from the last AI compliance check, if any. (B11) */
  lastCheckAt?: string | null;
}

const COMPLIANCE_FIELDS: { key: keyof Omit<ComplianceRequirements, 'additionalNotes'>; label: string; description: string }[] = [
  { key: 'fireSafety', label: 'Fire Safety', description: 'Fire protection, evacuation routes, sprinkler systems' },
  { key: 'accessibility', label: 'Accessibility', description: 'Wheelchair access, ramps, accessible facilities' },
  { key: 'parkingCompliance', label: 'Parking', description: 'Parking space requirements per building type' },
  { key: 'structuralSafety', label: 'Structural Safety', description: 'Foundation, load-bearing, seismic requirements' },
  { key: 'mepSystems', label: 'MEP Systems', description: 'Mechanical, electrical, plumbing systems' },
  { key: 'energyEfficiency', label: 'Energy Efficiency', description: 'Insulation, glazing, HVAC efficiency' },
];

export function PermitFormStep3({
  data,
  onChange,
  onBack,
  onSaveDraft,
  onSubmit,
  onRunCheck,
  loading,
  checkLoading,
  error,
  lastCheckAt,
}: PermitFormStep3Props) {
  const toggleField = (key: keyof Omit<ComplianceRequirements, 'additionalNotes'>) => {
    onChange({ ...data, [key]: !data[key] });
  };

  const hasAnySelected = COMPLIANCE_FIELDS.some(f => data[f.key]);

  // B11/H3-clickpath + H11: the AI check result is invalidated by any
  // building_details / compliance_requirements edit (server-side; see B16),
  // so a result existing means the inputs are still the same as when the
  // check ran. The only remaining freshness signal is the check's age —
  // disable for one hour after the check completes to nudge the user back
  // to "Save Draft" / "Submit" instead of re-running the same analysis.
  const FRESH_WINDOW_MS = 60 * 60 * 1000;
  const isCheckFresh =
    !!lastCheckAt && Date.now() - new Date(lastCheckAt).getTime() < FRESH_WINDOW_MS;
  const checkButtonDisabled = loading || checkLoading || isCheckFresh;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Compliance Requirements</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Select the compliance areas you want verified against the building code.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {COMPLIANCE_FIELDS.map(field => (
            <label
              key={field.key}
              className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                data[field.key]
                  ? 'border-primary bg-primary/5'
                  : 'border-input hover:bg-muted/50'
              }`}
            >
              <input
                type="checkbox"
                checked={data[field.key]}
                onChange={() => toggleField(field.key)}
                className="mt-0.5 h-4 w-4 rounded border-input"
                disabled={loading || checkLoading}
              />
              <div>
                <span className="text-sm font-medium">{field.label}</span>
                <p className="text-xs text-muted-foreground mt-0.5">{field.description}</p>
              </div>
            </label>
          ))}
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Additional Notes</label>
          <textarea
            value={data.additionalNotes || ''}
            onChange={(e) => onChange({ ...data, additionalNotes: e.target.value })}
            className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm min-h-[80px] resize-none"
            placeholder="Any specific compliance concerns or notes..."
            disabled={loading || checkLoading}
            maxLength={2000}
          />
        </div>

        {error && (
          <div className="p-3 rounded-md bg-red-500/10 border border-red-500/30 text-red-500 text-sm">
            {error}
          </div>
        )}

        {/* AI Compliance Check */}
        {hasAnySelected && (
          <div className="p-4 rounded-lg border border-dashed border-primary/50 bg-primary/5">
            <div className="flex items-center gap-2 mb-2">
              <ShieldCheck className="h-4 w-4 text-primary" />
              <span className="text-sm font-medium">AI Compliance Check</span>
            </div>
            <p className="text-xs text-muted-foreground mb-3">
              Run an AI-powered analysis to check your project against the building code before submitting.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onRunCheck}
              disabled={checkButtonDisabled}
              title={isCheckFresh ? 'Recent AI check still valid (<1h). Edit details to re-run.' : undefined}
            >
              {checkLoading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Analyzing...
                </>
              ) : isCheckFresh ? (
                'AI Check Up-to-date'
              ) : (
                'Run AI Check'
              )}
            </Button>
          </div>
        )}

        <div className="flex justify-between pt-2">
          <Button type="button" variant="outline" onClick={onBack} disabled={loading || checkLoading}>
            Back
          </Button>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={onSaveDraft}
              disabled={loading || checkLoading}
            >
              {loading ? 'Saving...' : 'Save Draft'}
            </Button>
            <Button
              type="button"
              onClick={onSubmit}
              disabled={loading || checkLoading}
            >
              {loading ? 'Submitting...' : 'Submit Application'}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
