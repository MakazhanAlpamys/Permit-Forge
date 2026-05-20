// ============================================================================
// Permit Compliance Check Tests
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock hybridSearch
const mockHybridSearch = vi.fn();
vi.mock('@/lib/rag', () => ({
  hybridSearch: (...args: unknown[]) => mockHybridSearch(...args),
}));

// Mock Gemini chat model — F26 replaced the chatModel proxy export with
// getChatModel(), so the mock factory now returns a getter function.
const mockInvoke = vi.fn();
vi.mock('@/lib/gemini', () => ({
  getChatModel: () => ({
    invoke: (...args: unknown[]) => mockInvoke(...args),
  }),
}));

vi.mock('@langchain/core/messages', () => ({
  HumanMessage: class { constructor(public content: string) {} },
  SystemMessage: class { constructor(public content: string) {} },
}));

import { checkPermitCompliance } from '@/lib/permit-compliance';
import type { BuildingDetails, ComplianceRequirements, ProjectType } from '@/types';

const sampleBuildingDetails: BuildingDetails = {
  buildingHeight: 45,
  numberOfFloors: 12,
  totalBuiltUpArea: 5000,
  plotArea: 2000,
  numberOfUnits: 24,
  numberOfParkingSpaces: 50,
  occupancyType: 'Residential',
  constructionType: 'Reinforced Concrete',
};

const sampleComplianceReqs: ComplianceRequirements = {
  fireSafety: true,
  accessibility: true,
  parkingCompliance: true,
  structuralSafety: true,
  mepSystems: true,
  energyEfficiency: false,
};

const sampleProjectType: ProjectType = 'residential';

describe('Permit Compliance Check', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Mock search results
    mockHybridSearch.mockResolvedValue([
      {
        id: 1,
        content: 'Maximum building height for residential: 60m',
        metadata: { page: 30, section: '2.1' },
        similarity: 0.9,
      },
    ]);

    // Mock AI response with valid JSON
    mockInvoke.mockResolvedValue({
      content: JSON.stringify({
        overallStatus: 'compliant',
        checks: [
          {
            category: 'Building Height',
            status: 'compliant',
            details: 'Building height 45m is within 60m limit',
            codeReferences: ['Section 2.1, Page 30'],
          },
        ],
        summary: 'The building meets all requirements.',
      }),
    });
  });

  it('should return compliant result for valid building data', async () => {
    const result = await checkPermitCompliance(
      sampleBuildingDetails,
      sampleComplianceReqs,
      sampleProjectType
    );

    expect(result.overallStatus).toBe('compliant');
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].category).toBe('Building Height');
    expect(result.checkedAt).toBeDefined();
    // E17: hybridSearch must be called with at least one building-context
    // query, otherwise the AI is reasoning blind.
    expect(mockHybridSearch).toHaveBeenCalled();
    const queries = mockHybridSearch.mock.calls.map((c) => String(c[0]).toLowerCase());
    expect(queries.some((q) => /(building|height|parking|safety|fire|accessibility)/.test(q))).toBe(
      true,
    );
  });

  it('should call hybridSearch with generated queries', async () => {
    await checkPermitCompliance(
      sampleBuildingDetails,
      sampleComplianceReqs,
      sampleProjectType
    );

    expect(mockHybridSearch).toHaveBeenCalled();
    // E17: should have at least one query per enabled compliance check.
    // sampleComplianceReqs has 5 trues (fire, accessibility, parking,
    // structural, mep). The function may also issue a generic project-type
    // query, so we assert >= 5 to allow growth but reject a single combined query.
    const enabledChecks = Object.values(sampleComplianceReqs).filter(
      (v) => v === true,
    ).length;
    expect(mockHybridSearch.mock.calls.length).toBeGreaterThanOrEqual(enabledChecks);
  });

  it('should handle AI returning non_compliant status', async () => {
    mockInvoke.mockResolvedValue({
      content: JSON.stringify({
        overallStatus: 'non_compliant',
        checks: [
          {
            category: 'Parking',
            status: 'non_compliant',
            details: 'Insufficient parking spaces',
            codeReferences: ['Section 3.2, Page 45'],
          },
        ],
        summary: 'Parking does not meet requirements.',
      }),
    });

    const result = await checkPermitCompliance(
      sampleBuildingDetails,
      sampleComplianceReqs,
      sampleProjectType
    );

    expect(result.overallStatus).toBe('non_compliant');
  });

  it('should handle AI failure gracefully with requires_review fallback', async () => {
    mockInvoke.mockRejectedValue(new Error('AI unavailable'));

    const result = await checkPermitCompliance(
      sampleBuildingDetails,
      sampleComplianceReqs,
      sampleProjectType
    );

    expect(result.overallStatus).toBe('requires_review');
    expect(result.checks.length).toBeGreaterThan(0);
    expect(result.checks.every(c => c.status === 'requires_review')).toBe(true);
  });

  it('should handle empty search results', async () => {
    mockHybridSearch.mockResolvedValue([]);

    const result = await checkPermitCompliance(
      sampleBuildingDetails,
      sampleComplianceReqs,
      sampleProjectType
    );

    // E17: empty context must still produce a structured result and the AI
    // must still have been invoked — we don't want a silent short-circuit
    // that returns "compliant" without checking anything.
    expect(mockInvoke).toHaveBeenCalled();
    expect(['compliant', 'non_compliant', 'requires_review']).toContain(
      result.overallStatus,
    );
    expect(Array.isArray(result.checks)).toBe(true);
    expect(result.checkedAt).toBeDefined();
  });

  it('should handle malformed AI JSON response', async () => {
    mockInvoke.mockResolvedValue({
      content: 'This is not valid JSON',
    });

    const result = await checkPermitCompliance(
      sampleBuildingDetails,
      sampleComplianceReqs,
      sampleProjectType
    );

    // Should fallback to requires_review
    expect(result.overallStatus).toBe('requires_review');
  });
});
