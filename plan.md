# Plan: Fully Dynamic Document Registry + Auto-Keywords

## Goal

Remove all hardcoded documents from code. Make the system 100% DB-driven:
- Documents exist ONLY in `document_registry` table
- Keywords auto-generated from PDF text during ingestion (TF-IDF, 0 API)
- Admin can edit/add/remove keywords through UI
- Seed migration inserts 5 default documents as initial data (deletable by admin)

---

## Current State (what we have now)

Documents hardcoded in **3 places**:
1. `lib/document-registry.ts` — `DEFAULT_REGISTRY` (5 docs with metadata)
2. `lib/document-selector.ts` — `DOCUMENT_PROFILES` (5 docs with keywords/categories)
3. `lib/chat-pipeline.ts` — `GREETING_RESPONSE` and `OFF_TOPIC_RESPONSE` list docs by name

All sync helper functions (`getDocumentById`, `getAllDocuments`, etc.) read from hardcoded objects.
DB is secondary — only used in admin UI and as fallback merge.

**Callers of hardcoded registry (files to update):**

| File | Functions Used | Sync/Async |
|------|---------------|------------|
| `lib/rag.ts:217,231` | `getDocumentById()` | sync (in `buildContext`) |
| `lib/document-selector.ts:6,168,177` | `DOCUMENT_REGISTRY`, `getAllDocumentIds` | sync |
| `lib/chat-pipeline.ts:65-75` | hardcoded doc names in strings | static |
| `actions/ingest-pdf.ts:42` | `getDocumentById()` | sync (in async fn) |
| `app/api/ingest/route.ts:54` | `getDocumentById()` | sync (in async fn) |
| `components/admin/pdf-ingestion-tab.tsx:28` | `getAllDocuments()` | sync (top-level const) |
| `components/admin/document-usage-chart.tsx:39` | `getDocumentById()` | sync (in render) |
| `test/rag.test.ts:26-31` | mocked | N/A |

---

## Implementation Plan

### Phase 1: Auto-Keyword Extraction from PDF

**New file: `lib/keyword-extractor.ts`**

TF-IDF keyword extraction from parsed PDF text. 0 API calls.

```
extractKeywords(pages: PDFPageContent[]) -> { keywords: string[], categories: string[] }
```

Algorithm:
1. Concatenate all page texts
2. Tokenize, lowercase, remove stopwords (English + common PDF noise like "page", "table of contents")
3. Calculate TF-IDF scores across document
4. Filter: min length 3 chars, max 30 chars, no pure numbers
5. Take top 40 keywords by TF-IDF score
6. Detect categories from keyword clusters (e.g., if "fire", "smoke", "alarm" present -> category "safety")

**Integration point:** `lib/pdf-ingestion.ts` — after PDF parsing (Stage 2), before embedding:
- Call `extractKeywords(pages)`
- Update `document_registry` row: `SET keywords = extracted, categories = detected`
- Only update if keywords were previously empty OR admin hasn't manually edited them (add `keywords_auto_generated BOOLEAN DEFAULT true` column)

---

### Phase 2: Make Document Registry Fully DB-Driven

**Rewrite `lib/document-registry.ts`:**

Remove `DEFAULT_REGISTRY` entirely. Replace sync functions with:

1. **In-memory cache** with 5-min TTL (same pattern as middleware block cache):
   ```ts
   let cache: { docs: DocumentInfo[], byId: Map<string, DocumentInfo>, ts: number } | null = null;
   const CACHE_TTL = 5 * 60 * 1000; // 5 min
   ```

2. **`async function loadRegistry(): Promise<void>`**
   - Fetches active docs from `document_registry` table
   - Populates cache (array + byId map)
   - Called once at startup, then refreshed on TTL expiry

3. **`async function getDocumentById(id): Promise<DocumentInfo | undefined>`**
   - Reads from cache, refreshes if stale
   - Hot path safe: cache hit is O(1) Map lookup

4. **`async function getAllDocuments(): Promise<DocumentInfo[]>`**
   - From cache

5. **`function getDocumentByIdSync(id): DocumentInfo | undefined`**
   - Reads from cache WITHOUT refresh (for render paths)
   - Returns undefined if cache is empty (no crash)

6. **`function invalidateRegistryCache(): void`**
   - Called after admin adds/removes/edits documents
   - Called after ingestion completes (keywords may have changed)

7. Remove `DOCUMENT_REGISTRY` export (replaced by async functions)
8. Remove `getDocumentListForPrompt()` — unused (only in test mock)

