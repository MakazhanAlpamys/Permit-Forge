// ============================================================================
// Permits Server Actions Extended Tests
// (updatePermitBuildingDetails, updatePermitComplianceRequirements,
//  getPermitHistory, runComplianceCheck, revisePermit)
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock auth
const mockRequireAuth = vi.fn();
const mockRequireCSRF = vi.fn();
vi.mock('@/lib/security', async () => {
  const actual = await vi.importActual<typeof import('@/lib/security')>('@/lib/security');
  return {
    ...actual,
    requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
    requireCSRF: (...args: unknown[]) => mockRequireCSRF(...args),
  };
});

const mockGetQuickSession = vi.fn();
const mockLogAuditEvent = vi.fn().mockResolvedValue(undefined);
const mockGetRequestMetadata = vi.fn().mockResolvedValue({ ip: '127.0.0.1', userAgent: 'test' });
vi.mock('@/lib/auth', () => ({
  getQuickSession: (...args: unknown[]) => mockGetQuickSession(...args),
  logAuditEvent: (...args: unknown[]) => mockLogAuditEvent(...args),
  getRequestMetadata: (...args: unknown[]) => mockGetRequestMetadata(...args),
}));

// Mock supabase with chainable query builder
const mockSingle = vi.fn();
const mockEq = vi.fn();
const mockSelect = vi.fn();
const mockInsert = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockOrder = vi.fn();
const mockFrom = vi.fn();
// B7: revise path now uses an RPC instead of select/update/insert.
const mockRpc = vi.fn();

function resetChainMocks() {
  mockSingle.mockResolvedValue({ data: null, error: null });
  mockOrder.mockReturnValue({ data: [], error: null });
  mockEq.mockReturnValue({ eq: mockEq, single: mockSingle, select: mockSelect, order: mockOrder, delete: mockDelete });
  mockDelete.mockReturnValue({ eq: mockEq, single: mockSingle, error: null });
  mockUpdate.mockReturnValue({ eq: mockEq, single: mockSingle, error: null });
  mockSelect.mockReturnValue({ eq: mockEq, single: mockSingle, order: mockOrder });
  mockInsert.mockReturnValue({ select: mockSelect, single: mockSingle, error: null });
  mockFrom.mockReturnValue({
    select: mockSelect,
    insert: mockInsert,
    update: mockUpdate,
    delete: mockDelete,
    eq: mockEq,
    single: mockSingle,
    order: mockOrder,
  });
  mockRpc.mockResolvedValue({ data: null, error: null });
}

vi.mock('@/lib/supabase-server', () => ({
  createServerClient: vi.fn(() => ({
    from: (...args: unknown[]) => mockFrom(...args),
    rpc: (...args: unknown[]) => mockRpc(...args),
  })),
  createAdminClient: vi.fn(() => ({
    from: (...args: unknown[]) => mockFrom(...args),
    rpc: (...args: unknown[]) => mockRpc(...args),
    storage: { from: vi.fn().mockReturnValue({ remove: vi.fn().mockResolvedValue({}) }) },
  })),
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
}));

// Mock notifications
vi.mock('@/lib/notifications', () => ({
  createNotification: vi.fn().mockResolvedValue(undefined),
  getNotificationContent: vi.fn().mockReturnValue({ title: 'Test', body: 'Test notification' }),
}));

// Mock permit-compliance
const mockCheckPermitCompliance = vi.fn();
vi.mock('@/lib/permit-compliance', () => ({
  checkPermitCompliance: (...args: unknown[]) => mockCheckPermitCompliance(...args),
}));

// Mock transforms
vi.mock('@/lib/transforms', () => {
  const transformPermit = (row: Record<string, unknown>) => ({
    ...row,
    projectName: row.project_name,
    projectType: row.project_type,
    projectAddress: row.project_address,
  });
  return {
    transformPermit,
    rowToPermit: transformPermit,
    rowsToPermits: (rows: Record<string, unknown>[] | null | undefined) =>
      (rows ?? []).map(transformPermit),
  };
});

import {
  updatePermitBuildingDetails,
  updatePermitComplianceRequirements,
  getPermitHistory,
  runComplianceCheck,
  revisePermit,
} from '@/actions/permits';

const testUser = { id: 'user-123', email: 'test@test.com', role: 'user' };
const validUUID = '550e8400-e29b-41d4-a716-446655440000';

