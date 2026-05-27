'use client';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ShieldCheck, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
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
  hasBuildingDetails?: boolean;
}

type FieldKey = Exclude<keyof ComplianceRequirements, 'additionalNotes'>;

const COMPLIANCE_FIELDS: { key: FieldKey; labelKey: string; descKey: string }[] = [
  { key: 'fireSafety', labelKey: 'permits.step3.fireSafety', descKey: 'permits.step3.fireSafetyDesc' },
  { key: 'accessibility', labelKey: 'permits.step3.accessibility', descKey: 'permits.step3.accessibilityDesc' },
  { key: 'parkingCompliance', labelKey: 'permits.step3.parkingCompliance', descKey: 'permits.step3.parkingComplianceDesc' },
  { key: 'structuralSafety', labelKey: 'permits.step3.structuralSafety', descKey: 'permits.step3.structuralSafetyDesc' },
  { key: 'mepSystems', labelKey: 'permits.step3.mep', descKey: 'permits.step3.mepDesc' },
  { key: 'energyEfficiency', labelKey: 'permits.step3.energyEfficiency', descKey: 'permits.step3.energyEfficiencyDesc' },
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
  hasBuildingDetails = true,
}: PermitFormStep3Props) {
  const { t } = useTranslation();
  const toggleField = (key: FieldKey) => {
    onChange({ ...data, [key]: !data[key] });
  };

  const hasAnySelected = COMPLIANCE_FIELDS.some(f => data[f.key]);

  const FRESH_WINDOW_MS = 60 * 60 * 1000;
  const isCheckFresh =
    !!lastCheckAt && Date.now() - new Date(lastCheckAt).getTime() < FRESH_WINDOW_MS;
  const checkButtonDisabled = loading || checkLoading || isCheckFresh || !hasBuildingDetails;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{t('permits.step3.title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          {t('permits.step3.subtitle')}
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
                <span className="text-sm font-medium">{t(field.labelKey)}</span>
              </div>
            </label>
          ))}
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">{t('permits.step3.additionalNotes')}</label>
          <textarea
            value={data.additionalNotes || ''}
            onChange={(e) => onChange({ ...data, additionalNotes: e.target.value })}
            className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm min-h-[80px] resize-none"
            placeholder={t('permits.step3.additionalNotesPlaceholder')}
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
              <span className="text-sm font-medium">{t('permits.actions.runCompliance')}</span>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onRunCheck}
              disabled={checkButtonDisabled}
            >
              {checkLoading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  {t('permits.actions.runningCompliance')}
                </>
              ) : (
                t('permits.actions.runCompliance')
              )}
            </Button>
          </div>
        )}

        <div className="flex justify-between pt-2">
          <Button type="button" variant="outline" onClick={onBack} disabled={loading || checkLoading}>
            {t('common.back')}
          </Button>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={onSaveDraft}
              disabled={loading || checkLoading}
            >
              {loading ? t('common.saving') : t('permits.actions.saveDraft')}
            </Button>
            <Button
              type="button"
              onClick={onSubmit}
              disabled={loading || checkLoading}
            >
              {loading ? t('permits.actions.submitting') : t('permits.actions.submit')}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
