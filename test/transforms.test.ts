// ============================================================================
// lib/transforms.ts tests (COV-C-1 / v1.4.0 Part B)
// ============================================================================
// Before this file: transforms.ts was at 33.33% statements / 37.5% lines.
// Most of the file is a single hot mapper (`transformPermit`) — the action
// suites mock it out and don't exercise its real branches.

import { describe, it, expect } from 'vitest';
import { numOrZero, snakeToCamel, transformPermit, type PermitRow } from '@/lib/transforms';
import type { BuildingDetails, ComplianceRequirements } from '@/types';

describe('numOrZero', () => {
  it('returns a finite number unchanged', () => {
    expect(numOrZero(42)).toBe(42);
    expect(numOrZero(0)).toBe(0);
    expect(numOrZero(-7.5)).toBe(-7.5);
  });

  it('coerces a numeric string to a number', () => {
    // Supabase RPCs return COUNT(*) as a string by default.
    expect(numOrZero('42')).toBe(42);
    expect(numOrZero('0')).toBe(0);
  });

  it('returns 0 for null / undefined / NaN / non-numeric strings', () => {
    expect(numOrZero(null)).toBe(0);
    expect(numOrZero(undefined)).toBe(0);
    expect(numOrZero('not-a-number')).toBe(0);
    expect(numOrZero(NaN)).toBe(0);
    expect(numOrZero({})).toBe(0);
  });

  it('returns 0 for Infinity (not finite)', () => {
    expect(numOrZero(Infinity)).toBe(0);
    expect(numOrZero(-Infinity)).toBe(0);
  });
});

describe('snakeToCamel', () => {
  it('maps a flat snake_case object to camelCase', () => {
    const row = { user_id: 'u1', total_users: 42, last_active_at: '2026-01-01' };
    const out = snakeToCamel<{ userId: string; totalUsers: number; lastActiveAt: string }>(row);
    expect(out).toEqual({
      userId: 'u1',
      totalUsers: 42,
      lastActiveAt: '2026-01-01',
    });
  });

  it('preserves values without any coercion (combine with numOrZero for counts)', () => {
    const row = { count_str: '42', count_null: null };
    const out = snakeToCamel<{ countStr: string; countNull: null }>(row);
    expect(out.countStr).toBe('42'); // not 42 — caller is expected to numOrZero
    expect(out.countNull).toBeNull();
  });

  it('leaves already-camel keys alone (no underscores → no replacements)', () => {
    const row = { alreadyCamel: 1, somethingElse: 'x' };
    const out = snakeToCamel<{ alreadyCamel: number; somethingElse: string }>(row);
    expect(out).toEqual(row);
  });

  it('handles numeric suffix segments (foo_1 → foo1)', () => {
    const row = { audit_log_1: 'a', step_2: 'b' };
    const out = snakeToCamel<Record<string, unknown>>(row);
    expect(out.auditLog1).toBe('a');
    expect(out.step2).toBe('b');
  });

  it('returns an empty object for an empty input', () => {
    expect(snakeToCamel({})).toEqual({});
  });
});

