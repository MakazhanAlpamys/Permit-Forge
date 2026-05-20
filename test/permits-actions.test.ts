// ============================================================================
// Permits Server Actions Tests
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
}

vi.mock('@/lib/supabase-server', () => ({
  createServerClient: vi.fn(() => ({
    from: (...args: unknown[]) => mockFrom(...args),
  })),
  createAdminClient: vi.fn(() => ({
    from: (...args: unknown[]) => mockFrom(...args),
    storage: { from: vi.fn().mockReturnValue({ remove: vi.fn().mockResolvedValue({}) }) },
  })),
  // A2: user-context client returns the same chainable mock.
  createUserContextClient: vi.fn(async () => ({
    from: (...args: unknown[]) => mockFrom(...args),
  })),
}));

// Mock notifications
const mockCreateNotification = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/notifications', () => ({
  createNotification: (...args: unknown[]) => mockCreateNotification(...args),
  getNotificationContent: vi.fn().mockReturnValue({ title: 'Test', body: 'Test notification' }),
}));

import {
  createPermit,
  submitPermit,
  getMyPermits,
  getPermitById,
  deletePermit,
} from '@/actions/permits';

const validPermitData = {
  projectName: 'Test Building',
  projectType: 'residential' as const,
  projectAddress: '123 Main Street',
};

const testUser = { id: 'user-123', email: 'test@test.com', role: 'user' };
const validUUID = '550e8400-e29b-41d4-a716-446655440000';