const validBuildingDetails = {
  permitId: validUUID,
  buildingDetails: {
    numberOfFloors: 5,
    totalBuiltUpArea: 2000,
    plotArea: 1000,
    buildingHeight: 20,
    numberOfUnits: 10,
    numberOfParkingSpaces: 20,
    occupancyType: 'Residential',
    constructionType: 'Concrete',
  },
};

const validComplianceRequirements = {
  permitId: validUUID,
  complianceRequirements: {
    fireSafety: true,
    accessibility: true,
    parkingCompliance: true,
    structuralSafety: true,
    mepSystems: true,
    energyEfficiency: false,
  },
};

describe('Permits Server Actions Extended', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChainMocks();
    mockRequireAuth.mockResolvedValue({ success: true, user: testUser });
    mockRequireCSRF.mockResolvedValue({ valid: true });
    mockGetQuickSession.mockResolvedValue(testUser);
  });

  // ---------------------------------------------------------------------------
  // updatePermitBuildingDetails
  // ---------------------------------------------------------------------------

  describe('updatePermitBuildingDetails', () => {
    it('should update building details for a draft permit', async () => {
      // Mock ownership check
      mockSingle
        .mockResolvedValueOnce({ data: { user_id: testUser.id }, error: null })
        // Mock status check
        .mockResolvedValueOnce({ data: { status: 'draft' }, error: null });

      const result = await updatePermitBuildingDetails(validBuildingDetails, 'csrf-token');

      expect(result.success).toBe(true);
      expect(mockFrom).toHaveBeenCalledWith('permit_applications');
    });

    it('should return error when unauthenticated', async () => {
      mockRequireAuth.mockResolvedValue({ success: false, error: 'Not authenticated' });

      const result = await updatePermitBuildingDetails(validBuildingDetails, 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Not authenticated');
    });

    it('should reject invalid CSRF token', async () => {
      mockRequireCSRF.mockResolvedValue({ valid: false, error: 'CSRF token invalid' });

      const result = await updatePermitBuildingDetails(validBuildingDetails, 'bad-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('CSRF token invalid');
    });

    it('should deny access for non-owner', async () => {
      mockSingle.mockResolvedValueOnce({ data: { user_id: 'other-user' }, error: null });

      const result = await updatePermitBuildingDetails(validBuildingDetails, 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Access denied');
    });

    it('should reject non-draft permits', async () => {
      mockSingle
        .mockResolvedValueOnce({ data: { user_id: testUser.id }, error: null })
        .mockResolvedValueOnce({ data: { status: 'submitted' }, error: null });

      const result = await updatePermitBuildingDetails(validBuildingDetails, 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Can only edit draft permits');
    });

    it('should validate input data', async () => {
      const result = await updatePermitBuildingDetails({
        permitId: validUUID,
        buildingDetails: {
          numberOfFloors: -1,
          totalBuiltUpArea: 2000,
          plotArea: 1000,
          buildingHeight: 20,
          numberOfUnits: 10,
          numberOfParkingSpaces: 20,
          occupancyType: 'Residential',
          constructionType: 'Concrete',
        },
      }, 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    // X17: optimistic-locking — when expectedVersion is supplied, the update
    // must include it in the WHERE clause and surface a "changed in another
    // tab" error if no row was affected.
    //
    // The action makes 3 select-style calls: ownership (`select('user_id')`),
    // status (`select('status')`), and finally the awaited `select('id')`
    // after update. We intercept `select` by column so the first two return
    // the normal chainable object and `select('id')` resolves to a Promise.
    function mockUpdateSelectResult(rows: Array<{ id: string }>) {
      mockSelect.mockImplementation((col: string) => {
        if (col === 'id') {
          return Promise.resolve({ data: rows, error: null });
        }
        return { eq: mockEq, single: mockSingle, order: mockOrder };
      });
    }

    it('passes expectedVersion through to the update WHERE clause', async () => {
      mockSingle
        .mockResolvedValueOnce({ data: { user_id: testUser.id }, error: null })
        .mockResolvedValueOnce({ data: { status: 'draft' }, error: null });
      mockUpdateSelectResult([{ id: validUUID }]);

      const result = await updatePermitBuildingDetails(
        { ...validBuildingDetails, expectedVersion: 3 },
        'csrf-token',
      );

      expect(result.success).toBe(true);
      // The chained .eq('version', 3) call must have happened.
      expect(mockEq).toHaveBeenCalledWith('version', 3);
    });

    it('returns a "changed in another tab" error when version mismatch', async () => {
      mockSingle
        .mockResolvedValueOnce({ data: { user_id: testUser.id }, error: null })
        .mockResolvedValueOnce({ data: { status: 'draft' }, error: null });
      mockUpdateSelectResult([]);

      const result = await updatePermitBuildingDetails(
        { ...validBuildingDetails, expectedVersion: 3 },
        'csrf-token',
      );

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/another tab/i);
    });
  });

  // ---------------------------------------------------------------------------
  // updatePermitComplianceRequirements
  // ---------------------------------------------------------------------------

  describe('updatePermitComplianceRequirements', () => {
    it('should update compliance requirements for a draft permit', async () => {
      mockSingle
        .mockResolvedValueOnce({ data: { user_id: testUser.id }, error: null })
        .mockResolvedValueOnce({ data: { status: 'draft' }, error: null });

      const result = await updatePermitComplianceRequirements(validComplianceRequirements, 'csrf-token');

      expect(result.success).toBe(true);
    });

    it('should return error when unauthenticated', async () => {
      mockRequireAuth.mockResolvedValue({ success: false, error: 'Not authenticated' });

      const result = await updatePermitComplianceRequirements(validComplianceRequirements, 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Not authenticated');
    });

    it('should deny access for non-owner', async () => {
      mockSingle.mockResolvedValueOnce({ data: { user_id: 'other-user' }, error: null });

      const result = await updatePermitComplianceRequirements(validComplianceRequirements, 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Access denied');
    });

    it('should reject non-draft permits', async () => {
      mockSingle
        .mockResolvedValueOnce({ data: { user_id: testUser.id }, error: null })
        .mockResolvedValueOnce({ data: { status: 'approved' }, error: null });

      const result = await updatePermitComplianceRequirements(validComplianceRequirements, 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Can only edit draft permits');
    });

    it('should reject invalid CSRF token', async () => {
      mockRequireCSRF.mockResolvedValue({ valid: false, error: 'CSRF token invalid' });

      const result = await updatePermitComplianceRequirements(validComplianceRequirements, 'bad-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('CSRF token invalid');
    });
  });

  // ---------------------------------------------------------------------------
  // getPermitHistory
  // ---------------------------------------------------------------------------

  describe('getPermitHistory', () => {
    it('should return history for permit owner', async () => {
      // Mock ownership check
      mockSingle.mockResolvedValueOnce({ data: { user_id: testUser.id }, error: null });
      // Mock history query
      mockOrder.mockReturnValueOnce({
        data: [
          {
            id: 'hist-1',
            permit_id: validUUID,
            from_status: null,
            to_status: 'draft',
            changed_by: testUser.id,
            comment: 'Created',
            created_at: '2024-01-01',
          },
        ],
        error: null,
      });

      const result = await getPermitHistory(validUUID);

      expect(result.data).toHaveLength(1);
      expect(result.data[0].toStatus).toBe('draft');
    });

    it('should return error when not authenticated', async () => {
      mockGetQuickSession.mockResolvedValue(null);

      const result = await getPermitHistory(validUUID);

      expect(result.data).toEqual([]);
      expect(result.error).toBe('Not authenticated');
    });

    it('should reject invalid permit ID', async () => {
      const result = await getPermitHistory('not-a-uuid');

      expect(result.data).toEqual([]);
      expect(result.error).toBe('Invalid permit ID');
    });

    it('should deny access for non-owner', async () => {
      mockSingle.mockResolvedValueOnce({ data: { user_id: 'other-user' }, error: null });

      const result = await getPermitHistory(validUUID);

      expect(result.data).toEqual([]);
      expect(result.error).toBe('Access denied');
    });

    it('should allow admin access without ownership', async () => {
      mockGetQuickSession.mockResolvedValue({ ...testUser, role: 'admin' });
      mockOrder.mockReturnValueOnce({ data: [], error: null });

      const result = await getPermitHistory(validUUID);

      expect(result.error).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // runComplianceCheck
  // ---------------------------------------------------------------------------

  describe('runComplianceCheck', () => {
    it('should run compliance check on draft permit with building details', async () => {
      const complianceResult = {
        overallStatus: 'compliant',
        checks: [],
        summary: 'All checks passed',
      };
      mockCheckPermitCompliance.mockResolvedValue(complianceResult);

      // Mock ownership
      mockSingle
        .mockResolvedValueOnce({ data: { user_id: testUser.id }, error: null })
        // Mock permit data
        .mockResolvedValueOnce({
          data: {
            status: 'draft',
            building_details: { numberOfFloors: 5, totalBuiltUpArea: 2000 },
            compliance_requirements: { fireSafety: true },
            project_type: 'residential',
          },
          error: null,
        })
        // B3 re-check: permit still in draft after the LLM call returned
        .mockResolvedValueOnce({ data: { status: 'draft' }, error: null });

      const result = await runComplianceCheck(validUUID, 'csrf-token');

      expect(result.success).toBe(true);
      expect(result.data).toEqual(complianceResult);
      expect(mockCheckPermitCompliance).toHaveBeenCalled();
    });

    it('discards the result if the permit was submitted while LLM was thinking (B3)', async () => {
      const complianceResult = { overallStatus: 'compliant', checks: [], summary: 'OK' };
      mockCheckPermitCompliance.mockResolvedValue(complianceResult);

      mockSingle
        .mockResolvedValueOnce({ data: { user_id: testUser.id }, error: null })
        .mockResolvedValueOnce({
          data: {
            status: 'draft',
            building_details: { numberOfFloors: 5, totalBuiltUpArea: 2000 },
            compliance_requirements: {},
            project_type: 'residential',
          },
          error: null,
        })
        // Permit transitioned to 'submitted' in another tab while LLM ran
        .mockResolvedValueOnce({ data: { status: 'submitted' }, error: null });

      const result = await runComplianceCheck(validUUID, 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/state changed/i);
    });

    it('should return error when unauthenticated', async () => {
      mockRequireAuth.mockResolvedValue({ success: false, error: 'Not authenticated' });

      const result = await runComplianceCheck(validUUID, 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Not authenticated');
    });

    it('should reject invalid permit ID', async () => {
      const result = await runComplianceCheck('not-a-uuid', 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid permit ID');
    });

    it('should deny access for non-owner', async () => {
      mockSingle.mockResolvedValueOnce({ data: { user_id: 'other-user' }, error: null });

      const result = await runComplianceCheck(validUUID, 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Access denied');
    });

    it('should reject permits without building details', async () => {
      mockSingle
        .mockResolvedValueOnce({ data: { user_id: testUser.id }, error: null })
        .mockResolvedValueOnce({
          data: { status: 'draft', building_details: null, compliance_requirements: {}, project_type: 'residential' },
          error: null,
        });

      const result = await runComplianceCheck(validUUID, 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toContain('building details');
    });

    it('should reject submitted permits', async () => {
      mockSingle
        .mockResolvedValueOnce({ data: { user_id: testUser.id }, error: null })
        .mockResolvedValueOnce({
          data: {
            status: 'submitted',
            building_details: { numberOfFloors: 5, totalBuiltUpArea: 2000 },
            compliance_requirements: {},
            project_type: 'residential',
          },
          error: null,
        });

      const result = await runComplianceCheck(validUUID, 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toContain('draft or revision-requested');
    });
  });

  // ---------------------------------------------------------------------------
  // revisePermit
  // ---------------------------------------------------------------------------

  describe('revisePermit', () => {
    it('should revise a permit with revision_requested status', async () => {
      mockSingle.mockResolvedValueOnce({ data: { user_id: testUser.id }, error: null });
      mockRpc.mockResolvedValueOnce({
        data: [{ status_changed: true, prev_status: 'revision_requested' }],
        error: null,
      });

      const result = await revisePermit(validUUID, 'csrf-token');

      expect(result.success).toBe(true);
      expect(mockRpc).toHaveBeenCalledWith('revise_permit_atomic', {
        p_permit_id: validUUID,
        p_user_id: testUser.id,
      });
    });

    it('should return error when unauthenticated', async () => {
      mockRequireAuth.mockResolvedValue({ success: false, error: 'Not authenticated' });

      const result = await revisePermit(validUUID, 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Not authenticated');
    });

    it('should reject invalid permit ID', async () => {
      const result = await revisePermit('not-a-uuid', 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid permit ID');
    });

    it('should deny access for non-owner', async () => {
      mockSingle.mockResolvedValueOnce({ data: { user_id: 'other-user' }, error: null });

      const result = await revisePermit(validUUID, 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Access denied');
    });

    it('should reject permits not in revision_requested status', async () => {
      mockSingle.mockResolvedValueOnce({ data: { user_id: testUser.id }, error: null });
      mockRpc.mockResolvedValueOnce({
        data: [{ status_changed: false, prev_status: 'draft' }],
        error: null,
      });

      const result = await revisePermit(validUUID, 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toContain('revision requested');
    });

    it('should return error when permit not found', async () => {
      mockSingle.mockResolvedValueOnce({ data: { user_id: testUser.id }, error: null });
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { code: 'P0001', message: 'PERMIT_NOT_FOUND' },
      });

      const result = await revisePermit(validUUID, 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Permit not found');
    });
  });
});
