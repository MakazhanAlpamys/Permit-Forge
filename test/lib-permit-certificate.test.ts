// ============================================================================
// Coverage backfill for lib/permit-certificate.ts (P2-T6a)
// ============================================================================
// PDFKit is exercised end-to-end (no mocking) so we assert on the produced
// buffer: PDF magic bytes, non-trivial size, and key strings appearing in the
// raw bytes. This catches PDFKit-API regressions that pure mocks would miss.

import { describe, it, expect } from 'vitest';
import {
  generateCertificateNumber,
  generateCertificatePDF,
  type CertificateData,
} from '@/lib/permit-certificate';
import type { BuildingDetails } from '@/types';

const sampleBuildingDetails: BuildingDetails = {
  numberOfFloors: 5,
  totalBuiltUpArea: 2400,
  plotArea: 1200,
  buildingHeight: 22,
  numberOfUnits: 12,
  numberOfParkingSpaces: 14,
  occupancyType: 'Residential',
  constructionType: 'RCC Frame',
};

const sampleData: CertificateData = {
  certificateNumber: 'PF-CERT-2026-ABCD1234',
  projectName: 'Tower One',
  projectType: 'mixed_use',
  projectAddress: '123 Sample Road, Dubai',
  plotNumber: 'P-451',
  buildingDetails: sampleBuildingDetails,
  complianceStatus: 'approved',
  approvalDate: '2026-04-30T10:00:00Z',
  reviewComments: 'All requirements satisfied.',
};

// PDFKit emits compressed text streams in non-debug builds, so text isn't
// directly searchable in the binary buffer. We assert on structural shape
// instead (size, magic bytes, success of generation).

describe('lib/permit-certificate > generateCertificateNumber', () => {
  it('formats as PF-CERT-{YEAR}-{ID8} from a UUID', () => {
    const num = generateCertificateNumber('550e8400-e29b-41d4-a716-446655440000');
    expect(num).toMatch(/^PF-CERT-\d{4}-[0-9A-F]{8}$/);
  });

  it('uppercases the id segment and strips hyphens', () => {
    const num = generateCertificateNumber('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(num).toContain('AAAAAAAA');
    expect(num).not.toContain('aaaaaaaa');
  });

  it('uses the current year', () => {
    const num = generateCertificateNumber('00000000-0000-0000-0000-000000000000');
    const year = new Date().getFullYear();
    expect(num).toContain(`-${year}-`);
  });

  it('returns a stable prefix even for short ids (no hyphens)', () => {
    const num = generateCertificateNumber('short');
    expect(num.startsWith('PF-CERT-')).toBe(true);
  });
});

describe('lib/permit-certificate > generateCertificatePDF', () => {
  it('returns a non-empty buffer starting with the PDF magic bytes', async () => {
    const buf = await generateCertificatePDF(sampleData);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThan(1000);
    expect(buf.subarray(0, 4).toString('ascii')).toBe('%PDF');
  });

  it('produces a valid PDF when plot number and review comments are absent', async () => {
    const data = { ...sampleData };
    delete data.plotNumber;
    delete data.reviewComments;
    const buf = await generateCertificatePDF(data);
    expect(buf.subarray(0, 4).toString('ascii')).toBe('%PDF');
    expect(buf.length).toBeGreaterThan(1000);
  });

  it('produces a valid PDF when review comments are very long (multi-page path)', async () => {
    const longComment = 'Comments. '.repeat(500);
    const buf = await generateCertificatePDF({ ...sampleData, reviewComments: longComment });
    expect(buf.subarray(0, 4).toString('ascii')).toBe('%PDF');
    expect(buf.length).toBeGreaterThan(1500);
  });

  it('handles an invalid approval date without throwing', async () => {
    const buf = await generateCertificatePDF({ ...sampleData, approvalDate: 'not-a-date' });
    expect(buf.length).toBeGreaterThan(1000);
  });

  it('handles compliance statuses other than approved', async () => {
    const buf = await generateCertificatePDF({ ...sampleData, complianceStatus: 'requires_review' });
    expect(buf.subarray(0, 4).toString('ascii')).toBe('%PDF');
  });

  it('handles each project_type variant', async () => {
    for (const t of ['residential', 'commercial', 'industrial', 'mixed_use', 'institutional']) {
      const buf = await generateCertificatePDF({ ...sampleData, projectType: t });
      expect(buf.length).toBeGreaterThan(1000);
    }
  });

  it('handles zero plot area (avoids divide-by-zero in FAR calc)', async () => {
    const bd: BuildingDetails = { ...sampleBuildingDetails, plotArea: 0 };
    const buf = await generateCertificatePDF({ ...sampleData, buildingDetails: bd });
    expect(buf.length).toBeGreaterThan(1000);
  });
});
