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
import { clearDocumentChunks, getIngestionStatus } from '@/actions/ingest-pdf';

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
