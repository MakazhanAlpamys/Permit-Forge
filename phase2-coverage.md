# PermitForge — Phase 2 Coverage Audit Report

**Date:** 2026-04-26  
**Tool:** Vitest 4 + v8 coverage  
**Test suites:** 25 passed, 566 tests passed  

---

## 1. Overall Coverage Percentages

| Metric | All Files | Actions | Lib | Components |
|--------|-----------|---------|-----|------------|
| Statements | 37.1% | 76.24% | 35.15% | 0% |
| Branches | 31.64% | 70.56% | 30.22% | 0% |
| Functions | 21.29% | 87.80% | 35.49% | 0% |
| Lines | 38.32% | 77.53% | 35.40% | 0% |

**Result: FAILS 80% threshold across all categories.** Only the `actions/` directory approaches the target; `lib/` and `components/` are critically under-covered.

---

## 2. Modules Below 80% Threshold

### lib/ (critical — production logic)

| File | Stmts % | Branch % | Funcs % | Lines % |
|------|---------|---------|---------|---------|
| `lib/auth.ts` | 30.43 | 16.21 | 35.71 | 31.25 |
| `lib/chat-pipeline.ts` | 49.35 | 34.88 | 44.44 | 50.68 |
| `lib/document-registry.ts` | 40.00 | 27.27 | 27.77 | 45.23 |
| `lib/document-selector.ts` | 0 | 0 | 0 | 0 |
| `lib/gemini.ts` | 18.66 | 5.00 | 18.75 | 19.71 |
| `lib/keyword-extractor.ts` | 0 | 0 | 0 | 0 |
| `lib/logger.ts` | 0 | 0 | 0 | 0 |
| `lib/notifications.ts` | 0 | 0 | 0 | 0 |
| `lib/pdf-ingestion.ts` | 0 | 0 | 0 | 0 |
| `lib/pdf-parser.ts` | 0 | 0 | 0 | 0 |
| `lib/permit-certificate.ts` | 0 | 0 | 0 | 0 |
| `lib/permit-compliance.ts` | 85.71 | 52.32 | 83.33 | 86.84 |
| `lib/rag.ts` | 44.44 | 38.23 | 37.93 | 45.23 |
| `lib/semantic-cache.ts` | 0 | 0 | 0 | 0 |
| `lib/supabase-server.ts` | 0 | 0 | 0 | 0 |
| `lib/tree-cache.ts` | 0 | 0 | 0 | 0 |

### actions/ (below 80%)

| File | Stmts % | Branch % | Notes |
|------|---------|---------|-------|
| `actions/auth.ts` | 70.94 | 64.64 | Rate-limit + brute-force paths untested |
| `actions/ingest-pdf.ts` | 0 | 0 | Completely untested |
| `actions/permit-attachments.ts` | 70.00 | 75.00 | Upload/delete error paths missing |
| `actions/permits.ts` | 77.73 | 75.86 | Status-transition rejection, ownership edge cases |

### components/ (entirely 0%)

All 30+ component files have 0% coverage. No React component tests exist.

---

## 3. Top 15 Missing Tests (Ranked by Criticality)

### CRITICAL — Security & Auth

**1. `middleware.ts`: No tests exist at all**  
The middleware handles JWT verification, block-status checking, role-based redirects, and security headers on every request. Missing tests:
- `x-middleware-subrequest` header returns 403
- Invalid/expired JWT clears cookie and redirects to `/login`
- Blocked user is redirected and session cookie is cleared
- Admin accessing `/` is redirected to `/admin`
- User accessing `/admin` is redirected to `/`
- Block status cache TTL behavior (within interval vs. stale)
- Missing `SUPABASE_SERVICE_ROLE_KEY` falls back to allow-through
- Concurrent block-status checks for the same userId are deduplicated

**2. `lib/auth.ts`: session management and audit logging paths (31% statements, 16% branch)**  
Covered: only `createJWTToken`, `verifyJWTToken`, `generateCSRFToken`, `validateCSRFToken`. Not covered:
- `createSession()` — cookie set with correct attributes (httpOnly, sameSite, maxAge)
- `destroySession()` — both session and CSRF cookies deleted
- `getSessionFromToken()` — missing cookie returns null; invalid token returns null
- `getSession()` — blocked user in DB returns null; DB error returns null
- `getQuickSession()` — verifies transform from JWT payload to `{id, username, role}`
- `logAuditEvent()` — DB insert error is swallowed (non-fatal), verifying this is safe

