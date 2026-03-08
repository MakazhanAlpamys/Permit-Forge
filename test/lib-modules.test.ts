// ============================================================================
// Library Module Tests — security, file-upload, heuristic-reranker, scope-detector
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks for lib/security.ts (must be before imports)
// ---------------------------------------------------------------------------

const mockGetQuickSession = vi.fn();
const mockValidateCSRFToken = vi.fn();
const mockLogAuditEvent = vi.fn().mockResolvedValue(undefined);
const mockGetRequestMetadata = vi.fn().mockResolvedValue({ ip: '127.0.0.1', userAgent: 'test' });

vi.mock('@/lib/auth', () => ({
  getQuickSession: (...args: unknown[]) => mockGetQuickSession(...args),
  validateCSRFToken: (...args: unknown[]) => mockValidateCSRFToken(...args),
  logAuditEvent: (...args: unknown[]) => mockLogAuditEvent(...args),
  getRequestMetadata: (...args: unknown[]) => mockGetRequestMetadata(...args),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { requireAuth, requireAdmin, requireCSRF } from '@/lib/security';
import { validateFile, generateStoragePath, formatFileSize } from '@/lib/file-upload';
import { heuristicRerank } from '@/lib/heuristic-reranker';
import { detectScope } from '@/lib/scope-detector';
import type { MatchedChunk } from '@/types';

// ============================================================================
// lib/security.ts
// ============================================================================

describe('lib/security', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('requireAuth', () => {
    it('should return user for valid session', async () => {
      const user = { id: 'user-1', username: 'testuser', role: 'user' as const };
      mockGetQuickSession.mockResolvedValue(user);

      const result = await requireAuth();

      expect(result.success).toBe(true);
      expect(result.user).toEqual(user);
      expect(result.error).toBeUndefined();
    });

    it('should return error for no session', async () => {
      mockGetQuickSession.mockResolvedValue(null);

      const result = await requireAuth();

      expect(result.success).toBe(false);
      expect(result.error).toBe('Authentication required');
      expect(result.user).toBeUndefined();
    });

    it('should return error when getQuickSession throws', async () => {
      mockGetQuickSession.mockRejectedValue(new Error('token expired'));

      const result = await requireAuth();

      expect(result.success).toBe(false);
      expect(result.error).toBe('Authentication failed');
    });
  });

  describe('requireAdmin', () => {
    it('should return user for admin role', async () => {
      const admin = { id: 'admin-1', username: 'admin', role: 'admin' as const };
      mockGetQuickSession.mockResolvedValue(admin);

      const result = await requireAdmin();

      expect(result.success).toBe(true);
      expect(result.user).toEqual(admin);
    });

    it('should return error for user role', async () => {
      const user = { id: 'user-1', username: 'testuser', role: 'user' as const };
      mockGetQuickSession.mockResolvedValue(user);

      const result = await requireAdmin();

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unauthorized: Admin access required');
    });

    it('should log audit event on unauthorized admin attempt', async () => {
      const user = { id: 'user-1', username: 'testuser', role: 'user' as const };
      mockGetQuickSession.mockResolvedValue(user);

      await requireAdmin();

      expect(mockLogAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          action: 'login_failed',
          metadata: expect.objectContaining({
            reason: 'unauthorized_admin_attempt',
          }),
        })
      );
    });

    it('should return error when not authenticated', async () => {
      mockGetQuickSession.mockResolvedValue(null);

      const result = await requireAdmin();

      expect(result.success).toBe(false);
      expect(result.error).toBe('Authentication required');
    });
  });

  describe('requireCSRF', () => {
    it('should return valid for correct token', async () => {
      mockValidateCSRFToken.mockResolvedValue(true);

      const result = await requireCSRF('valid-token');

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should return error for missing token', async () => {
      const result = await requireCSRF(undefined);

      expect(result.valid).toBe(false);
      expect(result.error).toBe('CSRF token missing');
    });

    it('should return error for null token', async () => {
      const result = await requireCSRF(null);

      expect(result.valid).toBe(false);
      expect(result.error).toBe('CSRF token missing');
    });

    it('should return error for invalid token', async () => {
      mockValidateCSRFToken.mockResolvedValue(false);

      const result = await requireCSRF('bad-token');

      expect(result.valid).toBe(false);
      expect(result.error).toBe('CSRF token invalid');
    });
  });
});

// ============================================================================
// lib/file-upload.ts
// ============================================================================

