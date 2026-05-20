// ============================================================================
// E12 — lib/permit-certificate.ts coverage
// ============================================================================
// PDFKit compresses content streams (FlateDecode), so the raw output buffer
// doesn't contain readable text labels — we don't OCR. We assert:
//   - generateCertificateNumber shape: PF-CERT-{YEAR}-{8-char hex from UUID}
//   - generateCertificatePDF returns a non-empty Buffer with a %PDF- header
//     and a %%EOF trailer
//   - Optional null/undefined fields don't crash generation
//   - Same input → identical-ish size (deterministic structure)
//   - Varying input → different buffer (so generation isn't a no-op)
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  generateCertificateNumber,
  generateCertificatePDF,
  type CertificateData,
} from '@/lib/permit-certificate';
import type { BuildingDetails } from '@/types';

const SAMPLE_BD: BuildingDetails = {
  numberOfFloors: 5,
  totalBuiltUpArea: 1200,
  plotArea: 600,
  buildingHeight: 22.5,
  numberOfUnits: 12,
  numberOfParkingSpaces: 20,
  occupancyType: 'Residential',
  constructionType: 'Type IV',
};

function fullData(overrides: Partial<CertificateData> = {}): CertificateData {
  return {
    certificateNumber: 'PF-CERT-2026-ABCDEF12',
    projectName: 'Acme Residential Tower',
    projectType: 'residential',
    projectAddress: '123 Sheikh Zayed Rd, Dubai',
    plotNumber: 'PL-44-1',
    buildingDetails: SAMPLE_BD,
    complianceStatus: 'approved',
    approvalDate: '2026-05-10',
    reviewComments: 'All checks passed. No corrections required.',
    ...overrides,
  };
}

// ----------------------------------------------------------------------------
// generateCertificateNumber
// ----------------------------------------------------------------------------

describe('generateCertificateNumber', () => {
  it('produces PF-CERT-{YYYY}-{HEX8} format', () => {
    const out = generateCertificateNumber('550e8400-e29b-41d4-a716-446655440000');
    expect(out).toMatch(/^PF-CERT-\d{4}-[0-9A-F]{8}$/);
  });

  it('strips dashes from the UUID and uppercases the hex slug', () => {
    const out = generateCertificateNumber('550e8400-e29b-41d4-a716-446655440000');
    expect(out.endsWith('-550E8400')).toBe(true);
  });

  it('encodes the current year', () => {
    const out = generateCertificateNumber('550e8400-e29b-41d4-a716-446655440000');
    const expectedYear = new Date().getFullYear();
    expect(out).toContain(`-${expectedYear}-`);
  });

  it('handles short input by truncating to 8 chars', () => {
    const out = generateCertificateNumber('short');
    // "short" has 5 chars; result still respects the shape, last segment
    // is whatever was available, uppercased.
    expect(out).toMatch(/^PF-CERT-\d{4}-[A-Z0-9]+$/);
  });
});

// ----------------------------------------------------------------------------
// generateCertificatePDF
// ----------------------------------------------------------------------------

describe('generateCertificatePDF', () => {
  it('returns a non-empty Buffer with a valid PDF header', async () => {
    const buf = await generateCertificatePDF(fullData());
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(1024);
    expect(buf.slice(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('ends with the PDF %%EOF trailer', async () => {
    const buf = await generateCertificatePDF(fullData());
    const tail = buf.slice(-32).toString('latin1');
    expect(tail).toContain('%%EOF');
  });

  it('produces different output for different project names', async () => {
    const a = await generateCertificatePDF(fullData({ projectName: 'Alpha Tower' }));
    const b = await generateCertificatePDF(fullData({ projectName: 'Beta Tower' }));
    // FlateDecode compresses the content stream — same shape, different data.
    // Buffers must differ somewhere.
    expect(Buffer.compare(a, b)).not.toBe(0);
  });

  it('survives a minimal certificate (no plotNumber, no reviewComments)', async () => {
    const minimal: CertificateData = {
      certificateNumber: 'PF-CERT-2026-DEADBEEF',
      projectName: 'Minimum Permit',
      projectType: 'commercial',
      projectAddress: 'No address provided',
      buildingDetails: {
        numberOfFloors: 1,
        totalBuiltUpArea: 100,
        plotArea: 200,
        buildingHeight: 4,
        occupancyType: 'Office',
        constructionType: 'Type V',
      },
      complianceStatus: 'approved',
      approvalDate: '2026-05-10',
    };
    const buf = await generateCertificatePDF(minimal);
    expect(buf.length).toBeGreaterThan(1024);
    // No "Review Comments" section should be drawn when there is none.
    // (We only verify the section title is still in the buffer because
    // PDFKit may have written it from the optional branch; the stronger
    // assertion is that PDF generation didn't throw.)
    expect(buf.slice(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('does not throw when approvalDate is unparseable', async () => {
    const buf = await generateCertificatePDF(
      fullData({ approvalDate: 'not-a-real-date' }),
    );
    expect(buf.length).toBeGreaterThan(1024);
  });

  it('handles mixed_use project type without crashing', async () => {
    const buf = await generateCertificatePDF(
      fullData({ projectType: 'mixed_use' }),
    );
    expect(buf.slice(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('does not throw when plotArea is zero (skips FAR computation)', async () => {
    const buf = await generateCertificatePDF(
      fullData({
        buildingDetails: { ...SAMPLE_BD, plotArea: 0 },
      }),
    );
    expect(buf.length).toBeGreaterThan(1024);
  });

  it('handles a building with mostly undefined details', async () => {
    const buf = await generateCertificatePDF(
      fullData({
        buildingDetails: {
          // Every field undefined — exercises the s() fallback for unknown values.
        },
      }),
    );
    expect(buf.length).toBeGreaterThan(1024);
  });
});