describe('Permits Server Actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChainMocks();
    mockRequireAuth.mockResolvedValue({ success: true, user: testUser });
    mockRequireCSRF.mockResolvedValue({ valid: true });
    mockGetQuickSession.mockResolvedValue(testUser);
  });

  // ---------------------------------------------------------------------------
  // createPermit
  // ---------------------------------------------------------------------------

  describe('createPermit', () => {
    it('should create a permit with valid data', async () => {
      // Mock the insert → select → single chain to return a permit ID
      const permitId = validUUID;
      mockSingle.mockResolvedValueOnce({ data: { id: permitId }, error: null });

      const result = await createPermit(validPermitData, 'csrf-token');

      expect(result.success).toBe(true);
      expect(result.permitId).toBe(permitId);
      expect(mockFrom).toHaveBeenCalledWith('permit_applications');
    });

    it('should return error when unauthenticated', async () => {
      mockRequireAuth.mockResolvedValue({ success: false, error: 'Not authenticated' });

      const result = await createPermit(validPermitData, 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Not authenticated');
    });

    it('should validate input data', async () => {
      const result = await createPermit({
        projectName: 'AB', // too short (min 3)
        projectType: 'residential' as const,
        projectAddress: '123 Main Street',
      }, 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should reject invalid project type', async () => {
      const result = await createPermit({
        projectName: 'Test Building',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        projectType: 'invalid_type' as any,
        projectAddress: '123 Main Street',
      }, 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should validate CSRF token when provided', async () => {
      mockSingle.mockResolvedValueOnce({ data: { id: validUUID }, error: null });

      await createPermit(validPermitData, 'csrf-token-123');

      expect(mockRequireCSRF).toHaveBeenCalledWith('csrf-token-123');
    });

    it('should reject invalid CSRF token', async () => {
      mockRequireCSRF.mockResolvedValue({ valid: false, error: 'CSRF token invalid' });

      const result = await createPermit(validPermitData, 'bad-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('CSRF token invalid');
    });
  });

  // ---------------------------------------------------------------------------
  // submitPermit
  // ---------------------------------------------------------------------------

  describe('submitPermit', () => {
    it('should submit a draft permit with complete building details', async () => {
      // Mock ownership check: verifyPermitOwnership returns true
      mockSingle
        .mockResolvedValueOnce({ data: { user_id: testUser.id }, error: null }) // ownership
        .mockResolvedValueOnce({
          data: {
            status: 'draft',
            building_details: {
              numberOfFloors: 5,
              totalBuiltUpArea: 2000,
              plotArea: 1000,
              buildingHeight: 20,
            },
            compliance_requirements: { fireSafety: true },
            project_name: 'Test Building',
            revision_count: 0,
          },
          error: null,
        }); // permit data

      const result = await submitPermit(validUUID, 'csrf-token');

      expect(result.success).toBe(true);
    });

    it('should return error when unauthenticated', async () => {
      mockRequireAuth.mockResolvedValue({ success: false, error: 'Not authenticated' });

      const result = await submitPermit(validUUID, 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Not authenticated');
    });

    it('should reject invalid permit ID', async () => {
      const result = await submitPermit('not-a-uuid', 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid permit ID');
    });

    it('should deny access for non-owner', async () => {
      // Return a different user_id for ownership check
      mockSingle.mockResolvedValueOnce({
        data: { user_id: 'other-user-id' },
        error: null,
      });

      const result = await submitPermit(validUUID, 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Access denied');
    });

    // B8: notification dispatch failure must not roll back submit, but it
    // must surface a warning so the client can flash it.
    it('should still succeed but surface a warning when notification dispatch fails', async () => {
      mockSingle
        .mockResolvedValueOnce({ data: { user_id: testUser.id }, error: null })
        .mockResolvedValueOnce({
          data: {
            status: 'draft',
            building_details: {
              numberOfFloors: 5,
              totalBuiltUpArea: 2000,
              plotArea: 1000,
              buildingHeight: 20,
            },
            compliance_requirements: { fireSafety: true },
            project_name: 'Test Building',
            revision_count: 0,
          },
          error: null,
        });

      mockCreateNotification.mockRejectedValueOnce(new Error('SMTP outage'));

      const result = await submitPermit(validUUID, 'csrf-token');

      expect(result.success).toBe(true);
      expect(result.warning).toBeDefined();
      expect(result.warning).toMatch(/notification/i);
    });
  });

  // ---------------------------------------------------------------------------
  // getMyPermits
  // ---------------------------------------------------------------------------

  describe('getMyPermits', () => {
    it('should return permits for authenticated user', async () => {
      const mockPermits = [
        {
          id: validUUID,
          user_id: testUser.id,
          status: 'draft',
          project_name: 'Test',
          project_type: 'residential',
          project_address: '123 Main St',
          plot_number: null,
          project_description: null,
          building_details: {},
          compliance_requirements: {},
          compliance_check_result: null,
          reviewed_by: null,
          reviewed_at: null,
          review_comments: null,
          submitted_at: null,
          revision_count: 0,
          revision_notes: null,
          created_at: '2024-01-01',
          updated_at: '2024-01-01',
        },
      ];
      mockOrder.mockReturnValueOnce({ data: mockPermits, error: null });

      const result = await getMyPermits();

      expect(result.data).toHaveLength(1);
      expect(result.data[0].projectName).toBe('Test');
      expect(result.error).toBeUndefined();
    });

    it('should return empty array when not authenticated', async () => {
      mockGetQuickSession.mockResolvedValue(null);

      const result = await getMyPermits();

      expect(result.data).toEqual([]);
      expect(result.error).toBe('Not authenticated');
    });
  });

  // ---------------------------------------------------------------------------
  // getPermitById
  // ---------------------------------------------------------------------------

  describe('getPermitById', () => {
    it('should return permit for owner', async () => {
      mockSingle.mockResolvedValueOnce({
        data: {
          id: validUUID,
          user_id: testUser.id,
          status: 'draft',
          project_name: 'Test',
          project_type: 'residential',
          project_address: '123 Main St',
          building_details: {},
          compliance_requirements: {},
          created_at: '2024-01-01',
          updated_at: '2024-01-01',
        },
        error: null,
      });

      const result = await getPermitById(validUUID);

      expect(result.data).not.toBeNull();
      expect(result.data?.projectName).toBe('Test');
    });

    it('should return error for invalid UUID', async () => {
      const result = await getPermitById('not-a-uuid');

      expect(result.data).toBeNull();
      expect(result.error).toBe('Invalid permit ID');
    });

    it('should return error when not authenticated', async () => {
      mockGetQuickSession.mockResolvedValue(null);

      const result = await getPermitById(validUUID);

      expect(result.data).toBeNull();
      expect(result.error).toBe('Not authenticated');
    });
  });

  // ---------------------------------------------------------------------------
  // deletePermit
  // ---------------------------------------------------------------------------

  describe('deletePermit', () => {
    it('should reject invalid permit ID', async () => {
      const result = await deletePermit('not-a-uuid', 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid permit ID');
    });

    it('should deny access for non-owner', async () => {
      // Return different user_id
      mockSingle.mockResolvedValueOnce({
        data: { user_id: 'other-user' },
        error: null,
      });

      const result = await deletePermit(validUUID, 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Access denied');
    });

    it('should return error when unauthenticated', async () => {
      mockRequireAuth.mockResolvedValue({ success: false, error: 'Not authenticated' });

      const result = await deletePermit(validUUID, 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Not authenticated');
    });
  });
});
