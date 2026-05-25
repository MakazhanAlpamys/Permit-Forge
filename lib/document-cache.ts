// ============================================================================
// Document Cache Invalidation Coordinator (v1.7.0 Part B)
// ============================================================================
// Three independent caches sit on top of the document_registry / document_trees
// tables:
//   - lib/document-registry.ts    (active document metadata, 5-min TTL)
//   - lib/document-selector.ts    (search-profile keywords / categories)
//   - lib/tree-cache.ts           (per-document TOC tree, 5-min TTL)
//
// Pre-v1.7 every callsite that mutated documents had to remember to call all
// three invalidators in the right order. Forgetting one left the registry
// looking fresh while the tree returned the old TOC — a silent
// staleness window only visible during defense-day demos.
//
// This module is the single throat callers must squeeze. Pass a
// `documentName` to scope the tree-cache eviction; pass nothing to clear all
// per-document trees (e.g. on a wholesale "deactivate all" admin action).
// The registry + profile caches are always nuked since both rebuild on next
// read with a single SELECT — the granularity isn't worth the bookkeeping.
// ============================================================================

import { invalidateRegistryCache } from '@/lib/document-registry';
import { invalidateProfileCache } from '@/lib/document-selector';
import { clearDocumentTreeCache } from '@/lib/tree-cache';

/**
 * Invalidate every document-derived cache. Call this from any path that
 * registers, ingests, deactivates, restores, or hard-deletes a document.
 *
 * @param documentName  Optional. When provided, only the tree cache for that
 *   document is cleared; the registry + profile caches are always flushed
 *   (both rebuild on next read with a single SELECT).
 */
export function invalidateAllDocumentCaches(documentName?: string): void {
  invalidateRegistryCache();
  invalidateProfileCache();
  clearDocumentTreeCache(documentName);
}