describe('transformPermit (golden-file)', () => {
  // Fully populated row → fully populated PermitApplication. This is the
  // happy-path mapping the admin UI exercises constantly.
  const fullBuildingDetails: BuildingDetails = {
    numberOfFloors: 4,
    totalBuiltUpArea: 1200,
    plotArea: 800,
    buildingHeight: 16,
    numberOfUnits: 8,
    numberOfParkingSpaces: 12,
    occupancyType: 'office',
    constructionType: 'steel',
  };

  const fullCompliance: ComplianceRequirements = {
    fireSafety: true,
    accessibility: true,
    parkingCompliance: true,
    structuralSafety: true,
    mepSystems: true,
    energyEfficiency: false,
  };

  const fullRow: PermitRow = {
    id: 'p-1',
    user_id: 'u-1',
    status: 'approved',
    project_name: 'Tower A',
    project_type: 'commercial',
    project_address: '1 Sheikh Zayed Rd',
    plot_number: 'PLT-9',
    project_description: 'Mixed-use tower',
    building_details: fullBuildingDetails,
    compliance_requirements: fullCompliance,
    compliance_check_result: {
      overallStatus: 'compliant',
      checks: [],
      summary: 'ok',
      checkedAt: '2026-05-21T00:00:00Z',
    },
    reviewed_by: 'admin-1',
    reviewed_at: '2026-05-21T00:00:00Z',
    review_comments: 'LGTM',
    submitted_at: '2026-05-20T00:00:00Z',
    revision_count: 1,
    revision_notes: 'fixed parking',
    created_at: '2026-05-18T00:00:00Z',
    updated_at: '2026-05-21T00:00:00Z',
    version: 3,
    users: { username: 'alice' },
  };

  it('maps every snake_case column to its camelCase counterpart', () => {
    const out = transformPermit(fullRow);
    expect(out).toMatchObject({
      id: 'p-1',
      userId: 'u-1',
      status: 'approved',
      projectName: 'Tower A',
      projectType: 'commercial',
      projectAddress: '1 Sheikh Zayed Rd',
      plotNumber: 'PLT-9',
      projectDescription: 'Mixed-use tower',
      buildingDetails: fullBuildingDetails,
      complianceRequirements: fullCompliance,
      reviewedBy: 'admin-1',
      reviewedAt: '2026-05-21T00:00:00Z',
      reviewComments: 'LGTM',
      submittedAt: '2026-05-20T00:00:00Z',
      revisionCount: 1,
      revisionNotes: 'fixed parking',
      createdAt: '2026-05-18T00:00:00Z',
      updatedAt: '2026-05-21T00:00:00Z',
      version: 3,
      username: 'alice',
    });
  });

  it('collapses empty/nullable strings to undefined for optional plotNumber / projectDescription', () => {
    const row: PermitRow = { ...fullRow, plot_number: null, project_description: null };
    const out = transformPermit(row);
    expect(out.plotNumber).toBeUndefined();
    expect(out.projectDescription).toBeUndefined();
  });

  // TS-H-6 / v1.6.0 Part C: absent JSONB columns now surface as `undefined`
  // (was `{}`), so consumers' `if (!bd)` / `bd?.field` checks actually work.
  it('returns undefined for absent building_details / compliance_requirements (TS-H-6 fix)', () => {
    const row: PermitRow = {
      ...fullRow,
      building_details: null,
      compliance_requirements: null,
    };
    const out = transformPermit(row);
    expect(out.buildingDetails).toBeUndefined();
    expect(out.complianceRequirements).toBeUndefined();
  });

  it('defaults complianceCheckResult to null when absent', () => {
    const row: PermitRow = { ...fullRow, compliance_check_result: null };
    expect(transformPermit(row).complianceCheckResult).toBeNull();
  });

  it('defaults revisionCount to 0 when absent', () => {
    const row: PermitRow = { ...fullRow, revision_count: null };
    expect(transformPermit(row).revisionCount).toBe(0);
  });

  it('defaults version to 0 when undefined (?? not || so 0 survives)', () => {
    const row: PermitRow = { ...fullRow, version: undefined };
    expect(transformPermit(row).version).toBe(0);
    // And keeps an explicit 0 as 0 — not converted to undefined.
    expect(transformPermit({ ...fullRow, version: 0 }).version).toBe(0);
  });

  it('returns username undefined when no users join is present', () => {
    const row: PermitRow = { ...fullRow, users: null };
    expect(transformPermit(row).username).toBeUndefined();
  });

  it('returns username undefined when users join is present but username is empty', () => {
    const row: PermitRow = { ...fullRow, users: { username: '' } };
    expect(transformPermit(row).username).toBeUndefined();
  });
});