**3. `actions/auth.ts`: brute-force protection paths (64.64% branch)**  
Rate limit and code-attempt tracking branches are untested:
- `checkCodeAttempts()` returns false after 5 failed verification attempts → code is invalidated
- `resetPasswordAction()` with >5 attempts triggers code invalidation and error
- `loginAction()` rate limiting by IP address (in-memory per-IP counter)
- `registerAction()` DB insert failure returns generic error
- `logoutAction()` calls `destroySession()` and logs `logout` audit event

### HIGH — Core RAG Pipeline

**4. `lib/chat-pipeline.ts`: semantic cache HIT path (34.88% branch)**  
The `executeRAGPipeline` is tested for cache miss only. Missing:
- Cache HIT: verify `fromCache: true`, `cachedResponse` and `cachedCitations` are returned without any search/LLM call
- `ENABLE_CACHE: false` config: `searchCache` and `storeInCache` are never called
- `ENABLE_PARENT_EXPANSION: false` config: `expandToParentChunks` is never called
- `ENABLE_TREE_REASONING: false` config: always takes standard path
- Embedding generation failure: returns `{chunks: [], queryEmbedding: [], fromCache: false}`
- `getOffTopicResponse()` with empty document registry returns the no-documents message
- `getOffTopicResponse()` with populated registry includes document names
- `getGreetingResponse()` with empty registry returns the no-documents message
- `cacheResponse()` with `ENABLE_CACHE: false` does not call `storeInCache`
- Scope-detected queries route to `queryBuildingCodeFiltered` instead of `queryBuildingCode`

**5. `lib/rag.ts`: filteredHybridSearch, passesCRAGCheck, buildContext, expandToParentChunks (38% branch)**  
Only `hybridSearch` and `queryBuildingCode` are partially tested. Missing:
- `filteredHybridSearch()` — RPC success path with page ranges
- `filteredHybridSearch()` — RPC "does not exist" error falls back to `hybridSearchWithPostFilter`
- `filteredHybridSearch()` — other RPC error throws
- `passesCRAGCheck()` — empty array returns false
- `passesCRAGCheck()` — chunk with similarity exactly at `CRAG_THRESHOLD` boundary
- `buildContext()` — chunks with missing `section`/`chapter` metadata omit those fields
- `buildContext()` — content exceeding `MAX_CHUNK_LENGTH` is truncated with `...`
- `buildContext()` — multi-document chunks produce correct `CONTEXT FROM:` header
- `expandToParentChunks()` — RPC success and failure paths
- `queryBuildingCode()` with `documentFilter` of length > 1 triggers post-filtering

**6. `lib/gemini.ts`: generateEmbedding retry logic and quota handling (5% branch)**  
`generateEmbedding` has a 7-retry loop with per-minute and daily quota handling. Missing:
- Daily quota (`perday`) error throws `DailyQuotaExhaustedError` immediately without retries
- Per-minute rate limit (429) retries with parsed delay from error message
- Network error (`fetch failed`, `ECONNRESET`) retries with exponential backoff
- Non-retryable error (e.g., invalid API key) throws immediately on first attempt
- Empty `values` array from API throws `'Embedding API returned empty vector'`
- `generateChatResponse()` — context truncation at `MAX_CONTEXT_LENGTH`
- `generateChatResponse()` — user message sanitization (trim + whitespace collapse)
- `generateChatResponse()` — conversation history limited to last 10 messages

### HIGH — Permit & Compliance

**7. `lib/permit-compliance.ts`: branch coverage at 52.32%**  
Missing:
- AI returns JSON wrapped in markdown code fence (` ```json ... ``` `) — regex extraction path
- AI returns invalid `overallStatus` value → normalized to `requires_review`
- Individual check with invalid `status` → normalized to `requires_review`
- Individual check missing `codeReferences` array → defaults to `[]`
- `complianceReqs` with all flags false → fallback `categories` array is empty
- `complianceReqs` with specific combination flags → correct category names generated

