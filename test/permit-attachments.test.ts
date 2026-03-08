// ============================================================================
// Permit Attachments Server Actions Tests
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock auth
const mockRequireAuth = vi.fn();
const mockRequireCSRF = vi.fn();
vi.mock('@/lib/security', () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
  requireCSRF: (...args: unknown[]) => mockRequireCSRF(...args),
}));

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
const mockLimit = vi.fn();
const mockLt = vi.fn();
const mockIlike = vi.fn();

// Storage mocks
const mockStorageUpload = vi.fn();
const mockStorageRemove = vi.fn();
const mockStorageCreateSignedUrl = vi.fn();
const mockStorageFrom = vi.fn();

function resetChainMocks() {
  mockSingle.mockResolvedValue({ data: null, error: null });
  mockOrder.mockReturnValue({ data: [], error: null });
  mockLimit.mockReturnValue({ data: [], error: null });
  mockLt.mockReturnValue({ data: [], error: null });
  mockIlike.mockReturnValue({ order: mockOrder, limit: mockLimit });
  mockEq.mockReturnValue({ eq: mockEq, single: mockSingle, select: mockSelect, order: mockOrder, delete: mockDelete, limit: mockLimit, ilike: mockIlike, lt: mockLt });
  mockDelete.mockReturnValue({ eq: mockEq, single: mockSingle, error: null });
  mockUpdate.mockReturnValue({ eq: mockEq, single: mockSingle, error: null });
  mockSelect.mockReturnValue({ eq: mockEq, single: mockSingle, order: mockOrder, limit: mockLimit, count: 0 });
  mockInsert.mockReturnValue({ select: mockSelect, single: mockSingle, error: null });
  mockFrom.mockReturnValue({
    select: mockSelect,
    insert: mockInsert,
    update: mockUpdate,
    delete: mockDelete,
    eq: mockEq,
    single: mockSingle,
    order: mockOrder,
    limit: mockLimit,
  });

  mockStorageUpload.mockResolvedValue({ error: null });
  mockStorageRemove.mockResolvedValue({ error: null });
  mockStorageCreateSignedUrl.mockResolvedValue({ data: { signedUrl: 'https://example.com/signed' }, error: null });
  mockStorageFrom.mockReturnValue({
    upload: mockStorageUpload,
    remove: mockStorageRemove,
    createSignedUrl: mockStorageCreateSignedUrl,
  });
}

