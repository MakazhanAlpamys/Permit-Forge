// ============================================================================
// Document Registry Server Actions Tests
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock auth
const mockRequireAdmin = vi.fn();
const mockRequireCSRF = vi.fn();
vi.mock('@/lib/security', () => ({
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
  requireCSRF: (...args: unknown[]) => mockRequireCSRF(...args),
}));

const mockLogAuditEvent = vi.fn().mockResolvedValue(undefined);
const mockGetRequestMetadata = vi.fn().mockResolvedValue({ ip: '127.0.0.1', userAgent: 'test' });
vi.mock('@/lib/auth', () => ({
  logAuditEvent: (...args: unknown[]) => mockLogAuditEvent(...args),
  getRequestMetadata: (...args: unknown[]) => mockGetRequestMetadata(...args),
  // v1.8.0 Part B: delegate to existing mocks so audit-event assertions still fire.
  logAuditWithMeta: async (
    userId: string,
    action: string,
    extras?: { targetUserId?: string; metadata?: Record<string, unknown> },
  ) => {
    const meta = await mockGetRequestMetadata();
    return mockLogAuditEvent({
      userId,
      action,
      targetUserId: extras?.targetUserId,
      metadata: extras?.metadata,
      ...meta,
    });
  },
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
const mockRpc = vi.fn();
const mockUpsert = vi.fn();

// Storage mocks
const mockStorageUpload = vi.fn();
const mockStorageRemove = vi.fn();
const mockStorageFrom = vi.fn();

function resetChainMocks() {
  mockSingle.mockResolvedValue({ data: null, error: null });
  mockOrder.mockReturnValue({ data: [], error: null });
  mockEq.mockReturnValue({ eq: mockEq, single: mockSingle, select: mockSelect, order: mockOrder, delete: mockDelete });
  mockDelete.mockReturnValue({ eq: mockEq, single: mockSingle, error: null });
  mockUpdate.mockReturnValue({ eq: mockEq, single: mockSingle, error: null });
  mockSelect.mockReturnValue({ eq: mockEq, single: mockSingle, order: mockOrder });
  mockInsert.mockReturnValue({ select: mockSelect, single: mockSingle, error: null });
  mockUpsert.mockReturnValue({ error: null });
  mockRpc.mockResolvedValue({ data: [], error: null });
  mockFrom.mockReturnValue({
    select: mockSelect,
    insert: mockInsert,
    update: mockUpdate,
    delete: mockDelete,
    upsert: mockUpsert,
    eq: mockEq,
    single: mockSingle,
    order: mockOrder,
  });

  mockStorageUpload.mockResolvedValue({ error: null });
  mockStorageRemove.mockResolvedValue({ error: null });
  mockStorageFrom.mockReturnValue({
    upload: mockStorageUpload,
    remove: mockStorageRemove,
  });
}

vi.mock('@/lib/supabase-server', () => ({
  createServerClient: vi.fn(() => ({
    from: (...args: unknown[]) => mockFrom(...args),
    rpc: (...args: unknown[]) => mockRpc(...args),
  })),
  createAdminClient: vi.fn(() => ({
    from: (...args: unknown[]) => mockFrom(...args),
    rpc: (...args: unknown[]) => mockRpc(...args),
    storage: { from: (...args: unknown[]) => mockStorageFrom(...args) },
  })),
}));

// Mock document-registry
const mockInvalidateRegistryCache = vi.fn();
vi.mock('@/lib/document-registry', () => ({
  invalidateRegistryCache: (...args: unknown[]) => mockInvalidateRegistryCache(...args),
}));

// Mock document-selector
const mockInvalidateProfileCache = vi.fn();
vi.mock('@/lib/document-selector', () => ({
  invalidateProfileCache: (...args: unknown[]) => mockInvalidateProfileCache(...args),
}));

// Mock tree-cache
const mockClearDocumentTreeCache = vi.fn();
vi.mock('@/lib/tree-cache', () => ({
  clearDocumentTreeCache: (...args: unknown[]) => mockClearDocumentTreeCache(...args),
}));

// v1.7.0 Part B: centralized invalidator now delegates to the three above.
// Mock it directly so callers go through one place; the inner three mocks
// stay around so callsites (lib/pdf-ingestion, lib/document-pdf-upload, etc.)
// that still import them are also covered.
const mockInvalidateAllDocumentCaches = vi.fn((..._args: unknown[]) => {
  mockInvalidateRegistryCache();
  mockInvalidateProfileCache();
  mockClearDocumentTreeCache();
});
vi.mock('@/lib/document-cache', () => ({
  invalidateAllDocumentCaches: (...args: unknown[]) => mockInvalidateAllDocumentCaches(...args),
}));

import {
  getAllRegisteredDocuments,
  upsertDocument,
  deleteDocument,
  restoreDocument,
  uploadDocumentPDF,
  checkPdfReingest,
} from '@/actions/documents';

const adminUser = { id: 'admin-123', email: 'admin@test.com', role: 'admin' };

describe('Document Registry Server Actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChainMocks();
    mockRequireAdmin.mockResolvedValue({ success: true, user: adminUser });
    mockRequireCSRF.mockResolvedValue({ valid: true });
  });

  // ---------------------------------------------------------------------------
  // getAllRegisteredDocuments
  // ---------------------------------------------------------------------------

  describe('getAllRegisteredDocuments', () => {
    it('should return documents via RPC', async () => {
      mockRpc.mockResolvedValueOnce({
        data: [
          {
            id: 'doc-1',
            display_name: 'Test Doc',
            short_name: 'TD',
            file_name: 'test.pdf',
            storage_path: null,
            source_url: '',
            authority: 'Test Authority',
            description: 'A test document',
            badge_color: 'bg-gray-500',
            keywords: ['test'],
            categories: ['general'],
            is_active: true,
            created_at: '2024-01-01',
            updated_at: '2024-01-01',
          },
        ],
        error: null,
      });

      const result = await getAllRegisteredDocuments();

      expect(result.data).toHaveLength(1);
      expect(result.data[0].displayName).toBe('Test Doc');
    });

    it('should return error when not admin', async () => {
      mockRequireAdmin.mockResolvedValue({ success: false, error: 'Unauthorized' });

      const result = await getAllRegisteredDocuments();

      expect(result.data).toEqual([]);
      expect(result.error).toBe('Unauthorized');
    });

    it('surfaces RPC errors instead of silently falling back (F8)', async () => {
      mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'RPC not found' } });

      const result = await getAllRegisteredDocuments();

      expect(result.data).toEqual([]);
      expect(result.error).toBe('RPC not found');
    });
  });

  // ---------------------------------------------------------------------------
  // upsertDocument
  // ---------------------------------------------------------------------------

  describe('upsertDocument', () => {
    const validInput = {
      id: 'test-doc',
      displayName: 'Test Document',
      shortName: 'TD',
      fileName: 'test.pdf',
    };

    it('should upsert document successfully via RPC', async () => {
      mockRpc.mockResolvedValueOnce({ error: null });

      const result = await upsertDocument(validInput, 'csrf-token');

      expect(result.success).toBe(true);
      expect(mockInvalidateRegistryCache).toHaveBeenCalled();
      expect(mockInvalidateProfileCache).toHaveBeenCalled();
    });

    it('should return error when not admin', async () => {
      mockRequireAdmin.mockResolvedValue({ success: false, error: 'Unauthorized' });

      const result = await upsertDocument(validInput, 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unauthorized');
    });

    it('should reject invalid CSRF token', async () => {
      mockRequireCSRF.mockResolvedValue({ valid: false, error: 'CSRF token invalid' });

      const result = await upsertDocument(validInput, 'bad-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('CSRF token invalid');
    });

    it('should reject missing required fields', async () => {
      const result = await upsertDocument({
        id: '',
        displayName: '',
        shortName: 'TD',
        fileName: 'test.pdf',
      }, 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Missing required fields');
    });

    it('surfaces RPC errors instead of silently falling back (F8)', async () => {
      mockRpc.mockResolvedValueOnce({ error: { message: 'RPC not found' } });

      const result = await upsertDocument(validInput, 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('RPC not found');
    });

    it('should sanitize document ID', async () => {
      mockRpc.mockResolvedValueOnce({ error: null });

      await upsertDocument({ ...validInput, id: 'Test Doc ID!' }, 'csrf-token');

      expect(mockRpc).toHaveBeenCalledWith('upsert_document', expect.objectContaining({
        p_id: 'test-doc-id-',
      }));
    });

    // -------------------------------------------------------------------------
    // CP-C-4 (v1.2.0 Part B): refuse to silently overwrite a soft-deleted row.
    // -------------------------------------------------------------------------

    it('refuses to overwrite a soft-deleted row and surfaces a structured code', async () => {
      // pre-check finds an existing inactive row
      mockSingle.mockResolvedValueOnce({ data: { id: 'test-doc', is_active: false }, error: null });

      const result = await upsertDocument(validInput, 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.code).toBe('soft_deleted');
      // RPC must NOT have been called when the collision is detected
      expect(mockRpc).not.toHaveBeenCalledWith('upsert_document', expect.anything());
    });

    it('allows upsert when the existing row is active (update path)', async () => {
      mockSingle.mockResolvedValueOnce({ data: { id: 'test-doc', is_active: true }, error: null });
      mockRpc.mockResolvedValueOnce({ error: null });

      const result = await upsertDocument(validInput, 'csrf-token');

      expect(result.success).toBe(true);
      expect(mockRpc).toHaveBeenCalledWith('upsert_document', expect.anything());
    });

    it('proceeds with create when no existing row is found', async () => {
      mockSingle.mockResolvedValueOnce({ data: null, error: { code: 'PGRST116' } });
      mockRpc.mockResolvedValueOnce({ error: null });

      const result = await upsertDocument(validInput, 'csrf-token');

      expect(result.success).toBe(true);
      expect(mockRpc).toHaveBeenCalledWith('upsert_document', expect.anything());
    });
  });

  // ---------------------------------------------------------------------------
  // deleteDocument
  // ---------------------------------------------------------------------------

  describe('deleteDocument', () => {
    it('should soft delete document via RPC', async () => {
      mockRpc.mockResolvedValueOnce({ error: null });

      const result = await deleteDocument('test-doc', false, 'csrf-token');

      expect(result.success).toBe(true);
      expect(mockInvalidateRegistryCache).toHaveBeenCalled();
      expect(mockInvalidateProfileCache).toHaveBeenCalled();
    });

    it('should return error when not admin', async () => {
      mockRequireAdmin.mockResolvedValue({ success: false, error: 'Unauthorized' });

      const result = await deleteDocument('test-doc', false, 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unauthorized');
    });

    it('should reject invalid CSRF token', async () => {
      mockRequireCSRF.mockResolvedValue({ valid: false, error: 'CSRF token invalid' });

      const result = await deleteDocument('test-doc', false, 'bad-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('CSRF token invalid');
    });

    it('should reject missing documentId', async () => {
      const result = await deleteDocument('', false, 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid documentId');
    });

    it('should clear chunks when requested', async () => {
      // RPC for soft delete
      mockRpc
        .mockResolvedValueOnce({ error: null })
        // RPC for clear_document_chunks
        .mockResolvedValueOnce({ error: null });

      // Mock storage path lookup for PDF deletion
      mockSingle.mockResolvedValueOnce({ data: { storage_path: 'documents/test-doc/file.pdf' }, error: null });

      const result = await deleteDocument('test-doc', true, 'csrf-token');

      expect(result.success).toBe(true);
      // v1.7.0 Part B: centralized helper scopes the tree-cache eviction
      // to the deleted document's id.
      expect(mockInvalidateAllDocumentCaches).toHaveBeenCalledWith('test-doc');
    });
  });

  // ---------------------------------------------------------------------------
  // restoreDocument
  // ---------------------------------------------------------------------------

  describe('restoreDocument', () => {
    it('should restore a soft-deleted document', async () => {
      const result = await restoreDocument('test-doc', 'csrf-token');

      expect(result.success).toBe(true);
      // v1.7.0 Part B: centralized helper is the only invalidation throat.
      expect(mockInvalidateAllDocumentCaches).toHaveBeenCalledWith('test-doc');
    });

    it('should return error when not admin', async () => {
      mockRequireAdmin.mockResolvedValue({ success: false, error: 'Unauthorized' });

      const result = await restoreDocument('test-doc', 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unauthorized');
    });

    it('should reject invalid CSRF token', async () => {
      mockRequireCSRF.mockResolvedValue({ valid: false, error: 'CSRF token invalid' });

      const result = await restoreDocument('test-doc', 'bad-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('CSRF token invalid');
    });

    it('should return error on DB failure', async () => {
      mockUpdate.mockReturnValueOnce({ eq: vi.fn().mockReturnValue({ error: { message: 'DB error' } }) });

      const result = await restoreDocument('test-doc', 'csrf-token');

      expect(result.success).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // uploadDocumentPDF
  // ---------------------------------------------------------------------------

  describe('uploadDocumentPDF', () => {
    function createPDFFormData(): FormData {
      const formData = new FormData();
      const file = new File(['%PDF-1.4 content'], 'test.pdf', { type: 'application/pdf' });
      formData.append('file', file);
      return formData;
    }

    it('should upload PDF successfully', async () => {
      const result = await uploadDocumentPDF('test-doc', createPDFFormData(), 'csrf-token');

      expect(result.success).toBe(true);
      expect(result.storagePath).toBeDefined();
      expect(mockStorageUpload).toHaveBeenCalled();
      expect(mockInvalidateRegistryCache).toHaveBeenCalled();
    });

    it('should return error when not admin', async () => {
      mockRequireAdmin.mockResolvedValue({ success: false, error: 'Unauthorized' });

      const result = await uploadDocumentPDF('test-doc', createPDFFormData(), 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unauthorized');
    });

    it('should reject invalid CSRF token', async () => {
      mockRequireCSRF.mockResolvedValue({ valid: false, error: 'CSRF token invalid' });

      const result = await uploadDocumentPDF('test-doc', createPDFFormData(), 'bad-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('CSRF token invalid');
    });

    it('should reject missing documentId', async () => {
      const result = await uploadDocumentPDF('', createPDFFormData(), 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid documentId');
    });

    it('should reject when no file provided', async () => {
      const formData = new FormData();
      const result = await uploadDocumentPDF('test-doc', formData, 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toBe('No file provided');
    });

    it('should reject non-PDF files', async () => {
      const formData = new FormData();
      const file = new File(['content'], 'test.txt', { type: 'text/plain' });
      formData.append('file', file);

      const result = await uploadDocumentPDF('test-doc', formData, 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toContain('PDF');
    });

    it('should return error on storage upload failure', async () => {
      mockStorageUpload.mockResolvedValueOnce({ error: { message: 'Storage full' } });

      const result = await uploadDocumentPDF('test-doc', createPDFFormData(), 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Upload failed');
    });

    it('should return error on DB update failure', async () => {
      mockUpdate.mockReturnValueOnce({ eq: vi.fn().mockReturnValue({ error: { message: 'DB error' } }) });

      const result = await uploadDocumentPDF('test-doc', createPDFFormData(), 'csrf-token');

      expect(result.success).toBe(false);
      expect(result.error).toContain('DB update failed');
    });

    // B5: the upload response now exposes the SHA-256 of the file and the
    // previous stored hash so the client can prompt before re-ingesting.
    it('should return computed pdfHash and previousPdfHash', async () => {
      // First single() = read prior hash; return an existing value.
      mockSingle.mockResolvedValueOnce({ data: { pdf_hash: 'older-hash-deadbeef' }, error: null });

      const result = await uploadDocumentPDF('test-doc', createPDFFormData(), 'csrf-token');

      expect(result.success).toBe(true);
      expect(result.pdfHash).toMatch(/^[a-f0-9]{64}$/);
      expect(result.previousPdfHash).toBe('older-hash-deadbeef');
    });
  });

  // ---------------------------------------------------------------------------
  // checkPdfReingest (B5)
  // ---------------------------------------------------------------------------

  describe('checkPdfReingest', () => {
    function setHashes(pdf_hash: string | null, last_ingested_pdf_hash: string | null) {
      mockSingle.mockResolvedValueOnce({ data: { pdf_hash, last_ingested_pdf_hash }, error: null });
    }

    function setChunkCount(count: number) {
      // The hash lookup also walks through mockEq once (single() chain), so we
      // route the second eq() invocation — the count query — to the count
      // result. mockReturnValueOnce alone fires on the *first* call, which
      // would clobber the hash lookup chain.
      let callCount = 0;
      mockEq.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return { eq: mockEq, single: mockSingle, select: mockSelect, order: mockOrder, delete: mockDelete };
        }
        return { count, data: null, error: null };
      });
    }

    it('reports hashChanged=true when uploaded PDF differs from last ingest and chunks exist', async () => {
      setHashes('new-hash', 'old-hash');
      setChunkCount(42);

      const result = await checkPdfReingest('test-doc');

      expect(result.hashChanged).toBe(true);
      expect(result.chunkCount).toBe(42);
      expect(result.pdfHash).toBe('new-hash');
      expect(result.lastIngestedPdfHash).toBe('old-hash');
    });

    it('reports hashChanged=false when the hashes match', async () => {
      setHashes('same-hash', 'same-hash');
      setChunkCount(10);

      const result = await checkPdfReingest('test-doc');

      expect(result.hashChanged).toBe(false);
    });

    it('reports hashChanged=false on first-time ingest (last_ingested is null)', async () => {
      setHashes('uploaded-hash', null);
      setChunkCount(0);

      const result = await checkPdfReingest('test-doc');

      expect(result.hashChanged).toBe(false);
      expect(result.chunkCount).toBe(0);
    });

    it('rejects malformed documentId', async () => {
      const result = await checkPdfReingest('Bad ID Spaces!');

      expect(result.error).toBe('Invalid documentId');
    });

    it('rejects non-admin callers', async () => {
      mockRequireAdmin.mockResolvedValue({ success: false, error: 'Admin required' });

      const result = await checkPdfReingest('test-doc');

      expect(result.error).toBe('Admin required');
    });
  });
});
