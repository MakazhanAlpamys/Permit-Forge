'use client';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onNext();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Project Information</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Project Name *</label>
            <input
              type="text"
              required
              value={data.projectName}
              onChange={(e) => onChange({ ...data, projectName: e.target.value })}
              className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm"
              placeholder="e.g., Al Barsha Residential Tower"
              disabled={loading}
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Project Type *</label>
            <select
              required
              value={data.projectType}
              onChange={(e) => onChange({ ...data, projectType: e.target.value })}
              className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm"
              disabled={loading}
            >
              <option value="">Select project type</option>
              {PROJECT_TYPES.map(type => (
                <option key={type.value} value={type.value}>{type.label}</option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Project Address *</label>
            <input
              type="text"
              required
              value={data.projectAddress}
              onChange={(e) => onChange({ ...data, projectAddress: e.target.value })}
              className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm"
              placeholder="e.g., Plot 123, Al Barsha 1, Dubai"
              disabled={loading}
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Plot Number</label>
            <input
              type="text"
              value={data.plotNumber}
              onChange={(e) => onChange({ ...data, plotNumber: e.target.value })}
              className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm"
              placeholder="e.g., 123-456"
              disabled={loading}
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Project Description</label>
            <textarea
              value={data.projectDescription}
              onChange={(e) => onChange({ ...data, projectDescription: e.target.value })}
              className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm min-h-[80px] resize-none"
              placeholder="Brief description of the project..."
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
              {loading ? 'Saving...' : 'Next'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
