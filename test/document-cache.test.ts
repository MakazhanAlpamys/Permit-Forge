// ============================================================================
// v1.7.0 Part B — lib/document-cache.ts coverage
// ============================================================================
// Centralised invalidator for the three independent document-derived caches.
// Just verifies that calling invalidateAllDocumentCaches forwards to all
// three underlying invalidators (registry + profile + tree). The actual
// invalidation logic lives in their own modules and is covered there.
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockInvalidateRegistryCache = vi.fn();
const mockInvalidateProfileCache = vi.fn();
const mockClearDocumentTreeCache = vi.fn();

vi.mock('@/lib/document-registry', () => ({
  invalidateRegistryCache: () => mockInvalidateRegistryCache(),
}));
vi.mock('@/lib/document-selector', () => ({
  invalidateProfileCache: () => mockInvalidateProfileCache(),
}));
vi.mock('@/lib/tree-cache', () => ({
  clearDocumentTreeCache: (name?: string) => mockClearDocumentTreeCache(name),
}));

import { invalidateAllDocumentCaches } from '@/lib/document-cache';

describe('invalidateAllDocumentCaches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards to all three underlying invalidators when scoped to a document', () => {
    invalidateAllDocumentCaches('doc-a');

    expect(mockInvalidateRegistryCache).toHaveBeenCalledOnce();
    expect(mockInvalidateProfileCache).toHaveBeenCalledOnce();
    expect(mockClearDocumentTreeCache).toHaveBeenCalledWith('doc-a');
  });

  it('passes undefined to the tree-cache invalidator when no document name given', () => {
    invalidateAllDocumentCaches();

    expect(mockInvalidateRegistryCache).toHaveBeenCalledOnce();
    expect(mockInvalidateProfileCache).toHaveBeenCalledOnce();
    expect(mockClearDocumentTreeCache).toHaveBeenCalledWith(undefined);
  });
});
