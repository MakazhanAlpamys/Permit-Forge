// ============================================================================
// Document Tree Cache (Two-Tier: In-Memory + Supabase)
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
import type { TreeNode } from '@/types';

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const DOCUMENT_NAME = 'Dubai Building Code 2021';

/** Cache TTL in milliseconds (5 minutes) */
export const TREE_CACHE_TTL_MS = 5 * 60 * 1000;

// -----------------------------------------------------------------------------
// Cache State
// -----------------------------------------------------------------------------

interface TreeCacheEntry {
  /** Parsed tree node array */
  data: TreeNode[];
  /** DB updated_at timestamp — used for staleness detection */
  updatedAt: string;
  /** Local timestamp (Date.now()) when this entry was cached */
  cachedAt: number;
}

let cache: TreeCacheEntry | null = null;

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Get the document tree with two-tier caching.
 *
 * 1. If the in-memory cache is fresh (within TTL), return immediately.
 * 2. If the in-memory cache is stale, query Supabase for `updated_at` only.
 *    - If unchanged, refresh TTL without re-fetching the JSONB payload.
 *    - If changed (or no prior cache), fetch the full tree and update cache.
 * 3. On any error, return stale cache data if available, else empty array.
 */
export async function getCachedDocumentTree(): Promise<TreeNode[]> {
  const now = Date.now();

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
        .eq('document_name', DOCUMENT_NAME)
        .single();

      if (!metaError && meta && meta.updated_at === cache.updatedAt) {
        // Data hasn't changed — just refresh the TTL
        cache = { ...cache, cachedAt: now };
        console.log('🌳 Tree cache TTL refreshed (data unchanged)');
        return cache.data;
      }
    }

    // Full fetch — either first load or data has changed
    const { data, error } = await supabase
      .from('document_trees')
      .select('tree_data, updated_at')
      .eq('document_name', DOCUMENT_NAME)
      .single();

    if (error || !data) {
      // Fallback: try the RPC
      const { data: rpcData, error: rpcError } = await supabase.rpc(
        'get_document_tree',
        { p_document_name: DOCUMENT_NAME }
      );

      if (!rpcError && rpcData) {
        const tree = rpcData as TreeNode[];
        cache = { data: tree, updatedAt: new Date().toISOString(), cachedAt: now };
        console.log(`🌳 Tree cache populated via RPC: ${tree.length} nodes`);
        return tree;
      }

      // Return stale cache if available
      if (cache) {
        console.warn('🌳 Returning stale tree cache (fetch failed)');
        cache = { ...cache, cachedAt: now };
        return cache.data;
      }

      console.warn('🌳 No document tree available:', error?.message);
      return [];
    }

    const tree = (data.tree_data || []) as TreeNode[];
    cache = {
      data: tree,
      updatedAt: data.updated_at,
      cachedAt: now,
    };
    console.log(`🌳 Tree cache refreshed: ${tree.length} nodes (updated: ${data.updated_at})`);
    return tree;
  } catch (error) {
    console.error('🌳 Tree cache error:', error);

    // Graceful degradation — stale data beats no data
    if (cache) {
      console.warn('🌳 Returning stale tree cache due to error');
      return cache.data;
    }
    return [];
  }
}

/**
 * Immediately clear the in-memory tree cache.
 * Call this after PDF re-ingestion so the next request fetches fresh data.
 */
export function clearDocumentTreeCache(): void {
  cache = null;
  console.log('🌳 Tree cache cleared');
}

// -----------------------------------------------------------------------------
// Test helpers (exported for unit tests only)
// -----------------------------------------------------------------------------

/** @internal — get raw cache state for assertions */
export function _getCacheState(): TreeCacheEntry | null {
  return cache;
}

/** @internal — seed the cache for testing */
export function _seedCache(entry: TreeCacheEntry | null): void {
  cache = entry;
}