---

### Phase 3: Make Document Selector DB-Driven

**Rewrite `lib/document-selector.ts`:**

Remove `DOCUMENT_PROFILES` hardcoded object.

Change `selectDocuments(query)` to:
1. On first call (or cache miss), load profiles from DB:
   ```sql
   SELECT id, keywords, categories FROM document_registry WHERE is_active = true
   ```
2. Cache profiles in-memory (same TTL as registry)
3. Scoring logic stays the same (keyword matching, token overlap)
4. `injectDocumentProfiles()` no longer needed — remove

The `loadDynamicProfiles()` mechanism already exists but is additive. Change to: DB is the ONLY source.

---

### Phase 4: Update All Callers

#### 4a. `lib/rag.ts` — `buildContext()`

`getDocumentById()` is called sync inside `buildContext()`. Options:
- **Best:** Make `buildContext()` sync but use `getDocumentByIdSync()` (cache-based, no await)
- Cache is populated by the time `buildContext` runs (pipeline already did async DB calls)
- Fallback: if cache miss, show `docId` string instead of display name

Changes:
```diff
- import { getDocumentById } from '@/lib/document-registry';
+ import { getDocumentByIdSync } from '@/lib/document-registry';

- const docInfo = docId ? getDocumentById(docId) : undefined;
+ const docInfo = docId ? getDocumentByIdSync(docId) : undefined;
```

#### 4b. `actions/ingest-pdf.ts` — `ingestPDF()`

Currently: checks hardcoded registry first, then DB. Simplify to DB only:

```diff
- const docInfo = getDocumentById(documentId);
- if (docInfo) {
-   pdfPath = `public/${docInfo.fileName}`;
- } else {
-   // Check DB registry...
- }
+ // Validate documentId from DB only
+ const supabase = createAdminClient();
+ const { data: dbDoc } = await supabase
+   .from('document_registry')
+   .select('file_name, is_active')
+   .eq('id', documentId)
+   .single();
+
+ if (!dbDoc || !dbDoc.is_active) {
+   return { success: false, chunksProcessed: 0, error: 'Unknown document ID' };
+ }
+ // filename validation stays the same
+ pdfPath = `public/${sanitizedFileName}`;
```

#### 4c. `app/api/ingest/route.ts`

Same change as 4b — remove hardcoded check, DB only.

#### 4d. `components/admin/pdf-ingestion-tab.tsx`

Currently: `const DOCUMENTS = getAllDocuments();` at module level (sync, hardcoded).

Change to: load from DB via server action on mount.

```diff
- import { getAllDocuments } from '@/lib/document-registry';
- const DOCUMENTS = getAllDocuments();
+ import { getAllRegisteredDocuments } from '@/actions/documents';

// Inside component:
+ const [documents, setDocuments] = useState<DocumentRecord[]>([]);
+ useEffect(() => {
+   getAllRegisteredDocuments().then(r => setDocuments(r.data.filter(d => d.isActive)));
+ }, []);
```

This already aligns with how `document-management-tab` works.

#### 4e. `components/admin/document-usage-chart.tsx`

Currently: `getDocumentById()` sync in render. Change to prop-based or sync cache:

```diff
- import { getDocumentById } from '@/lib/document-registry';
- name: getDocumentById(d.documentName)?.shortName || d.documentName,
+ // Pass document map as prop from parent, or just show d.documentName
+ name: documentMap[d.documentName]?.shortName || d.documentName,
```

Parent component already loads docs from DB — pass down as prop.

#### 4f. `lib/chat-pipeline.ts` — Response Templates

`GREETING_RESPONSE` and `OFF_TOPIC_RESPONSE` have hardcoded doc names. Change to dynamic:

```ts
export async function getGreetingResponse(): Promise<string> {
  const docs = await getAllDocuments();
  const docList = docs.map(d => `- **${d.displayName}**`).join('\n');
  return `Hello! I'm Emirate Forge...\n\n${docList}\n\nI search across all documents...`;
}
```

For `OFF_TOPIC_RESPONSE` — same pattern, or keep it generic without listing specific docs.

#### 4g. `lib/document-selector.ts` — `getSelectedDocumentNames()`

Uses `DOCUMENT_REGISTRY[id]` for display. Change to sync cache:

```diff
- const doc = DOCUMENT_REGISTRY[id] as DocumentInfo | undefined;
+ const doc = getDocumentByIdSync(id);
```

---

### Phase 5: Integrate Auto-Keywords into Ingestion Pipeline

**`lib/pdf-ingestion.ts` — `runIngestionPipeline()`**

After Stage 3 (text extraction), before Stage 4 (chunking):

```ts
// Stage 3.5: Auto-extract keywords from PDF text
const { keywords, categories } = extractKeywords(pages);

