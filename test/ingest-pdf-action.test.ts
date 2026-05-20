// ============================================================================
// E15 — actions/ingest-pdf.ts coverage
// ============================================================================
// Covers admin guard, CSRF gate, documentId validation, audit logging,
// and the registry-driven branch selection (storage_path vs file_name).
// runIngestionPipeline + tree-cache are mocked so we don't touch real PDFs.
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ----------------------------------------------------------------------------
// Mocks BEFORE module under test imports
// ----------------------------------------------------------------------------

const mockRequireAdmin = vi.fn();
const mockRequireCSRF = vi.fn();

vi.mock('@/lib/security', async () => {
  const actual = await vi.importActual<typeof import('@/lib/security')>('@/lib/security');
  return {
    ...actual,
    requireAdmin: () => mockRequireAdmin(),
    requireCSRF: (token: string) => mockRequireCSRF(token),
  };
});

const mockRunIngestion = vi.fn();
vi.mock('@/lib/pdf-ingestion', () => ({
  runIngestionPipeline: (...args: unknown[]) => mockRunIngestion(...args),
}));

const mockClearTreeCache = vi.fn();
vi.mock('@/lib/tree-cache', () => ({
  clearDocumentTreeCache: (name?: string) => mockClearTreeCache(name),
}));

const mockLogAudit = vi.fn();
const mockGetReqMeta = vi.fn().mockResolvedValue({ ipAddress: '127.0.0.1', userAgent: 'jest' });
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
  return {
    ...actual,
    logAuditEvent: (...args: unknown[]) => mockLogAudit(...args),
    getRequestMetadata: () => mockGetReqMeta(),
  };
});

import { createAdminClient } from '@/lib/supabase-server';
import { ingestPDF, clearDocumentChunks, clearChunks, getIngestionStatus } from '@/actions/ingest-pdf';

const ADMIN = { id: 'admin-1', username: 'admin', role: 'admin' as const };

// Build a flexible chainable mock for the supabase admin client.
interface Chain {
  registryRow?: { data: unknown; error: unknown };
  storageDownload?: { data: unknown; error: unknown };
  rpcResult?: { data: unknown; error: unknown };
  countResult?: { count?: number | null; error?: unknown };
  deleteResult?: { error: unknown };
  updateResult?: { error: unknown };
}

function setupAdminClient(opts: Chain = {}) {
  const single = vi.fn().mockResolvedValue(opts.registryRow ?? { data: null, error: null });
  const eq = vi.fn().mockReturnValue({ single, delete: vi.fn().mockResolvedValue({ error: null }) });
  // For the "select count head" path, the chain ends differently. We model the
  // common chain shape used by the action by returning a chainable proxy.
  const select = vi.fn().mockImplementation((_: string, options?: { count?: string; head?: boolean }) => {
    if (options?.count === 'exact' && options?.head) {
      // Return a thenable that resolves with the count result.
      return Promise.resolve({ count: opts.countResult?.count ?? 0, error: opts.countResult?.error ?? null });
    }
    return {
      eq,
      single,
      limit: vi.fn().mockReturnThis(),
    };
  });

  const deleteFn = vi.fn().mockReturnValue({
    eq: vi.fn().mockResolvedValue({ error: opts.deleteResult?.error ?? null }),
    gte: vi.fn().mockResolvedValue({ error: opts.deleteResult?.error ?? null }),
  });

  const updateFn = vi.fn().mockReturnValue({
    eq: vi.fn().mockResolvedValue({ error: opts.updateResult?.error ?? null }),
  });

  const from = vi.fn().mockReturnValue({
    select,
    delete: deleteFn,
    update: updateFn,
  });

  const rpc = vi.fn().mockResolvedValue(opts.rpcResult ?? { data: null, error: null });

  const storage = {
    from: vi.fn().mockReturnValue({
      download: vi.fn().mockResolvedValue(
        opts.storageDownload ?? { data: null, error: null },
      ),
    }),
  };

  vi.mocked(createAdminClient).mockReturnValue({
    from,
    rpc,
    storage,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

  return { from, rpc, storage, single, deleteFn, updateFn };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue({ success: true, user: ADMIN });
  mockRequireCSRF.mockResolvedValue({ valid: true });
  mockRunIngestion.mockResolvedValue({ success: true, chunksProcessed: 42 });
});

// ============================================================================
// ingestPDF
// ============================================================================

describe('ingestPDF', () => {
  it('rejects when requireAdmin fails', async () => {
    mockRequireAdmin.mockResolvedValueOnce({ success: false, error: 'Not admin' });
    const out = await ingestPDF('doc-a', 'csrf');
    expect(out).toMatchObject({ success: false, error: 'Not admin' });
    expect(mockRunIngestion).not.toHaveBeenCalled();
  });

  it('rejects when CSRF fails', async () => {
    mockRequireCSRF.mockResolvedValueOnce({ valid: false, error: 'Bad CSRF' });
    const out = await ingestPDF('doc-a', 'csrf');
    expect(out).toMatchObject({ success: false, error: 'Bad CSRF' });
  });

  it('rejects empty documentId', async () => {
    const out = await ingestPDF('', 'csrf');
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/Missing documentId/);
  });

  it('rejects unknown documentId (no DB row)', async () => {
    setupAdminClient({ registryRow: { data: null, error: { message: 'not found' } } });
    const out = await ingestPDF('doc-x', 'csrf');
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/Unknown document/);
  });

  it('rejects inactive documentId', async () => {
    setupAdminClient({
      registryRow: {
        data: { file_name: 'a.pdf', is_active: false, storage_path: null, pdf_hash: null },
        error: null,
      },
    });
    const out = await ingestPDF('doc-x', 'csrf');
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/Unknown document/);
  });

  it('uses storage_path branch and runs pipeline with pdfBuffer', async () => {
    // ArrayBuffer-shaped blob
    const blob = {
      arrayBuffer: () => Promise.resolve(new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer),
    };
    setupAdminClient({
      registryRow: {
        data: { file_name: '', is_active: true, storage_path: 'docs/a.pdf', pdf_hash: 'h1' },
        error: null,
      },
      storageDownload: { data: blob, error: null },
    });

    const out = await ingestPDF('doc-a', 'csrf');
    expect(mockRunIngestion).toHaveBeenCalledTimes(1);
    const args = mockRunIngestion.mock.calls[0][0];
    expect(args.documentId).toBe('doc-a');
    expect(args.pdfBuffer).toBeInstanceOf(Uint8Array);
    expect(out.success).toBe(true);
    // Tree cache invalidated on success
    expect(mockClearTreeCache).toHaveBeenCalledWith('doc-a');
    // 2 audit events: started + completed
    expect(mockLogAudit).toHaveBeenCalledTimes(2);
  });

  it('returns error when storage download fails', async () => {
    setupAdminClient({
      registryRow: {
        data: { file_name: '', is_active: true, storage_path: 'docs/a.pdf', pdf_hash: null },
        error: null,
      },
      storageDownload: { data: null, error: { message: 'object not found' } },
    });
    const out = await ingestPDF('doc-a', 'csrf');
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/Failed to download PDF/);
    expect(mockRunIngestion).not.toHaveBeenCalled();
  });

  it('uses public/ fallback branch when storage_path is absent', async () => {
    setupAdminClient({
      registryRow: {
        data: { file_name: 'building-code.pdf', is_active: true, storage_path: null, pdf_hash: null },
        error: null,
      },
    });
    const out = await ingestPDF('doc-a', 'csrf');
    expect(out.success).toBe(true);
    const args = mockRunIngestion.mock.calls[0][0];
    expect(args.pdfPath).toBe('public/building-code.pdf');
    expect(args.pdfBuffer).toBeUndefined();
  });

  it('rejects unsafe file names in public/ fallback', async () => {
    setupAdminClient({
      registryRow: {
        data: { file_name: '../etc/passwd', is_active: true, storage_path: null, pdf_hash: null },
        error: null,
      },
    });
    const out = await ingestPDF('doc-a', 'csrf');
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/No PDF uploaded/);
    expect(mockRunIngestion).not.toHaveBeenCalled();
  });
});