describe('lib/file-upload', () => {
  describe('validateFile', () => {
    function createMockFile(name: string, size: number, type: string): File {
      // Create a plain object that satisfies the File interface
      // (Blob's size is readonly, so we can't use Object.assign on a real Blob)
      return {
        name,
        size,
        type,
        lastModified: Date.now(),
        webkitRelativePath: '',
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
        bytes: () => Promise.resolve(new Uint8Array(0)),
        slice: () => new Blob(),
        stream: () => new ReadableStream(),
        text: () => Promise.resolve(''),
      } as unknown as File;
    }

    it('should accept valid PDF file', () => {
      const file = createMockFile('document.pdf', 1024 * 1024, 'application/pdf');
      const result = validateFile(file);
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should accept valid PNG file', () => {
      const file = createMockFile('photo.png', 500 * 1024, 'image/png');
      const result = validateFile(file);
      expect(result.valid).toBe(true);
    });

    it('should accept valid JPG file', () => {
      const file = createMockFile('photo.jpg', 500 * 1024, 'image/jpeg');
      const result = validateFile(file);
      expect(result.valid).toBe(true);
    });

    it('should reject oversized file (>10MB)', () => {
      const file = createMockFile('big.pdf', 11 * 1024 * 1024, 'application/pdf');
      const result = validateFile(file);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('10MB limit');
    });

    it('should reject empty file', () => {
      const file = createMockFile('empty.pdf', 0, 'application/pdf');
      const result = validateFile(file);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('File is empty');
    });

    it('should reject invalid extension', () => {
      const file = createMockFile('script.exe', 1024, 'application/x-msdownload');
      const result = validateFile(file);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('File type not allowed');
    });

    it('should reject file with mismatched MIME type', () => {
      // A .pdf extension with an image MIME type
      const file = createMockFile('fake.pdf', 1024, 'image/png');
      const result = validateFile(file);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('MIME type');
    });

    it('should reject file with no MIME type', () => {
      const file = createMockFile('data.pdf', 1024, '');
      const result = validateFile(file);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('File type could not be determined');
    });
  });

  describe('generateStoragePath', () => {
    it('should return permits/{id}/{timestamp}-{name} format', () => {
      const path = generateStoragePath('permit-123', 'floor-plan.pdf');
      expect(path).toMatch(/^permits\/permit-123\/\d+-floor-plan\.pdf$/);
    });

    it('should sanitize special characters in filename', () => {
      const path = generateStoragePath('p1', 'my file (2).pdf');
      // Special chars should be replaced with underscores
      expect(path).not.toContain(' ');
      expect(path).not.toContain('(');
      expect(path).not.toContain(')');
      expect(path).toMatch(/^permits\/p1\/\d+-my_file_2_\.pdf$/);
    });
  });

  describe('formatFileSize', () => {
    it('should format 0 bytes', () => {
      expect(formatFileSize(0)).toBe('0 B');
    });

    it('should format bytes', () => {
      expect(formatFileSize(500)).toBe('500 B');
    });

    it('should format kilobytes', () => {
      expect(formatFileSize(1024)).toBe('1.0 KB');
    });

    it('should format megabytes', () => {
      expect(formatFileSize(1024 * 1024)).toBe('1.0 MB');
    });

    it('should format fractional megabytes', () => {
      expect(formatFileSize(5.5 * 1024 * 1024)).toBe('5.5 MB');
    });

    it('should format gigabytes', () => {
      expect(formatFileSize(1024 * 1024 * 1024)).toBe('1.0 GB');
    });
  });
});

// ============================================================================
// lib/heuristic-reranker.ts
// ============================================================================