**8. `lib/permit-certificate.ts`: 0% coverage**  
PDFKit certificate generation is completely untested:
- Certificate number format `PF-CERT-{YEAR}-{ID}` is correct
- All required permit fields appear in the generated PDF buffer
- Approved permit generates a PDF (Buffer returned is non-empty)
- Missing/null optional fields do not crash generation
- Certificate `generated_at` timestamp recorded in audit log

**9. `actions/permits.ts`: status-transition rejection (75.86% branch)**  
Missing:
- `submitPermit()` when permit is not in `draft` status returns error
- `submitPermit()` when building details are missing returns error
- `deletePermit()` when permit is not in `draft` status returns error
- `runComplianceCheck()` when building details are absent returns the specific error message
- `revisePermit()` when permit status is not `revision_requested` returns error
- `getPermitById()` cross-user access attempt (ownership check returning false)
- Pagination/filtering in `getUserPermits()` with `status` parameter — currently `eq` call fails (seen in test stderr)

### MEDIUM — Document & Ingestion

**10. `lib/document-selector.ts`: 0% coverage**  
Keyword-based document scoring is entirely untested:
- `selectDocuments()` with query matching keywords of one document only returns that document
- `selectDocuments()` with no keyword matches returns all documents
- `loadSearchProfiles()` fetches from DB and populates in-memory profiles
- `getSelectedDocumentNames()` maps IDs to display names
- TF-IDF scoring prefers high-frequency terms over common words

**11. `lib/document-registry.ts`: 27.77% functions**  
Only the DB path is partially exercised indirectly. Missing:
- `getAllDocuments()` cache HIT (second call within TTL returns from cache, no DB call)
- `getAllDocuments()` DB error returns empty array and caches empty
- `invalidateRegistryCache()` followed by `getAllDocuments()` triggers fresh DB fetch
- Concurrent cache misses (`refreshPromise` deduplication) — two simultaneous calls produce one DB request
- `getDocumentByIdSync()` before any cache load returns undefined (cache cold)
- `getDocumentByIdSync()` after cache load returns correct document

**12. `lib/semantic-cache.ts`: 0% coverage**  
Both `searchCache` and `storeInCache` are completely untested despite being on every non-cached request path:
- `searchCache()` — RPC returns a result above threshold: `hit: true` with response and citations
- `searchCache()` — RPC returns empty array: `hit: false`
- `searchCache()` — RPC error (non-fatal): returns `hit: false`, does not throw
- `storeInCache()` — RPC error is logged but does not throw (fire-and-forget)
- `storeInCache()` — catch block for unexpected exception is silent

**13. `actions/ingest-pdf.ts`: 0% coverage**  
The PDF ingestion trigger action has no tests at all:
- Auth and admin-role guard enforced
- CSRF token validated
- Document ID validated as UUID
- Successful SSE progress event stream returned
- `invalidateRegistryCache()` called after successful ingestion
- Audit log `pdf_ingested` event recorded
- DB error during ingestion returns error response

### MEDIUM — Infrastructure

**14. `lib/tree-cache.ts` and `lib/supabase-server.ts`: 0% coverage**  
Tree cache is used on every structural query. Missing:
- `getAllCachedDocumentTrees()` — L1 in-memory hit (within TTL)
- `getAllCachedDocumentTrees()` — L1 miss, L2 Supabase hit
- `getAllCachedDocumentTrees()` — both miss, returns empty Map
- `saveDocumentTree()` — writes to both L1 and L2
- `supabase-server.ts`: `createAdminClient()` singleton pattern: second call returns same instance
- `createAdminClient()` missing env vars throws a meaningful error

**15. `lib/pdf-ingestion.ts`: 0% coverage**  
The most complex pipeline module has zero tests:
- Resume support: chunks already present in DB are skipped (no duplicate embeddings)
- Child→parent linking by page overlap assigns correct `parent_id`
- Batch insert respects chunk size limits
- `DailyQuotaExhaustedError` during embedding aborts ingestion with partial progress saved
- TOC extraction produces correct `TreeNode` hierarchy
- Empty PDF (no text content) returns gracefully with zero chunks

---

## 4. Edge Cases Not Currently Tested

