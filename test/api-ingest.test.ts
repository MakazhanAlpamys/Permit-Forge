// ============================================================================
// PDF Ingestion API Route Tests (COV-C-3 / v1.4.0 Part A)
// ============================================================================
// Route at app/api/ingest/route.ts was at 0% line coverage before this file.
// We cover the auth / CSRF / rate-limit / payload-validation gates plus the
// happy-path SSE response shape.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGetQuickSession = vi.fn();
const mockValidateCSRFToken = vi.fn();

vi.mock('@/lib/auth', () => ({
  validateCSRFToken: (...args: unknown[]) => mockValidateCSRFToken(...args),
}));

// AUTH-C1 / v1.0.0 Part E: ingest route boots through `requireAdmin`.
vi.mock('@/lib/security', () => ({
  requireAdmin: vi.fn(async () => {
    const user = await mockGetQuickSession();
    if (!user) return { success: false, error: 'Authentication required' };
    if (user.role !== 'admin') return { success: false, error: 'Unauthorized: Admin access required' };
    return { success: true, user };
  }),
}));

// Chainable Supabase builder. Per-test we override `mockSingle` for the
// document_registry lookup and `mockRpc` for try_start_ingestion.
const mockSingle = vi.fn();
const mockEq = vi.fn();
const mockSelect = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockDownload = vi.fn();
const mockStorageFrom = vi.fn();
const mockRpc = vi.fn();
const mockCheckRateLimit = vi.fn();

function resetSupabaseMocks() {
  mockSingle.mockResolvedValue({ data: null, error: null });
  mockEq.mockReturnValue({
    single: mockSingle,
    eq: mockEq,
    select: mockSelect,
    delete: mockDelete,
    update: mockUpdate,
  });
  mockSelect.mockReturnValue({ eq: mockEq, single: mockSingle });
  mockUpdate.mockReturnValue({ eq: mockEq });
  mockDelete.mockReturnValue({ eq: mockEq });
  mockDownload.mockResolvedValue({
    data: { arrayBuffer: async () => new ArrayBuffer(8) },
    error: null,
  });
  mockStorageFrom.mockReturnValue({ download: mockDownload });
  mockRpc.mockResolvedValue({ data: true, error: null });
}

const mockFrom = vi.fn((_table: string) => ({
  select: mockSelect,
  eq: mockEq,
  update: mockUpdate,
  delete: mockDelete,
  single: mockSingle,
}));

