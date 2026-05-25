// ============================================================================
// Admin Document PDF Upload API Route Tests (COV-C-4 / v1.4.0 Part A)
// ============================================================================
// Route at app/api/admin/documents/upload/route.ts was at 0% line coverage
// before this file. We cover the auth / CSRF / payload-shape gates plus
// success/failure handoff to uploadDocumentPdfShared.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGetQuickSession = vi.fn();
const mockValidateCSRFToken = vi.fn();
const mockGetRequestMetadata = vi.fn().mockResolvedValue({ ipAddress: '127.0.0.1', userAgent: 'test' });

vi.mock('@/lib/auth', () => ({
  validateCSRFToken: (...args: unknown[]) => mockValidateCSRFToken(...args),
  getRequestMetadata: (...args: unknown[]) => mockGetRequestMetadata(...args),
}));

vi.mock('@/lib/security', () => ({
  requireAdmin: vi.fn(async () => {
    const user = await mockGetQuickSession();
    if (!user) return { success: false, error: 'Authentication required' };
    if (user.role !== 'admin') return { success: false, error: 'Unauthorized: Admin access required' };
    return { success: true, user };
  }),
}));

const mockUploadDocumentPdfShared = vi.fn();
vi.mock('@/lib/document-pdf-upload', () => ({
  uploadDocumentPdfShared: (...args: unknown[]) => mockUploadDocumentPdfShared(...args),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/admin/documents/upload/route';

const adminUser = { id: 'admin-1', role: 'admin', username: 'admin' };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function multipartRequest(form: FormData, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost:3000/api/admin/documents/upload', {
    method: 'POST',
    body: form,
    headers,
  });
}

function pdfFile(name = 'building-code.pdf', bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46])): File {
  return new File([bytes], name, { type: 'application/pdf' });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/admin/documents/upload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateCSRFToken.mockResolvedValue(true);
    mockUploadDocumentPdfShared.mockResolvedValue({
      success: true,
      storagePath: 'documents/doc-a/building-code.pdf',
      pdfHash: 'abc123',
      previousPdfHash: null,
    });
  });

  // -------------------------------------------------------------------------
  // Auth + admin gate (AUTH-C1 / v1.0.0 Part E)
  // -------------------------------------------------------------------------

  it('returns 401 when no session', async () => {
    mockGetQuickSession.mockResolvedValue(null);

    const fd = new FormData();
    fd.set('documentId', 'doc-a');
    fd.set('file', pdfFile());

    const res = await POST(multipartRequest(fd, { 'x-csrf-token': 't' }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it('returns 401 when caller is not admin (privilege-boundary endpoint)', async () => {
    mockGetQuickSession.mockResolvedValue({ id: 'u', role: 'user' });

    const fd = new FormData();
    fd.set('documentId', 'doc-a');
    fd.set('file', pdfFile());

    const res = await POST(multipartRequest(fd, { 'x-csrf-token': 't' }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/admin/i);
  });

  // -------------------------------------------------------------------------
  // CSRF gate
  // -------------------------------------------------------------------------

  it('returns 403 when CSRF header is missing', async () => {
    mockGetQuickSession.mockResolvedValue(adminUser);

    const fd = new FormData();
    fd.set('documentId', 'doc-a');
    fd.set('file', pdfFile());

    const res = await POST(multipartRequest(fd));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('CSRF token invalid');
  });

  it('returns 403 when CSRF token validation fails', async () => {
    mockGetQuickSession.mockResolvedValue(adminUser);
    mockValidateCSRFToken.mockResolvedValue(false);

    const fd = new FormData();
    fd.set('documentId', 'doc-a');
    fd.set('file', pdfFile());

    const res = await POST(multipartRequest(fd, { 'x-csrf-token': 'bad' }));
    expect(res.status).toBe(403);
  });

  // -------------------------------------------------------------------------
  // Payload shape
  // -------------------------------------------------------------------------

  it('returns 400 when documentId field is missing', async () => {
    mockGetQuickSession.mockResolvedValue(adminUser);

    const fd = new FormData();
    fd.set('file', pdfFile());

    const res = await POST(multipartRequest(fd, { 'x-csrf-token': 't' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Missing documentId');
  });

  it('returns 400 when file part is missing', async () => {
    mockGetQuickSession.mockResolvedValue(adminUser);

    const fd = new FormData();
    fd.set('documentId', 'doc-a');

    const res = await POST(multipartRequest(fd, { 'x-csrf-token': 't' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('No file provided');
  });

  // -------------------------------------------------------------------------
  // Successful upload — handoff to uploadDocumentPdfShared
  // -------------------------------------------------------------------------

  it('returns 200 + shared-upload payload on success and passes request metadata through', async () => {
    mockGetQuickSession.mockResolvedValue(adminUser);

    const fd = new FormData();
    fd.set('documentId', 'doc-a');
    fd.set('file', pdfFile('building-code-2021.pdf'));

    const res = await POST(multipartRequest(fd, { 'x-csrf-token': 't' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.storagePath).toBe('documents/doc-a/building-code.pdf');

    // The route must forward the request's IP/UA into the shared helper for
    // the audit-log entry on the storage write.
    expect(mockUploadDocumentPdfShared).toHaveBeenCalledWith(expect.objectContaining({
      documentId: 'doc-a',
      uploadedByUserId: 'admin-1',
      ipAddress: '127.0.0.1',
      userAgent: 'test',
    }));
    const callArg = mockUploadDocumentPdfShared.mock.calls[0][0];
    expect(callArg.file).toBeInstanceOf(File);
    expect(callArg.file.name).toBe('building-code-2021.pdf');
  });

  // -------------------------------------------------------------------------
  // Shared helper rejected the upload (e.g. bad magic bytes, oversize)
  // -------------------------------------------------------------------------

  it('returns 400 when uploadDocumentPdfShared reports failure', async () => {
    mockGetQuickSession.mockResolvedValue(adminUser);
    mockUploadDocumentPdfShared.mockResolvedValue({
      success: false,
      error: 'File too large. Maximum size is 100MB',
    });

    const fd = new FormData();
    fd.set('documentId', 'doc-a');
    fd.set('file', pdfFile());

    const res = await POST(multipartRequest(fd, { 'x-csrf-token': 't' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/too large/i);
  });
});