| Category | Specific Gap |
|----------|-------------|
| **Auth bypass** | `x-middleware-subrequest` CVE header injection (middleware test missing) |
| **Auth bypass** | JWT with tampered `role` field (wrong signature) should be rejected at middleware |
| **Auth bypass** | Expired JWT (past `exp`) returns null from `verifyJWTToken` — not tested for `getSession` callers |
| **Rate limiting** | IP-based rate limit counter in `loginAction` — no test for the counter reaching max and resetting |
| **Rate limiting** | Code-attempt counter in `verifyEmailAction` reaching max invalidates the code |
| **File uploads** | File exactly at 10 MB limit is accepted; file at 10 MB + 1 byte is rejected — boundary not tested |
| **File uploads** | DWG/DXF MIME type detection (browser often sends `application/octet-stream` for these) |
| **Concurrent requests** | Two concurrent `getAllDocuments()` calls on a cold cache produce only one DB fetch (deduplication via `refreshPromise`) |
| **Concurrent requests** | Two simultaneous `createPermit()` calls for the same user — no race condition protection tested |
| **Invalid JWT** | JWT signed with a different secret returns null |
| **Invalid JWT** | JWT with malformed `sub` (non-UUID) fails `jwtPayloadSchema` validation and returns null |
| **Expired codes** | Verification code with `code_expires_at` exactly equal to `Date.now()` (boundary) |
| **Expired codes** | `reset_code` when `reset_code` field is null returns "No reset code found" error |
| **Special characters** | Username with SQL injection characters is safely rejected by Zod schema |
| **Special characters** | Project name with Unicode/emoji characters stored and retrieved correctly |
| **Large data** | `buildContext()` with 10 chunks each near `MAX_CHUNK_LENGTH` produces correctly truncated output |
| **Block cache** | `blockStatusCache` with > 1000 entries triggers cleanup (memory leak prevention path) |

---

## 5. Weak Assertions Identified

| Test | File | Problem |
|------|------|---------|
| `should return PipelineResult with chunks and queryEmbedding` | `chat-pipeline.test.ts:111` | Asserts `result.fromCache === false` but does not assert `result.queryEmbedding` has length 768 — any non-undefined value passes |
| `should fall back to standard pipeline when tree reasoning fails` | `chat-pipeline.test.ts:142` | Only asserts `result` and `result.chunks` are defined — does not verify `queryBuildingCode` was actually called as the fallback |
| `should handle empty search results` | `permit-compliance.test.ts:146` | Only asserts `result.checkedAt` is defined — does not assert `overallStatus` or that the AI was still invoked |
| `should return compliant result for valid building data` | `permit-compliance.test.ts:82` | Does not verify that `mockHybridSearch` was called with building-related query strings |
| `should call hybridSearch with generated queries` | `permit-compliance.test.ts:95` | Asserts `mock.calls.length >= 1` — too loose; should assert at least the number of enabled compliance checks |
| `should detect exact search patterns` | `rag.test.ts:134` | Asserts `mockRpc` was called with `search_dubai_code_exact` but ignores the return value `_result` — the test does not verify that exact results appear in the merged output |
| `should generate a CSRF token string` | `auth.test.ts:13` | Only asserts type is `string` and length > 0; does not assert format (64-char hex string from `crypto.randomBytes(32)`) |
| `should verify a valid JWT token` | `auth.test.ts:54` | Does not assert `result.role` is validated against the Zod schema enum — a tampered role that passes JWT signature check but is an invalid enum value would return null, not caught |
| `should register successfully with valid data` | `auth-actions.test.ts:232` | Does not assert the DB insert was called with `email_verified: false` and the generated verification code stored |
| `should route structural queries to tree reasoning` | `chat-pipeline.test.ts:127` | Asserts `result.chunks.length >= 0` — vacuously true; should assert the tree path was attempted (`mockGetAllCachedDocumentTrees` called) |
| `getPageRangesForNodes — should return page ranges for selected nodes` | `agents.test.ts:176` | Tests `ranges[0]` but does not test `ranges[1]` when two non-overlapping nodes are passed — coverage of the no-merge path is implicit only |
| `adminCreateUser` (email uniqueness) | `admin-actions.test.ts` | Duplicate key `23505` returns a generic error but test does not assert the specific user-facing message text |
