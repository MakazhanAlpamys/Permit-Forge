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
  // Don't cancel an in-flight refresh; it will complete and overwrite with fresh data
}

// -----------------------------------------------------------------------------
// Async Functions — DB-backed with cache
// -----------------------------------------------------------------------------

/** Internal: fetch from DB and populate cache */
async function doRefreshCache(): Promise<RegistryCache> {
  try {
    const { createAdminClient } = await import('@/lib/supabase-server');
    const supabase = createAdminClient();

    const { data, error } = await supabase
      .from('document_registry')
      .select('*')
      .eq('is_active', true)
      .order('created_at');

    if (error || !data || data.length === 0) {
      const empty: RegistryCache = { docs: [], byId: new Map(), ts: Date.now() };
      cache = empty;
      return empty;
    }

    const docs = data.map(mapRow);
    const byId = new Map(docs.map(d => [d.id, d]));
    const result: RegistryCache = { docs, byId, ts: Date.now() };
    cache = result;
    return result;
  } catch {
    const empty: RegistryCache = { docs: [], byId: new Map(), ts: Date.now() };
    cache = empty;
    return empty;
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
  return cache?.byId.get(id);
}

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