// ============================================================================
// clearDocumentChunks
// ============================================================================

describe('clearDocumentChunks', () => {
  it('rejects unauthenticated callers', async () => {
    mockRequireAdmin.mockResolvedValueOnce({ success: false, error: 'auth' });
    const out = await clearDocumentChunks('doc-a', 'csrf');
    expect(out.success).toBe(false);
  });

  it('rejects bad CSRF', async () => {
    mockRequireCSRF.mockResolvedValueOnce({ valid: false, error: 'csrf bad' });
    const out = await clearDocumentChunks('doc-a', 'csrf');
    expect(out.success).toBe(false);
  });

  it('uses RPC when available and returns deleted count', async () => {
    setupAdminClient({ rpcResult: { data: 25, error: null } });
    const out = await clearDocumentChunks('doc-a', 'csrf');
    expect(out).toMatchObject({ success: true, deletedCount: 25 });
    expect(mockClearTreeCache).toHaveBeenCalledWith('doc-a');
  });
});

// ============================================================================
// clearChunks (legacy)
// ============================================================================

describe('clearChunks', () => {
  it('rejects when not admin', async () => {
    mockRequireAdmin.mockResolvedValueOnce({ success: false, error: 'no' });
    const out = await clearChunks('csrf');
    expect(out.success).toBe(false);
  });

  it('returns success immediately when count is 0', async () => {
    setupAdminClient({ countResult: { count: 0, error: null } });
    const out = await clearChunks('csrf');
    expect(out.success).toBe(true);
  });

  it('reports count error', async () => {
    setupAdminClient({ countResult: { error: { message: 'no table' } } });
    const out = await clearChunks('csrf');
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/Access error/);
  });
});

// ============================================================================
// getIngestionStatus
// ============================================================================

describe('getIngestionStatus', () => {
  it('rejects unauthenticated callers', async () => {
    mockRequireAdmin.mockResolvedValueOnce({ success: false, error: 'no' });
    const out = await getIngestionStatus();
    expect(out.dbConnected).toBe(false);
    expect(out.hasChunks).toBe(false);
  });

  it('returns hasChunks=false on empty table', async () => {
    setupAdminClient({ countResult: { count: 0, error: null } });
    const out = await getIngestionStatus();
    expect(out.dbConnected).toBe(true);
    expect(out.hasChunks).toBe(false);
    expect(out.chunkCount).toBe(0);
  });

  it('returns documentStats from the RPC when present', async () => {
    setupAdminClient({
      countResult: { count: 7, error: null },
      rpcResult: {
        data: [
          { document_name: 'doc-a', chunk_count: 5, min_page: 1, max_page: 30 },
          { document_name: 'doc-b', chunk_count: 2, min_page: 1, max_page: 8 },
        ],
        error: null,
      },
    });
    const out = await getIngestionStatus();
    expect(out.dbConnected).toBe(true);
    expect(out.hasChunks).toBe(true);
    expect(out.chunkCount).toBe(7);
    expect(out.documentStats).toHaveLength(2);
  });
});
