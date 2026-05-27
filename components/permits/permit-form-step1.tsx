'use client';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useTranslation } from 'react-i18next';
import { PROJECT_TYPES } from '@/lib/constants';

interface Step1Data {
  projectName: string;
  projectType: string;
  projectAddress: string;
  plotNumber: string;
  projectDescription: string;
}

interface PermitFormStep1Props {
  data: Step1Data;
  onChange: (data: Step1Data) => void;
  onNext: () => void;
  loading: boolean;
  error: string;
}

export function PermitFormStep1({ data, onChange, onNext, loading, error }: PermitFormStep1Props) {
  const { t } = useTranslation();
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onNext();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{t('permits.step1.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('permits.step1.projectName')} *</label>
            <input
              type="text"
              required
              value={data.projectName}
              onChange={(e) => onChange({ ...data, projectName: e.target.value })}
              className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm"
              placeholder={t('permits.step1.projectNamePlaceholder')}
              disabled={loading}
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">{t('permits.step1.projectType')} *</label>
            <select
              required
              value={data.projectType}
              onChange={(e) => onChange({ ...data, projectType: e.target.value })}
              className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm"
              disabled={loading}
            >
              <option value="">{t('permits.step1.projectType')}</option>
              {PROJECT_TYPES.map(type => (
                <option key={type.value} value={type.value}>
                  {t(`permits.step1.type.${type.value}`, { defaultValue: type.label })}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">{t('permits.step1.location')} *</label>
            <input
              type="text"
              required
              value={data.projectAddress}
              onChange={(e) => onChange({ ...data, projectAddress: e.target.value })}
              className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm"
              placeholder={t('permits.step1.locationPlaceholder')}
              disabled={loading}
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">{t('permits.step2.plotArea')}</label>
            <input
              type="text"
              value={data.plotNumber}
              onChange={(e) => onChange({ ...data, plotNumber: e.target.value })}
              className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm"
              placeholder="123-456"
              disabled={loading}
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">{t('permits.step1.projectDescription')}</label>
            <textarea
              value={data.projectDescription}
              onChange={(e) => onChange({ ...data, projectDescription: e.target.value })}
              className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm min-h-[80px] resize-none"
              placeholder={t('permits.step1.projectDescriptionPlaceholder')}
              disabled={loading}
              maxLength={2000}
            />
          </div>

          {error && (
            <div className="p-3 rounded-md bg-red-500/10 border border-red-500/30 text-red-500 text-sm">
              {error}
            </div>
          )}

          <div className="flex justify-end">
            <Button type="submit" disabled={loading}>
              {loading ? t('common.saving') : t('common.next')}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
