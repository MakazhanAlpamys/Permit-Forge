// ============================================================================
// Document Tree Cache (Two-Tier: In-Memory + Supabase) — Multi-Document
// ============================================================================
//
// Solves the serverless cold-start problem:
//   - L1 (In-Memory): Fast, TTL-based, works within warm serverless instances
//   - L2 (Supabase):  Persistent, source of truth, survives cold starts
//
// Cache invalidation:
//   - Automatic after TTL expires
//   - Manual via clearDocumentTreeCache() after re-ingestion
//   - Staleness check via updated_at timestamp (avoids fetching full JSONB)
// ============================================================================

import { createAdminClient } from '@/lib/supabase-server';
import { debugLog } from '@/lib/debug-log';
import { TREE_CACHE_TTL_MS } from '@/lib/constants';
import type { TreeNode } from '@/types';

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

// TREE_CACHE_TTL_MS imported from @/lib/constants
// Re-export for backward compatibility
export { TREE_CACHE_TTL_MS } from '@/lib/constants';

// -----------------------------------------------------------------------------
// Cache State (per-document)
// -----------------------------------------------------------------------------

interface TreeCacheEntry {
  /** Parsed tree node array */
  data: TreeNode[];
  /** DB updated_at timestamp — used for staleness detection */
  updatedAt: string;
  /** Local timestamp (Date.now()) when this entry was cached */
  cachedAt: number;
}

/** Multi-document cache: keyed by document ID */
const cacheMap: Map<string, TreeCacheEntry> = new Map();

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Get the document tree for a specific document with two-tier caching.
 *
 * 1. If the in-memory cache is fresh (within TTL), return immediately.
 * 2. If the in-memory cache is stale, query Supabase for `updated_at` only.
 *    - If unchanged, refresh TTL without re-fetching the JSONB payload.
 *    - If changed (or no prior cache), fetch the full tree and update cache.
 * 3. On any error, return stale cache data if available, else empty array.
 */
export async function getCachedDocumentTree(documentName: string): Promise<TreeNode[]> {
  const now = Date.now();
  const cache = cacheMap.get(documentName) || null;

  // ── L1: Return from memory if within TTL ─────────────────────────────
  if (cache && (now - cache.cachedAt) < TREE_CACHE_TTL_MS) {
    return cache.data;
  }

  // ── L2: Supabase fetch ───────────────────────────────────────────────
  try {
    const supabase = createAdminClient();

    // Lightweight staleness check — only fetch the timestamp column
    if (cache) {
      const { data: meta, error: metaError } = await supabase
        .from('document_trees')
        .select('updated_at')
        .eq('document_name', documentName)
        .single();

      if (!metaError && meta && meta.updated_at === cache.updatedAt) {
        // Data hasn't changed — just refresh the TTL
        const refreshed = { ...cache, cachedAt: now };
        cacheMap.set(documentName, refreshed);
        debugLog(`🌳 Tree cache TTL refreshed for ${documentName} (data unchanged)`);
        return refreshed.data;
      }
    }

    // Full fetch — either first load or data has changed
    const { data, error } = await supabase
      .from('document_trees')
      .select('tree_data, updated_at')
      .eq('document_name', documentName)
      .single();

    if (error || !data) {
      // Fallback: try the RPC
      const { data: rpcData, error: rpcError } = await supabase.rpc(
        'get_document_tree',
        { p_document_name: documentName }
      );

      if (!rpcError && rpcData) {
        const tree = rpcData as TreeNode[];
        cacheMap.set(documentName, { data: tree, updatedAt: new Date().toISOString(), cachedAt: now });
        debugLog(`🌳 Tree cache populated via RPC for ${documentName}: ${tree.length} nodes`);
        return tree;
      }

      // Return stale cache if available
      if (cache) {
        console.warn(`🌳 Returning stale tree cache for ${documentName} (fetch failed)`);
        cacheMap.set(documentName, { ...cache, cachedAt: now });
        return cache.data;
      }

      console.warn(`🌳 No document tree available for ${documentName}:`, error?.message);
      return [];
    }

    const tree = (data.tree_data || []) as TreeNode[];
    cacheMap.set(documentName, {
      data: tree,
      updatedAt: data.updated_at,
      cachedAt: now,
    });
    debugLog(`🌳 Tree cache refreshed for ${documentName}: ${tree.length} nodes`);
    return tree;
  } catch (error) {
    console.error(`🌳 Tree cache error for ${documentName}:`, error);

    // Graceful degradation — stale data beats no data
    if (cache) {
      console.warn(`🌳 Returning stale tree cache for ${documentName} due to error`);
      return cache.data;
    }
    return [];
  }
}

/**
 * Get trees for ALL documents that have trees in the database.
 * Returns a map of documentName -> TreeNode[]
 */
export async function getAllCachedDocumentTrees(): Promise<Map<string, TreeNode[]>> {
  const result = new Map<string, TreeNode[]>();

  try {
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from('document_trees')
      .select('document_name, tree_data, updated_at');

    if (error || !data) {
      console.warn('🌳 Failed to fetch all document trees:', error?.message);
      // Return whatever is in the cache
      for (const [name, entry] of cacheMap) {
        result.set(name, entry.data);
      }
      return result;
    }

    const now = Date.now();
    for (const row of data) {
      const tree = (row.tree_data || []) as TreeNode[];
      cacheMap.set(row.document_name, {
        data: tree,
        updatedAt: row.updated_at,
        cachedAt: now,
      });
      result.set(row.document_name, tree);
    }

    return result;
  } catch (error) {
    console.error('🌳 Error fetching all document trees:', error);
    for (const [name, entry] of cacheMap) {
      result.set(name, entry.data);
    }
    return result;
  }
}

/**
 * Immediately clear the in-memory tree cache for a specific document or all.
 * Call this after PDF re-ingestion so the next request fetches fresh data.
 */
export function clearDocumentTreeCache(documentName?: string): void {
  if (documentName) {
    cacheMap.delete(documentName);
    debugLog(`🌳 Tree cache cleared for ${documentName}`);
  } else {
    cacheMap.clear();
    debugLog('🌳 All tree caches cleared');
  }
}

// -----------------------------------------------------------------------------
// Test helpers (exported for unit tests only)
// -----------------------------------------------------------------------------

/** @internal — get raw cache state for assertions */
export function _getCacheState(): TreeCacheEntry | null {
  // Return first entry for backward compat in tests
  const first = cacheMap.values().next().value;
  return first || null;
}

/** @internal — seed the cache for testing */
export function _seedCache(entry: TreeCacheEntry | null, documentName = 'test-document'): void {
  cacheMap.clear();
  if (entry) {
    cacheMap.set(documentName, entry);
  }
}
