// ============================================================================
// E15 — actions/ingest-pdf.ts coverage
// ============================================================================
// Covers admin guard, CSRF gate, audit logging, and the document-status /
// clear-document helpers. (F27 removed the deprecated `ingestPDF` /
// `clearChunks` actions; ingestion now flows through `/api/ingest`.)
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
import { clearDocumentChunks, getIngestionStatus, testRAGQuery } from '@/actions/ingest-pdf';

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
  // For the "select count head" path, the chain ends differently. The action
  // either awaits the select directly (getIngestionStatus / testRAGQuery) OR
  // chains `.eq(...)` on top (clearDocumentChunks fallback). We return a
  // thenable that supports both — directly awaitable, AND `.eq()` resolves
  // with the same count payload.
  const countResolved = {
    count: opts.countResult?.count ?? 0,
    error: opts.countResult?.error ?? null,
  };
  const select = vi.fn().mockImplementation((_: string, options?: { count?: string; head?: boolean }) => {
    if (options?.count === 'exact' && options?.head) {
      const thenable = {
        then: (resolve: (v: typeof countResolved) => void) => resolve(countResolved),
        eq: vi.fn().mockResolvedValue(countResolved),
      };
      return thenable;
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

  it('rejects when documentId is empty', async () => {
    const out = await clearDocumentChunks('', 'csrf');
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/Missing documentId/);
  });

  // COV-C-2 (v1.4.0 Part B): when the RPC is unavailable the action falls
  // back to a direct DELETE + count query. Critical: future schema migration
  // that drops the RPC must not silently 0-clear chunks.
  it('falls back to direct DELETE when clear_document_chunks RPC errors and reports counted rows', async () => {
    setupAdminClient({
      rpcResult: { data: null, error: { message: 'function does not exist' } },
      countResult: { count: 12, error: null },
      deleteResult: { error: null },
    });

    const out = await clearDocumentChunks('doc-a', 'csrf');
    expect(out).toMatchObject({ success: true, deletedCount: 12 });
    expect(mockClearTreeCache).toHaveBeenCalledWith('doc-a');
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'chunks_cleared',
      metadata: expect.objectContaining({ documentId: 'doc-a', chunksCleared: 12 }),
    }));
  });

  it('surfaces the DELETE error when the fallback delete itself fails', async () => {
    setupAdminClient({
      rpcResult: { data: null, error: { message: 'no rpc' } },
      countResult: { count: 5, error: null },
      deleteResult: { error: { message: 'permission denied' } },
    });

    const out = await clearDocumentChunks('doc-a', 'csrf');
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/permission denied/);
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

// ============================================================================
// COV-C-2 (v1.4.0 Part B) — testRAGQuery
// ============================================================================
// Helper that the admin "Test RAG" button calls. Previously fully uncovered.
// We verify auth + the four early-return branches + the happy path.

describe('testRAGQuery', () => {
  // Specialised builder — testRAGQuery uses select-count, .single() for sample,
  // and rpc('match_dubai_code_hybrid'). The default `setupAdminClient` doesn't
  // model the .limit().single() chain, so we inline a minimal one here.
  function setupRAGClient(opts: {
    count?: { count?: number | null; error?: unknown };
    rpcError?: { message: string } | null;
    sample?: { data: unknown; error: unknown };
  }) {
    const sampleSingle = vi.fn().mockResolvedValue(opts.sample ?? { data: null, error: null });
    const limit = vi.fn().mockReturnValue({ single: sampleSingle });
    const select = vi.fn().mockImplementation((_: string, options?: { count?: string; head?: boolean }) => {
      if (options?.count === 'exact' && options?.head) {
        return Promise.resolve({ count: opts.count?.count ?? 0, error: opts.count?.error ?? null });
      }
      return { limit, single: sampleSingle };
    });
    const from = vi.fn().mockReturnValue({ select });
    const rpc = vi.fn().mockResolvedValue({ data: null, error: opts.rpcError ?? null });

    vi.mocked(createAdminClient).mockReturnValue({
      from,
      rpc,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    return { from, select, rpc };
  }

  it('rejects unauthenticated callers', async () => {
    mockRequireAdmin.mockResolvedValueOnce({ success: false, error: 'auth' });
    const out = await testRAGQuery();
    expect(out.success).toBe(false);
    expect(out.chunksFound).toBe(0);
  });

  it('surfaces count error before attempting the hybrid RPC', async () => {
    setupRAGClient({ count: { count: null, error: { message: 'relation missing' } } });
    const out = await testRAGQuery();
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/relation missing/);
  });

  it('returns success=true with a help message when the table is empty', async () => {
    setupRAGClient({ count: { count: 0, error: null } });
    const out = await testRAGQuery();
    expect(out.success).toBe(true);
    expect(out.chunksFound).toBe(0);
    expect(out.error).toMatch(/No chunks/i);
  });

  it('surfaces hybrid-search RPC error', async () => {
    setupRAGClient({
      count: { count: 5, error: null },
      rpcError: { message: 'function match_dubai_code_hybrid does not exist' },
    });
    const out = await testRAGQuery();
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/match_dubai_code_hybrid/);
  });

  it('returns the sample chunk preview on the happy path', async () => {
    setupRAGClient({
      count: { count: 12, error: null },
      sample: {
        data: {
          content: 'Section 3.1 says structural elements must withstand seismic loads of 0.2g.',
          metadata: { page: 31, startPage: 31, endPage: 32, section: '3.1' },
          document_name: 'building-code-2021',
        },
        error: null,
      },
    });
    const out = await testRAGQuery();
    expect(out.success).toBe(true);
    expect(out.chunksFound).toBe(12);
    expect(out.sampleChunk).toMatchObject({
      page: 31,
      section: '3.1',
      documentName: 'building-code-2021',
    });
    expect(out.sampleChunk?.preview).toMatch(/seismic/);
    expect(out.sampleChunk?.preview).toMatch(/\.\.\.$/); // suffix marker
  });
});
