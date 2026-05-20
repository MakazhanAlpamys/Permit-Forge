# PermitForge — Phase 2 Simplification Audit

Scope: Top 20 simplification opportunities across `actions/`, `components/`, `lib/`. Analysis only — no code changes performed.

Ranking criteria: estimated LOC saved × frequency of duplicated pattern × clarity gain, weighted down by risk.

---

## Server Actions

### 1. Repeated `requireAuth + requireCSRF + try/catch + validation` boilerplate (HIGH IMPACT)
**Files / lines:**
- `actions/permits.ts` (~9 actions, each with same prologue: lines 52–112, 118–169, 175–225, 231–326, 461–534, 540–616, 622–695)
- `actions/admin.ts` (lines 168–221, 227–273, 279–361, 367–421, 427–480)
- `actions/admin-permits.ts` (lines 60–170, 176–249)
- `actions/documents.ts` (lines 99–183, 189–284, 290–324, 330–415)
- `actions/chat-history.ts` (lines 298–347, 353–398)
- `actions/permit-attachments.ts` (lines 33–153, 159–230)
- `actions/profile.ts` (lines 51–108, 114–145, 151–220, 226–271)
- `actions/ingest-pdf.ts` (lines 18–127, 133–218, 224–279)

**Current pattern (repeated 25+ times):**
```ts
try {
  const authCheck = await requireAuth(); // or requireAdmin
  if (!authCheck.success || !authCheck.user) return { success: false, error: authCheck.error };
  const csrf = await requireCSRF(csrfToken);
  if (!csrf.valid) return { success: false, error: csrf.error };
  const validation = SomeSchema.safeParse(data);
  if (!validation.success) return { success: false, error: validation.error.issues[0].message };
  // ... real work ...
} catch (error) {
  console.error('xyz error:', error);
  return { success: false, error: 'Failed to ...' };
}
```

**Proposed simplification:** Extract a higher-order wrapper helper in `lib/security.ts`, e.g. `withMutation({ admin?: boolean, schema?: ZodSchema, csrf: string }, handler)` that returns the standard `{ success, error }` shape. Each action body collapses from ~20 lines of boilerplate to 1 wrapping call.

**Risk:** MEDIUM — requires unifying response shape (already de-facto unified) and ensuring all tests still pass. Public action signatures unchanged.

**LOC saved:** ~250–350 LOC across the codebase.

---

### 2. Duplicate `safeEqual` + 6-digit code attempt-tracker logic (LOW)
**Files / lines:**
- `actions/auth.ts` (lines 32–67) — `safeEqual`, `codeAttempts` map, `checkCodeAttempts`, `resetCodeAttempts`
- `actions/profile.ts` (lines 14–21) — `safeEqual` duplicated verbatim; same code-attempt logic done with a different mechanism (RPC `check_rate_limit` lines 184–196)

**Proposed simplification:** Move `safeEqual`, `checkCodeAttempts`, `resetCodeAttempts` into a single `lib/code-verification.ts` helper. `actions/profile.ts` becomes consistent with `actions/auth.ts` (in-memory tracker rather than DB rate-limit RPC, or vice versa).

**Risk:** LOW — pure utility move, callers identical.

**LOC saved:** ~30 LOC + consistency win.

---

### 3. Repeated `validatePassword` re-import via dynamic `import()` (LOW)
**Files / lines:**
- `actions/admin.ts` line 448: `const { validatePassword } = await import('@/lib/validations');`
- `actions/profile.ts` already imports `validatePassword` statically (line 11).