// Update document_registry with extracted keywords (only if auto-generated)
await supabase
  .from('document_registry')
  .update({ keywords, categories, updated_at: new Date().toISOString() })
  .eq('id', documentId)
  .eq('keywords_auto_generated', true); // Don't overwrite manual edits

// Invalidate caches
invalidateRegistryCache();
```

---

### Phase 6: DB Migration Update

**Add to `supabase/migrations/000_full_setup.sql`:**

Add column:
```sql
ALTER TABLE document_registry ADD COLUMN IF NOT EXISTS keywords_auto_generated BOOLEAN DEFAULT true;
```

The existing `INSERT INTO document_registry ... ON CONFLICT DO NOTHING` seed stays — these are initial data, not hardcode. Admin can delete them. Set `keywords_auto_generated = false` for seed data since those keywords are hand-curated.

---

### Phase 7: Update Tests

**`test/rag.test.ts`:**
- Mock `getDocumentByIdSync` instead of `getDocumentById`
- Other mocks stay similar

**Other test files:**
- Check if any test imports from `document-registry` and update accordingly

---

### Phase 8: Cleanup

1. Remove `DOCUMENT_REGISTRY` export from `document-registry.ts`
2. Remove `DOCUMENT_PROFILES` from `document-selector.ts`
3. Remove `injectDocumentProfiles()` and `hasDynamicProfiles()`
4. Remove `DOCUMENT_COLORS` hardcoded map from `document-usage-chart.tsx` — use `badgeColor` from DB
5. Update CLAUDE.md to reflect new architecture

---

## File Change Summary

| File | Action |
|------|--------|
| `lib/keyword-extractor.ts` | **NEW** — TF-IDF keyword extraction |
| `lib/document-registry.ts` | **REWRITE** — remove hardcode, async + cache |
| `lib/document-selector.ts` | **REWRITE** — remove DOCUMENT_PROFILES, load from DB |
| `lib/chat-pipeline.ts` | **EDIT** — dynamic greeting/off-topic responses |
| `lib/rag.ts` | **EDIT** — use `getDocumentByIdSync()` |
| `lib/pdf-ingestion.ts` | **EDIT** — add keyword extraction step |
| `actions/ingest-pdf.ts` | **EDIT** — remove hardcoded check, DB only |
| `actions/documents.ts` | **EDIT** — call `invalidateRegistryCache()` after upsert/delete |
| `app/api/ingest/route.ts` | **EDIT** — remove hardcoded check, DB only |
| `components/admin/pdf-ingestion-tab.tsx` | **EDIT** — load docs from DB |
| `components/admin/document-usage-chart.tsx` | **EDIT** — prop-based doc lookup |
| `supabase/migrations/000_full_setup.sql` | **EDIT** — add `keywords_auto_generated` column |
| `test/rag.test.ts` | **EDIT** — update mocks |
| `CLAUDE.md` | **EDIT** — update architecture docs |

**Total: 1 new file, 13 edited files**

---

## Execution Order

1. Phase 1 — `keyword-extractor.ts` (independent, no breaking changes)
2. Phase 6 — DB migration (add column)
3. Phase 2 — Rewrite `document-registry.ts` (core change)
4. Phase 3 — Rewrite `document-selector.ts`
5. Phase 4 — Update all callers (depends on Phase 2-3)
6. Phase 5 — Integrate auto-keywords into ingestion
7. Phase 7 — Fix tests
8. Phase 8 — Cleanup + docs
9. Run `npm run lint` and `npm test` to verify

---

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| DB unavailable = no docs | Cache with long TTL (5 min). System already depends on DB for everything else |
| Async migration breaks render | Use `getDocumentByIdSync()` for render paths — returns from cache, no await |
| Keywords quality from TF-IDF | Good enough for document selector (keyword matching). Admin can edit. Better than nothing for new docs |
| Race condition on cache | Single-threaded Node.js, no real race. Cache refresh is atomic (replace whole object) |
| Existing 5 docs disappear | Seed INSERT in migration keeps them. Admin can delete if unwanted |
