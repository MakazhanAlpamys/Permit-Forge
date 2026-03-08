// ============================================================================
// Document Selector — Keyword-based document scoring (0 API)
// Scores query against each document's keywords to narrow search scope
// All profiles loaded from DB (document_registry.keywords/categories)
// ============================================================================

import { getDocumentByIdSync, getAllDocumentIdsSync } from '@/lib/document-registry';
import type { DocumentInfo } from '@/lib/document-registry';

// -----------------------------------------------------------------------------
// DB-Loaded Profiles Cache
// -----------------------------------------------------------------------------

interface DocumentSearchProfile {
  keywords: string[];
  categories: string[];
}

let profileCache: Record<string, DocumentSearchProfile> = {};
let profileCacheTs = 0;
const PROFILE_CACHE_TTL = 5 * 60 * 1000; // 5 min
// In-flight load promise — deduplicates concurrent cache misses
let profileLoadPromise: Promise<void> | null = null;

function isProfileCacheValid(): boolean {
  return profileCacheTs > 0 && Date.now() - profileCacheTs < PROFILE_CACHE_TTL;
}

/** Invalidate profile cache (call after ingestion updates keywords) */
export function invalidateProfileCache(): void {
  profileCache = {};
  profileCacheTs = 0;
  // Don't cancel in-flight load; it will complete and store fresh data
}

/** Internal: fetch profiles from DB */
async function doLoadSearchProfiles(): Promise<void> {
  try {
    const { createAdminClient } = await import('@/lib/supabase-server');
    const supabase = createAdminClient();

    const { data, error } = await supabase
      .from('document_registry')
      .select('id, keywords, categories')
      .eq('is_active', true);

    if (error || !data) {
      profileCacheTs = Date.now(); // Mark as loaded (empty)
      return;
    }

    const profiles: Record<string, DocumentSearchProfile> = {};
    for (const row of data) {
      profiles[row.id as string] = {
        keywords: (row.keywords as string[]) || [],
        categories: (row.categories as string[]) || [],
      };
    }

    profileCache = profiles;
    profileCacheTs = Date.now();
  } catch {
    profileCacheTs = Date.now(); // Mark as loaded (empty)
  }
}

/** Load search profiles from DB into cache (deduplicates concurrent calls) */
export async function loadSearchProfiles(): Promise<void> {
  if (isProfileCacheValid()) return;
  if (profileLoadPromise) return profileLoadPromise;
  profileLoadPromise = doLoadSearchProfiles().finally(() => {
    profileLoadPromise = null;
  });
  return profileLoadPromise;
}

// -----------------------------------------------------------------------------
// Document Selection
// -----------------------------------------------------------------------------

interface DocumentScore {
  documentId: string;
  score: number;
  matchedKeywords: string[];
}

/**
 * Score query against each document's keyword profile.
 * Returns selected document IDs (or all if scores are close).
 *
 * - If top score >> others (>20% gap) -> filter to top 1-3 docs
 * - If scores are close -> search all (safe fallback)
 * - 0 API calls, runs in ~1ms
 *
 * NOTE: Call loadSearchProfiles() at least once before using this function.
 * If profiles haven't been loaded, returns all document IDs.
 */
export function selectDocuments(query: string): string[] {
  const allProfiles = profileCache;

  // If no profiles loaded, search all documents
  if (Object.keys(allProfiles).length === 0) {
    return getAllDocumentIdsSync();
  }

  const queryLower = query.toLowerCase();
  const queryTokens = queryLower.split(/\s+/).filter(w => w.length > 2);

  const scores: DocumentScore[] = [];

  for (const [docId, profile] of Object.entries(allProfiles)) {
    let score = 0;
    const matched: string[] = [];

    for (const keyword of profile.keywords) {
      if (queryLower.includes(keyword)) {
        score += keyword.length > 5 ? 3 : 2;  // Longer keywords = stronger signal
        matched.push(keyword);
      }
    }

    // Token overlap bonus
    for (const token of queryTokens) {
      for (const keyword of profile.keywords) {
        if (keyword.includes(token) && !matched.includes(keyword)) {
          score += 1;
        }
      }
    }

    scores.push({ documentId: docId, score, matchedKeywords: matched });
  }

  // Sort by score descending
  scores.sort((a, b) => b.score - a.score);

  const topScore = scores[0]?.score || 0;

  // No matches -> search all documents
  if (topScore === 0) {
    return Object.keys(allProfiles);
  }

  // Check if there's a clear winner (>20% gap to second)
  const threshold = topScore * 0.8;
  const selected = scores.filter(s => s.score >= threshold && s.score > 0);

  // If too many docs selected, just search all
  if (selected.length >= 4) {
    return Object.keys(allProfiles);
  }

  return selected.map(s => s.documentId);
}

/**
 * Get display names for selected documents (for logging)
 */
export function getSelectedDocumentNames(docIds: string[]): string[] {
  return docIds.map(id => {
    const doc = getDocumentByIdSync(id) as DocumentInfo | undefined;
    return doc?.shortName || id;
  });
}