describe('lib/heuristic-reranker', () => {
  function createChunk(overrides: Partial<MatchedChunk> & { content?: string; similarity?: number } = {}): MatchedChunk {
    return {
      id: overrides.id ?? 1,
      content: overrides.content ?? 'Fire safety requirements for residential buildings',
      similarity: overrides.similarity ?? 0.8,
      metadata: {
        page: 1,
        startPage: 1,
        endPage: 1,
        documentName: 'building-code',
        ...overrides.metadata,
      },
    };
  }

  it('should handle empty input', () => {
    const result = heuristicRerank('fire safety', []);
    expect(result).toEqual([]);
  });

  it('should return all chunks when count <= topK', () => {
    const chunks = [
      createChunk({ id: 1, similarity: 0.9 }),
      createChunk({ id: 2, similarity: 0.7 }),
    ];

    const result = heuristicRerank('fire safety', chunks, 5);
    expect(result).toHaveLength(2);
  });

  it('should respect topK limit', () => {
    const chunks = Array.from({ length: 10 }, (_, i) =>
      createChunk({
        id: i + 1,
        similarity: 0.9 - i * 0.05,
        metadata: {
          page: i + 1,
          startPage: i + 1,
          endPage: i + 1,
          // Use different document names to avoid diversity limits
          documentName: `doc-${i}`,
        },
      })
    );

    const result = heuristicRerank('fire safety requirements', chunks, 3);
    expect(result).toHaveLength(3);
  });

  it('should rerank chunks by composite score', () => {
    const chunks = [
      createChunk({
        id: 1,
        content: 'unrelated content about parking',
        similarity: 0.5,
        metadata: { page: 50, startPage: 50, endPage: 50, documentName: 'doc-a' },
      }),
      createChunk({
        id: 2,
        content: 'fire safety requirements for buildings',
        similarity: 0.9,
        metadata: { page: 10, startPage: 10, endPage: 10, documentName: 'doc-b' },
      }),
      createChunk({
        id: 3,
        content: 'fire safety systems and alarms',
        similarity: 0.85,
        metadata: { page: 11, startPage: 11, endPage: 11, documentName: 'doc-c' },
      }),
      createChunk({
        id: 4,
        content: 'structural engineering standards',
        similarity: 0.6,
        metadata: { page: 30, startPage: 30, endPage: 30, documentName: 'doc-d' },
      }),
    ];

    const result = heuristicRerank('fire safety', chunks, 2);
    expect(result).toHaveLength(2);
    // The chunk with highest similarity + keyword overlap should be first
    expect(result[0].id).toBe(2);
  });

  it('should enforce diversity limits across documents', () => {
    // Create 6 chunks from the same document — diversity limit is 3 per doc
    const chunks = Array.from({ length: 6 }, (_, i) =>
      createChunk({
        id: i + 1,
        similarity: 0.9 - i * 0.01,
        content: `fire safety requirement ${i}`,
        metadata: {
          page: i + 1,
          startPage: i + 1,
          endPage: i + 1,
          documentName: 'same-doc',
        },
      })
    );
    // Add one chunk from a different doc
    chunks.push(
      createChunk({
        id: 7,
        content: 'fire safety from another source',
        similarity: 0.5,
        metadata: { page: 1, startPage: 1, endPage: 1, documentName: 'other-doc' },
      })
    );

    const result = heuristicRerank('fire safety', chunks, 5);
    expect(result).toHaveLength(5);

    // Count chunks from same-doc — should be capped at 3 initially, then deferred fill
    const sameDocChunks = result.filter(c => c.metadata.documentName === 'same-doc');
    const otherDocChunks = result.filter(c => c.metadata.documentName === 'other-doc');
    expect(otherDocChunks.length).toBeGreaterThanOrEqual(1);
    // The diversity limit means at most 3 from same-doc in the initial pass
    // but deferred chunks can fill remaining slots
    expect(sameDocChunks.length).toBeLessThanOrEqual(5);
  });
});

// ============================================================================
// lib/scope-detector.ts
// ============================================================================

describe('lib/scope-detector', () => {
  it('should detect "page 5" reference', () => {
    const result = detectScope('What does page 5 say about fire safety?');
    expect(result.hasScope).toBe(true);
    expect(result.pageRanges).toHaveLength(1);
    expect(result.pageRanges[0]).toEqual({ startPage: 5, endPage: 5 });
  });

  it('should detect "pages 10-15" range', () => {
    const result = detectScope('Summarize pages 10-15');
    expect(result.hasScope).toBe(true);
    expect(result.pageRanges).toHaveLength(1);
    expect(result.pageRanges[0]).toEqual({ startPage: 10, endPage: 15 });
  });

  it('should detect page range with en-dash separator', () => {
    const result = detectScope('What is on pages 20\u201325?');
    expect(result.hasScope).toBe(true);
    expect(result.pageRanges).toHaveLength(1);
    expect(result.pageRanges[0]).toEqual({ startPage: 20, endPage: 25 });
  });

  it('should detect "section 3.2" reference', () => {
    const result = detectScope('Explain section 3.2 requirements');
    expect(result.hasScope).toBe(true);
    expect(result.sections).toContain('3.2');
  });

  it('should detect "section 4.2.1" reference', () => {
    const result = detectScope('What does section 4.2.1 cover?');
    expect(result.hasScope).toBe(true);
    expect(result.sections).toContain('4.2.1');
  });

  it('should detect chapter references', () => {
    const result = detectScope('Summarize chapter 5');
    expect(result.hasScope).toBe(true);
    expect(result.sections).toContain('5');
  });

  it('should return null filter for queries without scope', () => {
    const result = detectScope('What are the fire safety requirements?');
    expect(result.hasScope).toBe(false);
    expect(result.pageRanges).toHaveLength(0);
    expect(result.sections).toHaveLength(0);
  });

  it('should detect standalone multi-level section numbers', () => {
    const result = detectScope('Requirements from 4.2.1 about fire exits');
    expect(result.hasScope).toBe(true);
    expect(result.sections).toContain('4.2.1');
  });

  it('should detect multiple page references', () => {
    const result = detectScope('Compare page 5 and page 12');
    expect(result.hasScope).toBe(true);
    expect(result.pageRanges).toHaveLength(2);
    expect(result.pageRanges[0]).toEqual({ startPage: 5, endPage: 5 });
    expect(result.pageRanges[1]).toEqual({ startPage: 12, endPage: 12 });
  });

  it('should detect standalone section number with multiple levels', () => {
    const result = detectScope('What about 1.2.3.4 in the code?');
    expect(result.hasScope).toBe(true);
    expect(result.sections).toContain('1.2.3.4');
  });
});
