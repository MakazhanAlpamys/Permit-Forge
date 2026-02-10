'use client';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { BuildingDetails } from '@/types';

interface PermitFormStep2Props {
  data: BuildingDetails;
  onChange: (data: BuildingDetails) => void;
  onNext: () => void;
  onBack: () => void;
  loading: boolean;
  error: string;
}

export function PermitFormStep2({ data, onChange, onNext, onBack, loading, error }: PermitFormStep2Props) {
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onNext();
  };

  const updateField = (field: keyof BuildingDetails, value: string | number) => {
    onChange({ ...data, [field]: value });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Building Details</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Number of Floors *</label>
              <input
                type="number"
                required
                min={1}
                max={200}
                value={data.numberOfFloors || ''}
                onChange={(e) => updateField('numberOfFloors', parseInt(e.target.value) || 0)}
                className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm"
                disabled={loading}
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Building Height (meters) *</label>
              <input
                type="number"
                required
                min={1}
                step="0.1"
                value={data.buildingHeight || ''}
                onChange={(e) => updateField('buildingHeight', parseFloat(e.target.value) || 0)}
                className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm"
                disabled={loading}
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Total Built-Up Area (m²) *</label>
              <input
                type="number"
                required
                min={1}
                step="0.01"
                value={data.totalBuiltUpArea || ''}
                onChange={(e) => updateField('totalBuiltUpArea', parseFloat(e.target.value) || 0)}
                className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm"
                disabled={loading}
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Plot Area (m²) *</label>
              <input
                type="number"
                required
                min={1}
                step="0.01"
                value={data.plotArea || ''}
                onChange={(e) => updateField('plotArea', parseFloat(e.target.value) || 0)}
                className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm"
                disabled={loading}
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Number of Units</label>
              <input
                type="number"
                min={0}
                value={data.numberOfUnits || ''}
                onChange={(e) => updateField('numberOfUnits', parseInt(e.target.value) || 0)}
                className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm"
                disabled={loading}
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Number of Parking Spaces</label>
              <input
                type="number"
                min={0}
                value={data.numberOfParkingSpaces || ''}
                onChange={(e) => updateField('numberOfParkingSpaces', parseInt(e.target.value) || 0)}
                className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm"
                disabled={loading}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Occupancy Type *</label>
              <select
                required
                value={data.occupancyType}
                onChange={(e) => updateField('occupancyType', e.target.value)}
                className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm"
                disabled={loading}
              >
                <option value="">Select occupancy type</option>
                <option value="Residential">Residential</option>
                <option value="Commercial">Commercial</option>
                <option value="Office">Office</option>
                <option value="Retail">Retail</option>
                <option value="Hotel">Hotel</option>
                <option value="Hospital">Hospital</option>
                <option value="Educational">Educational</option>
                <option value="Industrial">Industrial</option>
                <option value="Mixed">Mixed Use</option>
                <option value="Assembly">Assembly</option>
                <option value="Warehouse">Warehouse</option>
              </select>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Construction Type *</label>
              <select
                required
                value={data.constructionType}
                onChange={(e) => updateField('constructionType', e.target.value)}
                className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm"
                disabled={loading}
              >
                <option value="">Select construction type</option>
                <option value="Reinforced Concrete">Reinforced Concrete</option>
                <option value="Steel Frame">Steel Frame</option>
                <option value="Precast Concrete">Precast Concrete</option>
                <option value="Masonry">Masonry</option>
                <option value="Composite">Composite</option>
                <option value="Timber">Timber</option>
              </select>
            </div>
          </div>

          {error && (
            <div className="p-3 rounded-md bg-red-500/10 border border-red-500/30 text-red-500 text-sm">
              {error}
            </div>
          )}

          <div className="flex justify-between">
            <Button type="button" variant="outline" onClick={onBack} disabled={loading}>
              Back
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? 'Saving...' : 'Next'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
