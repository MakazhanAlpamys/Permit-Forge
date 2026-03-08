// ============================================================================
// API Routes Tests — Health, Chat Export, Permit Certificate
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGetQuickSession = vi.fn();
const mockLogAuditEvent = vi.fn();
const mockGetRequestMetadata = vi.fn().mockResolvedValue({ ip: '127.0.0.1', userAgent: 'test' });

vi.mock('@/lib/auth', () => ({
  getQuickSession: (...args: unknown[]) => mockGetQuickSession(...args),
  logAuditEvent: (...args: unknown[]) => mockLogAuditEvent(...args),
  getRequestMetadata: (...args: unknown[]) => mockGetRequestMetadata(...args),
}));

const mockCheckRateLimit = vi.fn();
const mockSingle = vi.fn();
const mockOrder = vi.fn();
const mockLimit = vi.fn();
const mockInsert = vi.fn();
const mockEq = vi.fn();
const mockSelect = vi.fn();

function resetMockChain() {
  mockSelect.mockReturnThis();
  mockEq.mockReturnThis();
  mockOrder.mockReturnThis();
  mockLimit.mockResolvedValue({ data: [], error: null });
  mockSingle.mockResolvedValue({ data: null, error: null });
  mockInsert.mockReturnValue({ error: null });
}

const mockFrom = vi.fn(() => ({
  select: mockSelect,
  eq: mockEq,
  single: mockSingle,
  order: mockOrder,
  limit: mockLimit,
  insert: mockInsert,
}));

vi.mock('@/lib/supabase-server', () => ({
  createServerClient: vi.fn(() => ({ from: mockFrom })),
  createAdminClient: vi.fn(() => ({ from: mockFrom })),
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

const mockGenerateCertificateNumber = vi.fn().mockReturnValue('PF-CERT-2026-001');
const mockGenerateCertificatePDF = vi.fn().mockResolvedValue(Buffer.from('fake-pdf'));

vi.mock('@/lib/permit-certificate', () => ({
  generateCertificateNumber: (...args: unknown[]) => mockGenerateCertificateNumber(...args),
  generateCertificatePDF: (...args: unknown[]) => mockGenerateCertificatePDF(...args),
}));

// ---------------------------------------------------------------------------
// Imports (must be after mocks)
// ---------------------------------------------------------------------------

import { NextRequest } from 'next/server';
import { GET as healthGET } from '@/app/api/health/route';
import { GET as exportGET } from '@/app/api/chat/export/route';
import { GET as certificateGET } from '@/app/api/permits/[id]/certificate/route';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createGETRequest(url: string): NextRequest {
  return new NextRequest(url, { method: 'GET' });
}

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

// ============================================================================
// GET /api/health
// ============================================================================

describe('GET /api/health', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockChain();
  });

  it('should return 200 with status ok when healthy', async () => {
    mockLimit.mockResolvedValue({ data: [{ id: '1' }], error: null });

    const response = await healthGET();
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.status).toBe('ok');
    expect(data.checks.env.status).toBe('ok');
    expect(data.checks.database.status).toBe('ok');
    expect(data.timestamp).toBeDefined();
  });

  it('should return 503 when DB query fails', async () => {
    mockLimit.mockResolvedValue({ data: null, error: { message: 'connection refused' } });

    const response = await healthGET();
    const data = await response.json();

    expect(response.status).toBe(503);
    expect(data.status).toBe('degraded');
    expect(data.checks.database.status).toBe('fail');
    expect(data.checks.database.message).toBe('Database connection failed');
  });
});

// ============================================================================
// GET /api/chat/export
// ============================================================================

describe('GET /api/chat/export', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockChain();
  });

  it('should return 401 when unauthenticated', async () => {
    mockGetQuickSession.mockResolvedValue(null);

    const request = createGETRequest('http://localhost:3000/api/chat/export?sessionId=' + VALID_UUID);
    const response = await exportGET(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error).toBe('Unauthorized');
  });

  it('should return 400 for invalid session ID', async () => {
    mockGetQuickSession.mockResolvedValue({ id: 'user-1', role: 'user', username: 'test' });

    const request = createGETRequest('http://localhost:3000/api/chat/export?sessionId=not-a-uuid');
    const response = await exportGET(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe('Invalid session ID');
  });

  it('should return 400 for missing session ID', async () => {
    mockGetQuickSession.mockResolvedValue({ id: 'user-1', role: 'user', username: 'test' });

    const request = createGETRequest('http://localhost:3000/api/chat/export');
    const response = await exportGET(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe('Invalid session ID');
  });

  it('should return 403 for non-owner session', async () => {
    mockGetQuickSession.mockResolvedValue({ id: 'user-1', role: 'user', username: 'test' });
    // Session belongs to a different user
    mockSingle.mockResolvedValue({
      data: { title: 'Test Chat', user_id: 'user-999', created_at: '2026-01-01T00:00:00Z' },
      error: null,
    });

    const request = createGETRequest('http://localhost:3000/api/chat/export?sessionId=' + VALID_UUID);
    const response = await exportGET(request);
    const data = await response.json();

    expect(response.status).toBe(403);
    expect(data.error).toBe('Access denied');
  });
});

// ============================================================================
// GET /api/permits/[id]/certificate
// ============================================================================

describe('GET /api/permits/[id]/certificate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockChain();
    mockCheckRateLimit.mockResolvedValue({ allowed: true });
  });

  it('should return 401 when unauthenticated', async () => {
    mockGetQuickSession.mockResolvedValue(null);

    const request = createGETRequest('http://localhost:3000/api/permits/' + VALID_UUID + '/certificate');
    const response = await certificateGET(request, { params: Promise.resolve({ id: VALID_UUID }) });

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe('Not authenticated');
  });

  it('should return 400 for invalid permit ID', async () => {
    mockGetQuickSession.mockResolvedValue({ id: 'user-1', role: 'user', username: 'test' });

    const request = createGETRequest('http://localhost:3000/api/permits/invalid-id/certificate');
    const response = await certificateGET(request, { params: Promise.resolve({ id: 'invalid-id' }) });

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('Invalid permit ID');
  });

  it('should return 400 for non-approved permit', async () => {
    mockGetQuickSession.mockResolvedValue({ id: 'user-1', role: 'user', username: 'test' });

    // First .single() call returns the permit (non-approved)
    // We need to track call count since single() is called multiple times
    let singleCallCount = 0;
    mockSingle.mockImplementation(() => {
      singleCallCount++;
      if (singleCallCount === 1) {
        // Permit lookup — status is "submitted" (not approved)
        return Promise.resolve({
          data: {
            id: VALID_UUID,
            status: 'submitted',
            user_id: 'user-1',
            project_name: 'Test Project',
          },
          error: null,
        });
      }
      // Certificate lookup
      return Promise.resolve({ data: null, error: null });
    });

    const request = createGETRequest('http://localhost:3000/api/permits/' + VALID_UUID + '/certificate');
    const response = await certificateGET(request, { params: Promise.resolve({ id: VALID_UUID }) });

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('Certificate only available for approved permits');
  });

  it('should return 429 when rate limited', async () => {
    mockGetQuickSession.mockResolvedValue({ id: 'user-1', role: 'user', username: 'test' });
    mockCheckRateLimit.mockResolvedValue({ allowed: false, retryAfterMs: 5000 });

    const request = createGETRequest('http://localhost:3000/api/permits/' + VALID_UUID + '/certificate');
    const response = await certificateGET(request, { params: Promise.resolve({ id: VALID_UUID }) });

    expect(response.status).toBe(429);
    const data = await response.json();
    expect(data.error).toBe('Rate limited');
  });
});