vi.mock('@/lib/supabase-server', () => ({
  createAdminClient: vi.fn(() => ({
    from: (table: string) => mockFrom(table),
    storage: { from: (bucket: string) => mockStorageFrom(bucket) },
    rpc: (name: string, params?: unknown) => mockRpc(name, params),
  })),
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

// Ingestion pipeline — we stub it out; the route only cares about success/failure.
const mockRunIngestionPipeline = vi.fn();
vi.mock('@/lib/pdf-ingestion', () => ({
  runIngestionPipeline: (...args: unknown[]) => mockRunIngestionPipeline(...args),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/ingest/route';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createRequest(body: object | string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost:3000/api/ingest', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
}

async function drainSSE(response: Response, maxMs = 500): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let out = '';
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value);
  }
  return out;
}

const adminUser = { id: 'admin-1', role: 'admin', username: 'admin' };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/ingest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSupabaseMocks();
    mockCheckRateLimit.mockResolvedValue({ allowed: true });
    mockValidateCSRFToken.mockResolvedValue(true);
    mockRunIngestionPipeline.mockResolvedValue({ success: true, processedCount: 10 });
  });

  // -------------------------------------------------------------------------
  // Auth + admin gate
  // -------------------------------------------------------------------------

  it('returns 401 when no session', async () => {
    mockGetQuickSession.mockResolvedValue(null);
    const res = await POST(createRequest({ documentId: 'doc-a' }, { 'x-csrf-token': 't' }));
    expect(res.status).toBe(401);
  });

  it('returns 401 when caller is not admin', async () => {
    mockGetQuickSession.mockResolvedValue({ id: 'u', role: 'user' });
    const res = await POST(createRequest({ documentId: 'doc-a' }, { 'x-csrf-token': 't' }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/admin/i);
  });

  // -------------------------------------------------------------------------
  // CSRF gate
  // -------------------------------------------------------------------------

  it('returns 403 when CSRF header is missing', async () => {
    mockGetQuickSession.mockResolvedValue(adminUser);
    const res = await POST(createRequest({ documentId: 'doc-a' }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('CSRF token invalid');
  });

  it('returns 403 when CSRF token is invalid', async () => {
    mockGetQuickSession.mockResolvedValue(adminUser);
    mockValidateCSRFToken.mockResolvedValue(false);
    const res = await POST(createRequest({ documentId: 'doc-a' }, { 'x-csrf-token': 'bad' }));
    expect(res.status).toBe(403);
  });

  // -------------------------------------------------------------------------
  // Rate-limit gate (S-H-1 / v1.0.0 Part F: dedicated 'ingest' bucket)
  // -------------------------------------------------------------------------

  it('returns 429 when ingest rate-limit bucket is exhausted', async () => {
    mockGetQuickSession.mockResolvedValue(adminUser);
    mockCheckRateLimit.mockResolvedValue({ allowed: false, retryAfterMs: 5000 });

    const res = await POST(createRequest({ documentId: 'doc-a' }, { 'x-csrf-token': 't' }));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe('Rate limited');
    expect(body.retryAfter).toBe(5000);
    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      'admin-1',
      expect.objectContaining({ endpoint: 'ingest' }),
    );
  });

  // -------------------------------------------------------------------------
  // Body / payload validation
  // -------------------------------------------------------------------------

  it('returns 400 on invalid JSON body', async () => {
    mockGetQuickSession.mockResolvedValue(adminUser);
    const res = await POST(createRequest('not-json{', { 'x-csrf-token': 't' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Invalid request body');
  });

  it('returns 400 when documentId is missing', async () => {
    mockGetQuickSession.mockResolvedValue(adminUser);
    const res = await POST(createRequest({}, { 'x-csrf-token': 't' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Missing documentId');
  });

  it('returns 400 when document is not registered', async () => {
    mockGetQuickSession.mockResolvedValue(adminUser);
    mockSingle.mockResolvedValueOnce({ data: null, error: null });

    const res = await POST(createRequest({ documentId: 'unknown' }, { 'x-csrf-token': 't' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Unknown document ID');
  });

  it('returns 400 when document is inactive', async () => {
    mockGetQuickSession.mockResolvedValue(adminUser);
    mockSingle.mockResolvedValueOnce({
      data: { file_name: 'x.pdf', is_active: false, storage_path: null, pdf_hash: null },
      error: null,
    });

    const res = await POST(createRequest({ documentId: 'doc-a' }, { 'x-csrf-token': 't' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Unknown document ID');
  });

  // Path validation when document has no storage_path → fallback public/ path.
  it('returns 400 when fallback PDF filename fails regex (path traversal guard)', async () => {
    mockGetQuickSession.mockResolvedValue(adminUser);
    mockSingle.mockResolvedValueOnce({
      data: {
        file_name: '../etc/passwd',
        is_active: true,
        storage_path: null,
        pdf_hash: null,
      },
      error: null,
    });

    const res = await POST(createRequest({ documentId: 'doc-a' }, { 'x-csrf-token': 't' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Upload a PDF/);
  });

  // -------------------------------------------------------------------------
  // Storage download failure
  // -------------------------------------------------------------------------

  it('returns 500 when Supabase Storage download fails', async () => {
    mockGetQuickSession.mockResolvedValue(adminUser);
    mockSingle.mockResolvedValueOnce({
      data: {
        file_name: 'building-code.pdf',
        is_active: true,
        storage_path: 'documents/doc-a/building-code.pdf',
        pdf_hash: 'abc',
      },
      error: null,
    });
    mockDownload.mockResolvedValueOnce({ data: null, error: { message: 'not found' } });

    const res = await POST(createRequest({ documentId: 'doc-a' }, { 'x-csrf-token': 't' }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/storage/i);
  });

  // -------------------------------------------------------------------------
  // Happy path: returns SSE stream with progress events
  // -------------------------------------------------------------------------

  it('returns text/event-stream and emits progress events on success', async () => {
    mockGetQuickSession.mockResolvedValue(adminUser);
    mockSingle.mockResolvedValueOnce({
      data: {
        file_name: 'building-code.pdf',
        is_active: true,
        storage_path: 'documents/doc-a/building-code.pdf',
        pdf_hash: 'abc',
      },
      error: null,
    });

    const res = await POST(createRequest({ documentId: 'doc-a' }, { 'x-csrf-token': 't' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');

    const sse = await drainSSE(res, 400);
    // First progress event after try_start_ingestion claims the slot.
    expect(sse).toMatch(/data: .*"stage":"reading"/);
    // try_start_ingestion was called atomically before the pipeline.
    expect(mockRpc).toHaveBeenCalledWith('try_start_ingestion', { p_document_id: 'doc-a' });
  });

  // D19 / P2-A9: another in-flight ingestion holds the advisory lock.
  it('emits an INGESTION_IN_PROGRESS error event when try_start_ingestion returns false', async () => {
    mockGetQuickSession.mockResolvedValue(adminUser);
    mockSingle.mockResolvedValueOnce({
      data: {
        file_name: 'building-code.pdf',
        is_active: true,
        storage_path: 'documents/doc-a/building-code.pdf',
        pdf_hash: 'abc',
      },
      error: null,
    });
    mockRpc.mockResolvedValueOnce({ data: false, error: null });

    const res = await POST(createRequest({ documentId: 'doc-a' }, { 'x-csrf-token': 't' }));
    expect(res.status).toBe(200);
    const sse = await drainSSE(res, 400);
    expect(sse).toMatch(/INGESTION_IN_PROGRESS/);
    expect(mockRunIngestionPipeline).not.toHaveBeenCalled();
  });

  // Pipeline reports failure — final progress event must be stage:'error'.
  it('emits an error progress event when the pipeline fails', async () => {
    mockGetQuickSession.mockResolvedValue(adminUser);
    mockSingle.mockResolvedValueOnce({
      data: {
        file_name: 'building-code.pdf',
        is_active: true,
        storage_path: 'documents/doc-a/building-code.pdf',
        pdf_hash: 'abc',
      },
      error: null,
    });
    mockRunIngestionPipeline.mockRejectedValueOnce(new Error('embedding quota'));

    const res = await POST(createRequest({ documentId: 'doc-a' }, { 'x-csrf-token': 't' }));
    expect(res.status).toBe(200);
    const sse = await drainSSE(res, 400);
    expect(sse).toMatch(/"stage":"error"/);
  });
});