**Proposed simplification:** Replace the dynamic import in `admin.ts` with a static top-of-file import. The dynamic import here serves no code-splitting purpose (it's already a server action).

**Risk:** LOW.

**LOC saved:** 1 line + readability.

---

### 4. Audit logging boilerplate at end of every mutation (MEDIUM)
**Files / lines:** Same files as #1 — 25+ occurrences of:
```ts
const metadata = await getRequestMetadata();
await logAuditEvent({ userId: ..., action: '...', metadata: {...}, ...metadata });
```

**Proposed simplification:** Roll this into the `withMutation` wrapper from #1, accepting `audit: { action, metadata }` config. Or introduce a `logAuditWithMeta(userId, action, metadata)` one-liner in `lib/auth.ts` to collapse the 2-line dance into 1 line.

**Risk:** LOW (helper function), MEDIUM if rolled into wrapper.

**LOC saved:** ~50 LOC.

---

### 5. Verbose snake_case → camelCase row mappers in admin/analytics actions (MEDIUM)
**Files / lines:**
- `actions/admin.ts` lines 79–90 (audit log row mapper), lines 142–154 (admin user mapper)
- `actions/analytics.ts` lines 81–93, 126–133, 198–204, 250–259, 295–302
- `actions/documents.ts` lines 421–438 (`mapDbRow`)
- `actions/permit-attachments.ts` lines 16–27 (`transformAttachment`)
- `lib/transforms.ts` (`transformPermit`)

**Current pattern:** Every server action that returns DB rows has a hand-written field-by-field mapper, often inline with `Number(stats.x) || 0` repeated 10× per function.

**Proposed simplification:**
1. Introduce a generic `snakeToCamel<T>(row)` in `lib/transforms.ts` that handles the common `_` → camelCase transform — works for the 80% case (audit log, analytics rows, document registry). Hand-written mappers only for cases needing computed/optional fields.
2. Add a `numOrZero(v)` helper to remove `Number(x) || 0` repetition.

**Risk:** MEDIUM — type erosion if not done carefully. Stick to per-function mappers for permits/permits-attachments where shapes are deeply nested.

**LOC saved:** ~80 LOC.

---

### 6. Verify-permit-ownership pattern duplicated across actions (MEDIUM)
**Files / lines:**
- `actions/permits.ts` lines 33–46 (`verifyPermitOwnership`) — used 6× in same file
- Inline ownership checks in `actions/permit-attachments.ts` lines 60–68, 191–193, 252–262
- `actions/chat-history.ts` lines 17–30 — analogous `verifySessionOwnership`

**Current pattern:** Each ownership check does `select('user_id').eq('id', ...).single()` then compares.

**Proposed simplification:** Extract a generic `verifyOwnership(table: string, idColumn: 'id', recordId: string, userId: string)` in `lib/security.ts`. Tests for 3 helpers collapse to 1.

**Risk:** LOW — pure refactor.

**LOC saved:** ~25 LOC.

---

### 7. `getIngestionStatus` fallback aggregation is dead-code-on-success-path (LOW)
**File:** `actions/ingest-pdf.ts` lines 330–366.
**Current pattern:** A 35-line in-memory aggregation fallback runs only when `get_document_stats` RPC is missing (migration not run). The migration has been run for any deployed environment.

**Proposed simplification:** Drop the fallback or extract to a separate `legacy-aggregation.ts` only loaded if the RPC explicitly returns "function does not exist". Right now the fallback is in the hot path.

**Risk:** LOW — fallback is technically dead in production.

**LOC saved:** ~30 LOC.

---

### 8. RPC + direct-query "fallback" duplicates in `actions/documents.ts` (MEDIUM)
**File:** `actions/documents.ts` lines 66–86, 125–162, 210–222.
**Current pattern:** Every CRUD function tries an RPC, falls back to a direct query. Same pattern repeated 3× (get / upsert / delete).

**Proposed simplification:** Either remove fallbacks (RPCs are seeded in `000_full_setup.sql`, so they should always exist) or factor out a `tryRpcOrFallback(rpcCall, fallback)` helper. Most likely: just remove the fallbacks since the migration is mandatory.

**Risk:** MEDIUM — could break local dev if a developer skips the migration.

**LOC saved:** ~60 LOC.

---

### 9. `actions/chat-history.ts` cursor-pagination pattern duplicated 2× (LOW)
**File:** `actions/chat-history.ts` lines 145–203 (`getChatSessions`), 216–292 (`getSessionMessages`).
**Current pattern:** `limit + 1` fetch, `hasMore = rows.length > limit`, `pop()`, derive `nextCursor`.

**Proposed simplification:** Generic helper `paginateByCursor<T>(query, limit, cursorField)` returning `{ rows, hasMore, nextCursor }`. Both functions reduce by ~10 lines each.

**Risk:** LOW.

**LOC saved:** ~20 LOC.

---

## lib

### 10. `queryBuildingCode` and `queryBuildingCodeFiltered` duplicate ~80% of code (HIGH)
**File:** `lib/rag.ts` lines 138–187 vs 324–377.
**Current pattern:** Both functions: detect `needsExactSearch`, run optional `exactSearch`, run hybrid (regular vs filtered), merge / dedupe / sort / slice / `buildContext`. Only the hybrid call differs.

**Proposed simplification:** Single `queryBuildingCode(params, opts: { pageRanges?: PageRange[] })`. The `pageRanges` switch chooses between `hybridSearch` and `filteredHybridSearch`. The exact-search post-filter logic conditionally runs.

**Risk:** MEDIUM — both are exported and tested separately; need to update `chat-pipeline.ts` callers.

**LOC saved:** ~50 LOC.

---

### 11. Duplicated metadata-defaults destructure in `lib/rag.ts` (LOW)
**File:** `lib/rag.ts` lines 67–81, 116–127, 284–298.
**Current pattern:** Same defensive 4-line spread on every RPC result row:
```ts
metadata: { ...(item.metadata || {}), page: ..., startPage: ..., endPage: ... } as ChunkMetadata
```

**Proposed simplification:** Extract `normalizeChunkMetadata(meta: unknown): ChunkMetadata` and `mapHybridRow(item)` / `mapExactRow(item)` helpers. 3 call sites collapse to 1-liners.

**Risk:** LOW.

**LOC saved:** ~15 LOC.

---

### 12. `pdf-ingestion.ts` — `splitWithPageTracking` and `createParentChunks` share 60% of logic (MEDIUM)
**File:** `lib/pdf-ingestion.ts` lines 63–143 vs 522–593.
**Current pattern:** Both build `fullText` from pages, run a `RecursiveCharacterTextSplitter`, walk `rawChunks` to compute page ranges via position lookup, and emit `*ChunkData[]`. Page-range computation differs slightly (two implementations of "find pages overlapping range").

**Proposed simplification:** Extract a `chunkPagesAtSize(pages, size, overlap)` helper that returns `Array<{ content, startPage, endPage }>`. Both callers wrap with their own metadata enrichment.

**Risk:** MEDIUM — page-attribution logic is subtly different between the two; needs careful preserving of behaviour to keep citations accurate.

**LOC saved:** ~50 LOC.

---

### 13. `runIngestionPipeline` is 300+ lines with 8 inline stages (HIGH)
**File:** `lib/pdf-ingestion.ts` lines 197–504.
**Current pattern:** One function does: parse → TOC → save tree → extract text → keyword extract → split → check existing → create parents → batch embed → batch insert. Each stage emits its own progress event with hand-coded `progress: 5/8/9/10/12/...` numbers.

**Proposed simplification:** Split into private stage functions, each taking shared `IngestionContext`. Add a `Stage` array with `{ name, weight }` so progress is computed automatically. Top-level pipeline is a 20-line for-loop. Also drops the hand-tuned magic progress numbers.

**Risk:** MEDIUM — requires care around the resume-support branch (lines 314–369). Can be done incrementally.

**LOC saved:** ~30–60 LOC. Bigger benefit is readability/testability.

---

### 14. Duplicated regex patterns for "exact-search detection" (LOW)
**File:** `lib/rag.ts` lines 147 vs 332, plus `lib/agents.ts` lines 109–118.
**Current pattern:** Three separate regexes for "section X.Y / table X / chapter X" detection.

**Proposed simplification:** Single `EXACT_REFERENCE_REGEX` constant exported from `lib/agents.ts`. Single `extractExactPattern(query): string | null` helper.

**Risk:** LOW — pure dedupe.

**LOC saved:** ~10 LOC + bug-resistance (right now the patterns can drift).

---

### 15. `saveDocumentTree` + `saveDocumentTreeDirect` fallback pattern (LOW)
**File:** `lib/pdf-ingestion.ts` lines 772–826.
**Current pattern:** RPC try, parse error message for "does not exist", call direct upsert. Same as #8.

**Proposed simplification:** Remove fallback since `save_document_tree` is in `000_full_setup.sql`. Or extract the fallback pattern into `tryRpcOrUpsert` helper.

**Risk:** LOW (or MEDIUM if removing fallback breaks dev environments).

**LOC saved:** ~25 LOC.

---

### 16. `lib/rag.ts` exact-search pattern matching duplicated inside both queries (LOW)
**File:** `lib/rag.ts` lines 147–158 and 332–351.
**Current pattern:** Same 10 lines copy-pasted, only `pageRanges` filter differs.

**Proposed simplification:** Extract `runExactSearchIfApplicable(query, pageRanges?): MatchedChunk[]` helper.

**Risk:** LOW.

**LOC saved:** ~15 LOC.

---

## Components

### 17. `pdf-ingestion-tab.tsx` and `document-management.tsx` share ~150 LOC of ingestion-streaming logic (HIGH)
**Files / lines:**
- `components/admin/pdf-ingestion-tab.tsx` lines 98–179 (`handleIngestDocument`, `handleClearDocument`), plus diagnostics state (lines 55–96)
- `components/admin/document-management.tsx` lines 301–398 (same `handleIngestDocument`, `handleClearChunks`), same diagnostics structure

**Current pattern:** SSE parsing loop with `data: ` prefix, buffer-line splitting, JSON parse, `setActiveProgress` / `setIngestionStatus` / `setIngestionMessages` updates — implemented twice nearly verbatim.

**Proposed simplification:**
1. Extract a custom hook `useIngestionStream()` in `components/admin/_hooks/` that returns `{ ingest, clear, statuses, messages, progress }`.
2. Question whether `pdf-ingestion-tab.tsx` is still needed at all — `document-management.tsx` already includes ingestion. If `PdfIngestionTab` is no longer linked, delete it.

**Risk:** LOW (extract hook), HIGH (deleting `PdfIngestionTab` requires verifying no one routes to it — check `app/admin/page.tsx`).

**LOC saved:** ~150 LOC if `PdfIngestionTab` is dead, ~80 LOC if just hook-extracted.

---

### 18. `user-management.tsx` modal logic — 6 dialogs with identical scaffolding (MEDIUM)
**File:** `components/admin/user-management.tsx` lines 391–576.
**Current pattern:** 6 near-identical `<Dialog>` blocks (block, role, password, delete, success, error), each ~25 lines. Modal state machine `{ type: ModalType, user, message }` has 6 branches.

**Proposed simplification:**
1. Extract `<ConfirmDialog>` and `<MessageDialog>` reusable components — reduces 6 dialogs to 4 simple confirms + 2 message dialogs (or 1 generic `<ResultDialog>`).
2. The success/error dialogs are functionally identical except for color/title — one `<ResultDialog kind="success" | "error">` collapses to ~20 lines total.
3. `validatePassword` (lines 162–171) is duplicated from `lib/validations.ts` — should call the shared zod schema or `validatePassword` from `lib/validations`.

**Risk:** LOW — pure UI refactor.

**LOC saved:** ~80 LOC.

---

### 19. `chat-interface.tsx` SSE parsing + abort-controller dance (MEDIUM)
**File:** `components/chat/chat-interface.tsx` lines 165–395 — single `handleSendMessage` is ~220 lines.

**Current pattern:** One function manages: rate-limit → abort previous → create session → optimistic UI add → fetch SSE → manual chunk assembly with `__CITATIONS__` / `__ERROR__` markers → 4 different cancellation flags (`isCancelledRef`, `isMountedRef`, `controller.signal`, `abortControllerRef`).

**Proposed simplification:**
1. Extract `useChatStream({ csrfToken, onComplete })` hook returning `{ send, abort, isStreaming, content, error }`. Encapsulates the SSE marker protocol.
2. Stream protocol uses positional markers (`__CITATIONS__`, `__ERROR__`) — consider switching to event-typed SSE (`event: citation\ndata: {...}\n\n`) which is simpler to parse and also benefits the ingestion stream (#17).
3. Multiple cancellation flags can collapse to a single `AbortController` once the hook owns lifecycle.

**Risk:** MEDIUM — touches the live chat path; needs E2E test coverage of cancel/retry/error scenarios. The marker protocol change touches `app/api/chat/stream/route.ts` too.

**LOC saved:** ~80 LOC + significant complexity reduction.

---

### 20. `document-management.tsx` form state + effect cluster (MEDIUM)
**File:** `components/admin/document-management.tsx` lines 106–272 (`DocumentManagement` component head with 13 useState calls + effects).

**Current pattern:** 13 useState hooks on one component, plus `formData` / `formError` / `editingId` / `pdfFile` / `uploading` / `saving` etc. Form open/close state intertwined with diagnostic state and ingestion state.

**Proposed simplification:**
1. Split into `<DocumentManagement>` (list + diagnostics) and `<DocumentForm>` (modal/inline form). Form has its own state.
2. Combine related state with `useReducer` for the form (`{ open, editingId, data, error, saving, file, uploading }`) — reduces 7 setters to 1 dispatch.
3. `BADGE_COLORS` (lines 90–100) is hardcoded inline; move to `lib/constants.ts`.

**Risk:** MEDIUM — component-restructuring; test coverage exists but UI flow needs manual smoke test.

**LOC saved:** ~50 LOC + clearer ownership.

---

## Summary

| Rank | Title | Risk | Est. LOC Saved |
|------|-------|------|---------------:|
| 1 | Auth/CSRF/validation/try-catch wrapper for server actions | MEDIUM | 250–350 |
| 2 | Dedupe `safeEqual` + code-attempt tracker | LOW | 30 |
| 3 | Static-import `validatePassword` | LOW | 1 |
| 4 | Audit-log boilerplate helper | LOW | 50 |
| 5 | Generic snake_case→camelCase row mapper | MEDIUM | 80 |
| 6 | Generic `verifyOwnership` helper | LOW | 25 |
| 7 | Drop dead `getIngestionStatus` fallback | LOW | 30 |
| 8 | Drop or factor RPC-fallback duplications in `documents.ts` | MEDIUM | 60 |
| 9 | Generic cursor pagination helper | LOW | 20 |
| 10 | Merge `queryBuildingCode` + `queryBuildingCodeFiltered` | MEDIUM | 50 |
| 11 | Extract chunk-metadata normaliser | LOW | 15 |
| 12 | Share chunk/page-range logic between child & parent splitters | MEDIUM | 50 |
| 13 | Decompose `runIngestionPipeline` into stage functions | MEDIUM | 30–60 |
| 14 | Single `EXACT_REFERENCE_REGEX` | LOW | 10 |
| 15 | Drop or factor `saveDocumentTree` fallback | LOW | 25 |
| 16 | Extract exact-search pattern helper | LOW | 15 |
| 17 | Dedupe ingestion-streaming logic + check if `PdfIngestionTab` is dead | LOW–HIGH | 80–150 |
| 18 | Reusable `<ConfirmDialog>`/`<ResultDialog>` in user-management | LOW | 80 |
| 19 | `useChatStream` hook + SSE protocol cleanup | MEDIUM | 80 |
| 20 | Split `DocumentManagement` + form `useReducer` | MEDIUM | 50 |

**Total estimated savings:** ~1,030–1,300 LOC (5–6% of the 21,579-line codebase) with proportional readability gains.

## Quick wins (do these first, all LOW risk, ~250 LOC)
- #2 dedupe `safeEqual`
- #3 static import
- #6 `verifyOwnership` helper
- #9 cursor pagination helper
- #11 chunk-metadata normaliser
- #14 `EXACT_REFERENCE_REGEX`
- #16 exact-search helper
- #18 `<ConfirmDialog>`/`<ResultDialog>`

## Highest leverage (most LOC saved)
- #1 server-action wrapper (single biggest win)
- #17 ingestion-streaming dedupe (especially if `PdfIngestionTab` is dead code)
- #19 chat stream hook (reduces complexity even more than LOC)

## Investigation items (verify first)
- Is `components/admin/pdf-ingestion-tab.tsx` still routed from `app/admin/page.tsx`? If yes, are both shown (i.e. duplicate UI for users)? See item #17.
- Is `actions/ingest-pdf.ts > clearChunks` (legacy clear-all) still called from any UI? If not, delete it (~50 LOC).
- Are the fallback branches in `actions/documents.ts` (#8) and `lib/pdf-ingestion.ts > saveDocumentTree` (#15) ever hit in practice? If migrations are mandatory, they're dead code.
