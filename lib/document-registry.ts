// ============================================================================
// Document Registry — Fully DB-driven, no hardcoded documents
// In-memory cache with 5-min TTL for hot-path performance
// ============================================================================

export interface DocumentInfo {
  /** Unique identifier used in database (document_name column) */
  id: string;
  /** Human-readable display name */
  displayName: string;
  /** Short abbreviation for UI badges */
  shortName: string;
  /** Filename in public/ folder */
  fileName: string;
  /** Original source URL for attribution */
  sourceUrl: string;
  /** Publishing authority */
  authority: string;
  /** Brief description */
  description: string;
  /** Color for UI badges (tailwind class) */
  badgeColor: string;
}

// -----------------------------------------------------------------------------
// In-Memory Cache
// -----------------------------------------------------------------------------

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

interface RegistryCache {
  docs: DocumentInfo[];
  byId: Map<string, DocumentInfo>;
  ts: number;
}

let cache: RegistryCache | null = null;
// In-flight refresh promise — deduplicates concurrent cache misses
let refreshPromise: Promise<RegistryCache> | null = null;

function isCacheValid(): boolean {
  return cache !== null && Date.now() - cache.ts < CACHE_TTL;
}

/** Force-invalidate the registry cache (call after admin edits documents) */
export function invalidateRegistryCache(): void {
  cache = null;
  // A-H-2: reset the warn dedup set so any post-invalidation cold-miss
  // still surfaces in logs (otherwise a renamed document would silently
  // re-trip the fallback for the remainder of the process lifetime).
  _warnedIds.clear();
  // Don't cancel an in-flight refresh; it will complete and overwrite with fresh data
}

// -----------------------------------------------------------------------------
// Async Functions — DB-backed with cache
// -----------------------------------------------------------------------------

/** Internal: fetch from DB and populate cache */
async function doRefreshCache(): Promise<RegistryCache> {
  // Returned on DB error — ts=0 so isCacheValid() always returns false, so the
  // next call re-tries. Crucially we do NOT assign this to `cache`, otherwise a
  // single hiccup would silently empty the registry for 5 minutes.
  const transient: RegistryCache = { docs: [], byId: new Map(), ts: 0 };

  try {
    const { createAdminClient } = await import('@/lib/supabase-server');
    const supabase = createAdminClient();

    const { data, error } = await supabase
      .from('document_registry')
      .select('*')
      .eq('is_active', true)
      .order('created_at');

    if (error) return transient;

    // Legitimate empty (admin deleted everything, fresh install) — safe to cache.
    const rows = data ?? [];
    const docs = rows.map(mapRow);
    const byId = new Map(docs.map(d => [d.id, d]));
    const result: RegistryCache = { docs, byId, ts: Date.now() };
    cache = result;
    return result;
  } catch {
    return transient;
  }
}

/** Load all active documents from DB into cache (deduplicates concurrent calls) */
async function refreshCache(): Promise<RegistryCache> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = doRefreshCache().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

/** Get all active documents (async, refreshes cache if stale) */
export async function getAllDocuments(): Promise<DocumentInfo[]> {
  if (isCacheValid()) return cache!.docs;
  const result = await refreshCache();
  return result.docs;
}

/** Get document info by ID (async, refreshes cache if stale) */
export async function getDocumentById(id: string): Promise<DocumentInfo | undefined> {
  if (isCacheValid()) return cache!.byId.get(id);
  const result = await refreshCache();
  return result.byId.get(id);
}

/** Get document info by filename (async) */
export async function getDocumentByFileName(fileName: string): Promise<DocumentInfo | undefined> {
  const docs = await getAllDocuments();
  return docs.find(doc => doc.fileName === fileName);
}

/** Get all document IDs (async) */
export async function getAllDocumentIds(): Promise<string[]> {
  const docs = await getAllDocuments();
  return docs.map(d => d.id);
}

/** Get PDF path for a document (async) */
export async function getDocumentPdfPath(docId: string): Promise<string> {
  const doc = await getDocumentById(docId);
  if (!doc) throw new Error(`Unknown document: ${docId}`);
  return `public/${doc.fileName}`;
}

// -----------------------------------------------------------------------------
// Sync Functions — Read from cache only (for render/hot paths)
// Cache MUST be populated by a prior async call in the request lifecycle
// -----------------------------------------------------------------------------

/** Get document by ID from cache (sync, no DB call). Returns undefined if cache empty. */
export function getDocumentByIdSync(id: string): DocumentInfo | undefined {
  const hit = cache?.byId.get(id);
  if (!hit) {
    // A-H-2 / v1.7.0 Part C: surface cold-misses so the "Building Code"
    // fallback label in rag.buildContext is OBSERVABLE. Callers SHOULD
    // ensure the cache is warmed (await getAllDocuments() at the start of
    // the pipeline) before reaching this getter; a cold miss in the chat
    // hot path means citations land with a generic doc name instead of
    // the real displayName + badge color. Rate-limited via _warnedIds
    // so a quiet stream of misses doesn't flood Vercel logs.
    if (!_warnedIds.has(id)) {
      _warnedIds.add(id);
      console.warn(
        `[document-registry] getDocumentByIdSync cold miss for "${id}" — ` +
          'cache empty or id unknown. Citations will use the generic label.',
      );
    }
  }
  return hit;
}

// A-H-2 — bounded set so repeated misses for the same id don't spam. Reset
// from invalidateRegistryCache() so the next mutation gets a fresh window
// to surface real changes.
const _warnedIds = new Set<string>();

/** Get all documents from cache (sync). Returns empty array if cache empty. */
export function getAllDocumentsSync(): DocumentInfo[] {
  return cache?.docs ?? [];
}

/** Get all document IDs from cache (sync). */
export function getAllDocumentIdsSync(): string[] {
  return cache?.docs.map(d => d.id) ?? [];
}

// -----------------------------------------------------------------------------
// Helper
// -----------------------------------------------------------------------------

function mapRow(row: Record<string, unknown>): DocumentInfo {
  return {
    id: row.id as string,
    displayName: (row.display_name as string) || '',
    shortName: (row.short_name as string) || '',
    fileName: (row.file_name as string) || '',
    sourceUrl: (row.source_url as string) || '',
    authority: (row.authority as string) || '',
    description: (row.description as string) || '',
    badgeColor: (row.badge_color as string) || '',
  };
}