const mockCheckRateLimit = vi.fn();
vi.mock('@/lib/supabase-server', () => ({
  createServerClient: vi.fn(() => ({
    from: (...args: unknown[]) => mockFrom(...args),
  })),
  createAdminClient: vi.fn(() => ({
    from: (...args: unknown[]) => mockFrom(...args),
    storage: { from: (...args: unknown[]) => mockStorageFrom(...args) },
  })),
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

// Mock file-upload
const mockValidateFile = vi.fn();
const mockGenerateStoragePath = vi.fn();
vi.mock('@/lib/file-upload', () => ({
  validateFile: (...args: unknown[]) => mockValidateFile(...args),
  generateStoragePath: (...args: unknown[]) => mockGenerateStoragePath(...args),
}));

import {
  uploadPermitAttachment,
  deletePermitAttachment,
  getPermitAttachments,
} from '@/actions/permit-attachments';

const testUser = { id: 'user-123', email: 'test@test.com', role: 'user' };
const validUUID = '550e8400-e29b-41d4-a716-446655440000';
const attachmentUUID = '660e8400-e29b-41d4-a716-446655440000';

function createMockFormData(file?: File): FormData {
  const formData = new FormData();
  if (file) {
    formData.append('file', file);
  }
  return formData;
}

describe('Permit Attachments Server Actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChainMocks();
    mockRequireAuth.mockResolvedValue({ success: true, user: testUser });
    mockRequireCSRF.mockResolvedValue({ valid: true });
    mockGetQuickSession.mockResolvedValue(testUser);
    mockCheckRateLimit.mockResolvedValue({ allowed: true });
    mockValidateFile.mockReturnValue({ valid: true });
    mockGenerateStoragePath.mockReturnValue('permits/test/file.pdf');
  });

  // ---------------------------------------------------------------------------
  // uploadPermitAttachment
  // ---------------------------------------------------------------------------

  describe('uploadPermitAttachment', () => {
    it('should return error when unauthenticated', async () => {
      mockRequireAuth.mockResolvedValue({ success: false, error: 'Not authenticated' });

      const formData = createMockFormData();
      const result = await uploadPermitAttachment(validUUID, formData, 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Not authenticated');
    });

    it('should reject invalid CSRF token', async () => {
      mockRequireCSRF.mockResolvedValue({ valid: false, error: 'CSRF token invalid' });

      const formData = createMockFormData();
      const result = await uploadPermitAttachment(validUUID, formData, 'bad-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('CSRF token invalid');
    });

    it('should reject when rate limited', async () => {
      mockCheckRateLimit.mockResolvedValue({ allowed: false });

      const formData = createMockFormData();
      const result = await uploadPermitAttachment(validUUID, formData, 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Too many requests');
    });

    it('should reject invalid permit ID', async () => {
      const formData = createMockFormData();
      const result = await uploadPermitAttachment('not-a-uuid', formData, 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid permit ID');
    });

    it('should deny access for non-owner', async () => {
      mockSingle.mockResolvedValueOnce({ data: { user_id: 'other-user', status: 'draft' }, error: null });

      const formData = createMockFormData();
      const result = await uploadPermitAttachment(validUUID, formData, 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Access denied');
    });

    it('should reject non-draft permits', async () => {
      mockSingle.mockResolvedValueOnce({ data: { user_id: testUser.id, status: 'submitted' }, error: null });

      const formData = createMockFormData();
      const result = await uploadPermitAttachment(validUUID, formData, 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toContain('draft permits');
    });

    it('should reject when no file provided', async () => {
      mockSingle.mockResolvedValueOnce({ data: { user_id: testUser.id, status: 'draft' }, error: null });

      const formData = createMockFormData(); // no file
      const result = await uploadPermitAttachment(validUUID, formData, 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('No file provided');
    });
  });

  // ---------------------------------------------------------------------------
  // deletePermitAttachment
  // ---------------------------------------------------------------------------

  describe('deletePermitAttachment', () => {
    it('should return error when unauthenticated', async () => {
      mockRequireAuth.mockResolvedValue({ success: false, error: 'Not authenticated' });

      const result = await deletePermitAttachment(attachmentUUID, 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Not authenticated');
    });

    it('should reject invalid CSRF token', async () => {
      mockRequireCSRF.mockResolvedValue({ valid: false, error: 'CSRF token invalid' });

      const result = await deletePermitAttachment(attachmentUUID, 'bad-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('CSRF token invalid');
    });

    it('should reject invalid attachment ID', async () => {
      const result = await deletePermitAttachment('not-a-uuid', 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid attachment ID');
    });

    it('should return error when attachment not found', async () => {
      mockSingle.mockResolvedValueOnce({ data: null, error: null });

      const result = await deletePermitAttachment(attachmentUUID, 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Attachment not found');
    });

    it('should deny access for non-owner', async () => {
      mockSingle.mockResolvedValueOnce({
        data: {
          id: attachmentUUID,
          permit_id: validUUID,
          storage_path: 'test/path.pdf',
          file_name: 'test.pdf',
          permit_applications: { user_id: 'other-user', status: 'draft' },
        },
        error: null,
      });

      const result = await deletePermitAttachment(attachmentUUID, 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Access denied');
    });

    it('should reject deleting attachments from non-draft permits', async () => {
      mockSingle.mockResolvedValueOnce({
        data: {
          id: attachmentUUID,
          permit_id: validUUID,
          storage_path: 'test/path.pdf',
          file_name: 'test.pdf',
          permit_applications: { user_id: testUser.id, status: 'submitted' },
        },
        error: null,
      });

      const result = await deletePermitAttachment(attachmentUUID, 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toContain('draft permits');
    });

    it('should delete attachment successfully', async () => {
      mockSingle.mockResolvedValueOnce({
        data: {
          id: attachmentUUID,
          permit_id: validUUID,
          storage_path: 'test/path.pdf',
          file_name: 'test.pdf',
          permit_applications: { user_id: testUser.id, status: 'draft' },
        },
        error: null,
      });

      const result = await deletePermitAttachment(attachmentUUID, 'csrf-token');

      expect(result.success).toBe(true);
      expect(mockStorageRemove).toHaveBeenCalledWith(['test/path.pdf']);
    });
  });

  // ---------------------------------------------------------------------------
  // getPermitAttachments
  // ---------------------------------------------------------------------------

  describe('getPermitAttachments', () => {
    it('should return error when not authenticated', async () => {
      mockGetQuickSession.mockResolvedValue(null);

      const result = await getPermitAttachments(validUUID);

      expect(result.data).toEqual([]);
      expect(result.error).toBe('Not authenticated');
    });

    it('should reject invalid permit ID', async () => {
      const result = await getPermitAttachments('not-a-uuid');

      expect(result.data).toEqual([]);
      expect(result.error).toBe('Invalid permit ID');
    });

    it('should deny access for non-owner', async () => {
      mockSingle.mockResolvedValueOnce({ data: { user_id: 'other-user' }, error: null });

      const result = await getPermitAttachments(validUUID);

      expect(result.data).toEqual([]);
      expect(result.error).toBe('Access denied');
    });

    it('should return attachments with signed URLs for owner', async () => {
      // Mock ownership check
      mockSingle.mockResolvedValueOnce({ data: { user_id: testUser.id }, error: null });

      // Mock attachments query
      mockOrder.mockReturnValueOnce({
        data: [
          {
            id: attachmentUUID,
            permit_id: validUUID,
            file_name: 'test.pdf',
            file_size: 1024,
            file_type: 'application/pdf',
            storage_path: 'test/path.pdf',
            uploaded_by: testUser.id,
            uploaded_at: '2024-01-01',
          },
        ],
        error: null,
      });

      const result = await getPermitAttachments(validUUID);

      expect(result.data).toHaveLength(1);
      expect(result.data[0].fileName).toBe('test.pdf');
      expect(result.data[0].signedUrl).toBe('https://example.com/signed');
    });

    it('should allow admin access without ownership check', async () => {
      mockGetQuickSession.mockResolvedValue({ ...testUser, role: 'admin' });

      mockOrder.mockReturnValueOnce({ data: [], error: null });

      const result = await getPermitAttachments(validUUID);

      expect(result.error).toBeUndefined();
      expect(result.data).toEqual([]);
    });
  });
});
