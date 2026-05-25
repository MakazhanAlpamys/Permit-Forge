# Phase 2 — Architecture Review (2026-05-21)

> **Scope:** System-level architecture audit of PermitForge. Focus on issues that single-file reviews miss — cross-module coupling, cache coherence, concurrency, state-machine integrity, multi-instance behaviour, failure modes, and observability. Diploma-scope items (secrets in `.env.local`, `Admin123!`) are not weighted.

---

## Critical

### A-C-1: Per-process singleflight has no timeout — a hung Gemini call wedges all duplicate queries
- **Area:** concurrency
- **Files:** `lib/chat-pipeline.ts:73-136`, `lib/gemini.ts:91-154` (`generateEmbedding` can retry for ~7 attempts with `delay = 60_000`ms on rate-limit), `lib/permit-compliance.ts:103-217`
- **Issue:** `inflightPipelines` stores a `Promise<PipelineResult>` keyed by normalised query. The `finally` cleanup runs only when the underlying pipeline settles. But `runRAGPipeline` has no overall timeout — `generateEmbedding` alone can block for up to **~7 × 60s ≈ 7 min** of retry backoff on a 429 (`lib/gemini.ts:140-149`), and the LLM streaming step in the route (`app/api/chat/stream/route.ts:207-251`) has no abort. Meanwhile, every subsequent caller for the same query (`executeRAGPipeline` -> `inflightPipelines.get(key)`) returns the *same* hung promise and is also stuck. Unlike `runComplianceCheck` (which has a 60s `AbortController`, `actions/permits.ts:648-666`), the chat path has nothing equivalent.
- **Impact:** A single user issuing a popular query during a Gemini outage can stall every concurrent user on the same query for minutes. Worse, the request rate-limiter has *already* admitted those callers, so the budget is consumed but no work is returned. There's no way for an inbound `request.signal` (client tab close) to release them either — `app/api/chat/stream/route.ts` does not propagate `request.signal` into the pipeline at all.
- **Fix sketch:** Wrap `runRAGPipeline` in a `Promise.race` with a hard ceiling (e.g. 30s), and propagate `request.signal` into `generateEmbedding` / streaming LLM call. Add an explicit `AbortController` per pipeline run; share it via the inflight entry so secondary waiters can race the same abort.

### A-C-2: Chat streaming has no client-disconnect handling — LLM bytes + cache writes proceed after tab close
- **Area:** failure | concurrency
- **Files:** `app/api/chat/stream/route.ts:207-251` (no `request.signal` reference anywhere in the file), `lib/chat-pipeline.ts:329-332` (`cacheResponse` fire-and-forget)
- **Issue:** When the client aborts the SSE connection, `controller.enqueue` will eventually error, but the upstream LangChain stream keeps generating tokens until Gemini finishes (`getStreamingModel().stream` has no `signal` plumbed). The cache-store call at line 233 fires unconditionally on a successful stream — meaning a *partial* `fullContent` (everything the LLM produced before the route caught the error) may still get cached as the answer to that query because the catch path at 240-249 only runs on `controller.enqueue` failure, not on aborted client.
- **Impact:** (a) Wasted Gemini tokens after every tab close. (b) **Cache poisoning risk**: a truncated answer can populate `semantic_cache` for a 1-hour TTL and be returned to subsequent identical queries via cosine ≥ 0.95 match. (c) No way to back-pressure: the SSE writer fills the OS socket buffer with no client to drain it.
- **Fix sketch:** Pass `request.signal` to `getStreamingModel().stream(messages, { signal })`. In the stream `start`, listen for `signal.aborted` and break the `for await`. Only call `cacheResponse` if streaming completed without abort *and* `fullContent.length` looks sane.

### A-C-3: `semantic_cache` insert has no de-dup — two concurrent identical queries can race and both insert
- **Area:** caches | concurrency
- **Files:** `lib/semantic-cache.ts:63-86`, `supabase/migrations/000_full_setup.sql:1773-1793`, `lib/chat-pipeline.ts:73-136`
- **Issue:** Singleflight collapses concurrent identical queries **inside a single Node process**, but PermitForge is deployed to Vercel/Cloud Run with multiple instances (per CLAUDE.md "10K users: current architecture sufficient"). Across replicas, two simultaneous cold queries each (a) miss the cache, (b) run the full pipeline, (c) both call `insert_semantic_cache` (`000_full_setup.sql:1773` — plain `INSERT` with no `ON CONFLICT` on a uniqueness constraint on `query_text` or embedding hash). Result: duplicate rows, wasted Gemini calls, and the HNSW index has redundant near-identical vectors that slow future lookups.
- **Impact:** N replicas × cache-stampede on cold-but-popular queries. The cache table grows duplicates that distort the ANN search (multiple top-1 candidates for the same query, the chosen one is arbitrary).
- **Fix sketch:** Add `ON CONFLICT (query_text) DO UPDATE SET response = EXCLUDED.response, created_at = NOW()` (requires a unique index on `query_text`), or hash the query and conflict-key on that hash. Long-term: cross-instance singleflight via Redis SETNX or a Postgres advisory lock keyed by the normalised query hash.

### A-C-4: Block-status cache is Edge-runtime in-memory — no coherence with admin actions
- **Area:** caches | multi-instance | security
- **Files:** `lib/block-status-cache.ts:14-30`, `middleware.ts:100-183`, `actions/admin.ts:224,278,428`
- **Issue:** `invalidateBlockStatus(userId)` is called from `actions/admin.ts` (Node runtime). But `middleware.ts` runs in the **Edge runtime** — the `blockStatusCache` Map there lives in a separate V8 isolate from server actions. The file's own header acknowledges this (`lib/block-status-cache.ts:9-13`: "Middleware runs in the Edge runtime and server actions run in Node; in production these are different V8 isolates with independent Map instances"). The diploma-scope tolerance is "stale-up-to-TTL", but the TTL is **5 minutes** (`middleware.ts:9`). Meaning: after an admin blocks a user, that user keeps using the app for up to 5 minutes from every Edge region they hit.
- **Impact:** Security posture overstates real-time enforcement. A malicious user blocked for abuse can still issue chat queries, upload attachments, and submit permits for the full TTL window from any region edge that already cached `blocked: false`. The `token_version` check has the same property — a `bump_user_token_version` does not propagate to other regions' caches.
- **Fix sketch:** Eliminate the in-memory cache for block status — the Edge fetch to Supabase REST API is already ~5-20ms, acceptable on every protected route. Or move to a short-TTL (15-30s) cache. Critically: **never trust an in-process cache for authoritative authz state in a serverless, multi-region deployment.**

### A-C-5: Permit `setPermitUnderReview` is not atomic — history row can be missed
- **Area:** state | concurrency
- **Files:** `actions/admin-permits.ts:181-270`
- **Issue:** Unlike `submit_permit_atomic` / `review_permit_atomic` / `revise_permit_atomic` / `create_permit_atomic` (all RPC-wrapped), `setPermitUnderReview` does a SELECT (line 203), a conditional UPDATE (line 218-223), then a separate INSERT into `permit_status_history` (line 230-236). If the INSERT fails (e.g. statement timeout, network blip), the permit is in `under_review` but `permit_status_history` is missing the row — breaking the audit trail and the timeline UI. There is no transactional boundary.
- **Impact:** Status history corruption. Forensic gap when investigating which admin moved a permit into review. Also: per-status checks elsewhere assume the timeline is complete.
- **Fix sketch:** Add `start_review_permit_atomic` RPC mirroring `submit_permit_atomic` (UPDATE + status_history INSERT inside a `SECURITY DEFINER` function with `FOR UPDATE` row lock).

---

## High

### A-H-1: `runComplianceCheck` re-check window is wide open — TOCTOU on permit state
- **Area:** concurrency | state
- **Files:** `actions/permits.ts:598-707`
- **Issue:** The action does (1) status check, (2) LLM call up to 60s, (3) re-check status, (4) UPDATE. Between (3) and (4) there is still a window — a concurrent submit can flip the permit to `submitted` and the result then writes into a non-draft permit. The re-check uses `single()` without `FOR UPDATE`. Subtle: the `compliance_check_result` column is also nullified by `updatePermitBuildingDetails`/`updatePermitComplianceRequirements` (lines 149-151, 226), so a race between *end-of-compliance-check* and *form-edit* can leave the just-overwritten result reappearing.
- **Impact:** Stale compliance result attached to a permit that's been edited. UI shows "compliant" for the *previous* building shape.
- **Fix sketch:** Make the final UPDATE conditional on `version` (optimistic-lock, already used in step 2/3 updates). Discard the result if version moved.

### A-H-2: Document registry sync getters can return empty silently — citations attribute to "Building Code" fallback
- **Area:** caches | data-flow
- **Files:** `lib/document-registry.ts:134-146`, `lib/rag.ts:308-331`
- **Issue:** `getDocumentByIdSync` returns `undefined` when the in-memory registry cache is cold. `buildContext` in `rag.ts:310` falls back to `'Building Code'` — masking the document attribution. The pipeline at `lib/chat-pipeline.ts:155` pre-loads the registry via `getAllDocuments()`, but: (a) `permit-compliance.ts` calls `hybridSearch` directly without that pre-warm; (b) any path that calls `buildContext` without first hitting `getAllDocuments` will get the fallback. The sync API encourages this footgun.
- **Impact:** Citations on certain code paths show `Building Code` for *every* document, regardless of source — silent loss of multi-document attribution accuracy. Hard to debug because there is no warning when the sync fallback fires.
- **Fix sketch:** Either (a) make `buildContext` async and use `getDocumentById`, accepting the await; or (b) at least `console.warn` when the sync getter returns `undefined` so the failure is observable.

### A-H-3: Document tree cache has no per-document TTL eviction — unbounded growth across documents
- **Area:** caches | failure
- **Files:** `lib/tree-cache.ts:41`, `lib/tree-cache.ts:56-136`
- **Issue:** `cacheMap: Map<string, TreeCacheEntry>` grows as new documents are added or re-ingested. There is no eviction on size, no LRU. `clearDocumentTreeCache(documentName)` is called by ingestion (`actions/ingest-pdf.ts:53,91`) and document deletion (`actions/documents.ts:213`), but a renamed document or a registry row deleted via direct DB access leaves a dead entry in `cacheMap` forever. The `TreeNode[]` payload per document can be hundreds of KB (full TOC tree).
- **Impact:** Memory pressure in long-running Node processes (dev/Cloud Run keep-warm). Stale entries returned by `getAllCachedDocumentTrees` even after a document is soft-deleted in `document_registry`, because `getAllCachedDocumentTrees` (`lib/tree-cache.ts:142-179`) refreshes by *fetching all rows* but never removes entries that disappeared from the result set.
- **Fix sketch:** In `getAllCachedDocumentTrees`, after the fetch, prune `cacheMap` keys not in the result set. Add a max-size cap on `cacheMap` with LRU eviction.

### A-H-4: `getAllCachedDocumentTrees` ignores TTL and the L1 staleness check — every call hits L2
- **Area:** caches | performance
- **Files:** `lib/tree-cache.ts:142-179`
- **Issue:** Unlike `getCachedDocumentTree` (which carefully checks TTL and avoids the JSONB fetch when `updated_at` hasn't changed), `getAllCachedDocumentTrees` always SELECTs `tree_data, updated_at` for all rows on every call. It's invoked from `chat-pipeline.ts:246` on the structural-tree path of every chat query. The function loads the entire JSONB tree for every document on every call — defeating the L1 cache entirely for that code path.
- **Impact:** Hot chat path pulls multiple JSONB blobs (each potentially MB-sized) from Postgres for every structural query. As documents grow, latency scales linearly with document count even on a "cache hit".
- **Fix sketch:** Check `cacheMap` TTL first — if all known documents are within TTL, return from memory without DB. Then a lightweight metadata query (`SELECT document_name, updated_at`) to detect new/changed docs, fetch only those.

### A-H-5: `singleflightKey` normalisation diverges from semantic cache key
- **Area:** caches | concurrency
- **Files:** `lib/chat-pipeline.ts:80-84`, `lib/semantic-cache.ts:25-29`, `supabase/migrations/000_full_setup.sql:1743-1770`
- **Issue:** The singleflight key is `query.trim().toLowerCase().replace(/\s+/g, ' ')` (plain string normalise). The semantic cache, by contrast, keys on **cosine similarity ≥ 0.95** of the *embedding* — completely different equivalence class. Two queries `"parking requirements"` and `"parking spaces required?"` collapse on the semantic cache but are distinct in the singleflight map. Conversely, two queries that share the normalised string (e.g. after stripping unique trailing punctuation) collapse in singleflight even when their embeddings would be 0.99 similar but distinct entries.
- **Impact:** The stampede protection is weaker than it could be — common rewordings of a popular query each run their own pipeline. Not strictly incorrect, but the comment at `lib/chat-pipeline.ts:81-83` ("same normalisation as semantic cache lookup") is **misleading**: the semantic cache does not use string normalisation at all.
- **Fix sketch:** Either (a) accept the divergence and remove the misleading comment; or (b) move singleflight after the embedding step and key on a rounded embedding hash (e.g. first 64 floats × 1000, rounded). The latter is more expensive but actually collapses on semantic equivalence.

### A-H-6: Email/notification failures are silent during password reset email send
- **Area:** failure
- **Files:** `actions/auth.ts:401-447`, `lib/email.ts`, `lib/notifications.ts:27-76`
- **Issue:** `forgotPasswordAction` writes the reset_code to DB (line 432), then calls `sendPasswordResetEmail` (line 440) — but **does not check the return value** or distinguish failure. The function then `return { success: true }` regardless. The user gets the "check your email" message but the email never arrived. In contrast, `registerAction` (line 303-308) checks `emailSent` and rolls back the user row. The reset-password path has no equivalent rollback, leaving the DB with a `reset_code` that the user can never use.
- **Impact:** Users can be silently locked out of password reset for hours. The standard "failure-silent" notification policy is correct for permit notifications (recoverable), but **wrong** for the security-sensitive password-reset flow where the email IS the channel.
- **Fix sketch:** Inspect `sendPasswordResetEmail` return value. If false, clear `reset_code` and return an error string. The email-enumeration concern (line 425) is preserved by returning `success: true` only when the user does not exist; existing-user paths should surface delivery failure.

### A-H-7: No structured logging — debugging "user got wrong answer" requires console grep
- **Area:** observability
- **Files:** Entire codebase. 67 `console.*` calls across 15 lib files (grep result). Zero usage of any logger library. No correlation IDs.
- **Issue:** Cache HITs are logged with similarity (good), but there is no request ID linking the rate-limit check, embedding call, cache lookup, document selector, search, rerank, citations, and LLM output for a single user query. Audit logs cover 12 event types but not RAG metrics (chunk scores, document filter, tree-reasoning path taken). When a user complains "the answer was wrong", the only diagnostic is "look at the chat_messages row and its citations".
- **Impact:** Cannot detect quality regressions (CRAG threshold drift, embedding model change, cache HIT rate dropping). Cannot trace cross-instance issues. Cannot quantify cache effectiveness.
- **Fix sketch:** Introduce a single `logger` module wrapping `pino` (Node) / OpenTelemetry. Stamp every request with a UUID, propagate via header to downstream logs. Add structured metrics: `cache_hit_rate`, `crag_fail_rate`, `embedding_latency_p99`, `pipeline_duration_p99`, `singleflight_collapse_count`.

### A-H-8: Hardcoded model names + LangChain coupling block provider swap
- **Area:** debt
- **Files:** `lib/gemini.ts:30,43,97`, `lib/permit-compliance.ts:6,209-217`, `lib/chat-pipeline.ts` (via `getStreamingModel`)
- **Issue:** `'gemini-2.5-flash'` is hardcoded in three places in `lib/gemini.ts` (lines 30, 43; the embedding model `'gemini-embedding-001'` at line 97). There is no abstraction over the LLM/embedding provider — `permit-compliance.ts` directly imports from `@langchain/google-genai`. Migrating to Claude / OpenAI requires touching every callsite. There is no feature flag to A/B test embedding models (e.g. compare 768-dim vs 1536-dim).
- **Impact:** Vendor lock-in. Cannot evaluate competing models without invasive changes. The `embeddingsModel` shim (`lib/gemini.ts:62-69`) exists for backward compat but only narrows the surface — it doesn't decouple the provider.
- **Fix sketch:** Move model names + provider to a single config (`lib/llm-config.ts`) with env-driven overrides (e.g. `LLM_PROVIDER=gemini|claude|openai`, `EMBEDDING_MODEL=gemini-embedding-001`). Introduce `ChatProvider` interface; current Gemini becomes one implementation.

### A-H-9: Citation parser is fragile to ChunkMetadata schema drift
- **Area:** data-flow
- **Files:** `lib/citation-parser.ts:23-55`, `types/index.ts:9-29`, `lib/rag.ts:32-40` (`normalizeChunkMetadata`)
- **Issue:** Citations are built from `chunk.metadata.page`, `chunk.metadata.startPage`, etc. The DB stores this as JSONB (no schema enforcement). `normalizeChunkMetadata` defaults `page/startPage/endPage` to 0 — meaning **all citations from chunks with missing page metadata claim "page 0"**. There is no validation that the JSONB shape matches `ChunkMetadata`. If the ingestion pipeline ever writes different field names (e.g. legacy `pageNumber` vs current `page`), citations silently break with no error.
- **Impact:** Silent citation degradation if an older PDF was ingested with a previous metadata shape. The CLAUDE.md note "Citations: 100% accurate from DB metadata" is only true if metadata is well-formed.
- **Fix sketch:** Add Zod validation at the boundary in `mapHybridRow` / `mapExactRow` (lib/rag.ts:51, 69). Surface a metric for `citations_with_zero_page` per request.

---

## Medium

### A-M-1: Optimistic-lock retry policy is "show error to user" — no automatic retry
- **Area:** concurrency | UX
- **Files:** `actions/permits.ts:146-166, 222-244`
- **Issue:** When `expectedVersion` doesn't match, the action returns `'This permit was changed in another tab. Reload the page...'`. There is no auto-retry, no merge attempt, and no telemetry to know how often this fires. Multi-tab users see a confusing error.
- **Impact:** UX friction. No data to know how prevalent the race is.
- **Fix sketch:** Add a counter metric. Consider auto-fetching fresh version and surfacing a diff to the user before they re-submit.

### A-M-2: Permit state UI gating is string-compare, not state-machine API
- **Area:** state
- **Files:** `components/admin/permit-management.tsx:94,221,241`, `app/permits/[id]/page.tsx:266,301`, `app/permits/new/page.tsx:165,181`, `components/permits/permit-card.tsx:62`
- **Issue:** Per commit 6f5ad76, 8 inline transitions were migrated to `permit-state-machine.ts`. Server-side this is done — all `canPerformOperation` checks live in `actions/*.ts`. But the **client UI** still does `permit.status === 'submitted'` / `'draft'` / `'approved'` etc. for show/hide logic. If a future status is added (e.g. `'on_hold'`), every UI file must be edited. The state-machine module is server-only (`actions/` imports it), not exposed to client components.
- **Impact:** Future state additions risk UI regressions. Two sources of truth for "what operations are valid at this state".
- **Fix sketch:** Make `lib/permit-state-machine.ts` client-safe (no `'use server'`, no DB imports) and expose `isOperationAllowed` to client. Replace UI string-compares with the same API.

### A-M-3: Block-status cache invalidation has dead-code potential — `actions/admin.ts` runs in Node but cache lives in Edge
- **Area:** caches | multi-instance
- **Files:** `actions/admin.ts:224,278,428`, `lib/block-status-cache.ts`
- **Issue:** Same root cause as A-C-4 but worth calling out separately: every `invalidateBlockStatus(userId)` call in `actions/admin.ts` is essentially a no-op for the middleware Edge runtime in production. The function's own docstring (`lib/block-status-cache.ts:10-13`) admits this. Yet the calls are placed as if they would invalidate; future maintainers may assume real-time enforcement that doesn't exist.
- **Impact:** Code that *looks* correct but isn't in production. Foot-gun for code reviewers.
- **Fix sketch:** Either (a) move to a cross-runtime store (Redis); or (b) annotate each call with `// NOTE: Edge isolate cache not invalidated — TTL is the floor on staleness`.

### A-M-4: Heuristic reranker keyword weighting hardcoded
- **Area:** debt
- **Files:** `lib/heuristic-reranker.ts:12-21`
- **Issue:** Weights (0.4, 0.3, 0.2, 0.1) are constants. Diversity limits (3 per doc, 2 per page range) are constants. There is no way to A/B test these — every change requires a redeploy. The CRAG threshold (`lib/rag.ts:22`) is similarly hardcoded.
- **Impact:** Slow iteration on RAG quality. Cannot tune for different document corpora.
- **Fix sketch:** Move tuning constants to `CHAT_PIPELINE_CONFIG` (already partially exists). Allow override via env or remote config.

### A-M-5: Singleflight is unbounded — memory grows with concurrent distinct queries
- **Area:** caches | concurrency
- **Files:** `lib/chat-pipeline.ts:73-78`
- **Issue:** `inflightPipelines.set(key, promise)` has no size cap. While entries are removed on settle, an attacker (or a viral moment) issuing thousands of distinct queries simultaneously stacks the map. Each entry holds a Promise plus its resolved chunks (`PipelineResult.chunks` can be MB-sized when parent-expanded).
- **Impact:** Memory exhaustion under burst load before any of the inflight promises resolve.
- **Fix sketch:** Cap `inflightPipelines.size` at e.g. 100. On overflow, do not collapse — run independently and accept the duplicated cost.

### A-M-6: `permit-compliance.ts` bypasses the chat pipeline — different RAG quality on permit-side
- **Area:** data-flow
- **Files:** `lib/permit-compliance.ts:103-217` (calls `hybridSearch` directly, no cache, no rerank, no CRAG, no parent expansion)
- **Issue:** The compliance check generates 5-7 queries and runs `hybridSearch` for each (line 121). It does **not** go through `executeRAGPipeline`. That means:
  - No semantic cache reuse (5-7 fresh embeddings per check).
  - No CRAG check — top chunks with similarity < 0.3 still flow into the LLM, increasing hallucination risk.
  - No heuristic rerank, so chunks are returned in raw hybrid order.
  - No parent expansion — LLM sees only 400-char child chunks (truncated to 800 at line 153).
- **Impact:** Two RAG quality regimes in the codebase. Improvements to chat-pipeline do not flow to compliance. The compliance check is the more security-critical path (a wrong "compliant" finding has real consequences) yet uses the cruder retrieval.
- **Fix sketch:** Refactor `checkPermitCompliance` to use the same pipeline as chat, just with the generated queries as input. Cache hits across permit checks for similar buildings.

### A-M-7: `audit_logs` covers only authn/permit ops — RAG quality and rate-limit hits are not audited
- **Area:** observability
- **Files:** `lib/auth.ts:224-250` (AuditAction enum)
- **Issue:** The enum has 25 actions, all authn/permit/admin. Missing: chat query (anonymous content, optional), rate-limit-hit, CRAG-fail event, cache-hit event, embedding-quota-exhausted, singleflight-collapse. These are operational signals, not audit signals — but without them, there is no record of system behaviour for postmortems.
- **Impact:** Postmortem evidence depends on stdout console logs (not retained on Vercel beyond ~24h).
- **Fix sketch:** Introduce a separate `events` table (or external observability sink) for operational events distinct from `audit_logs` which should remain security-focused.

### A-M-8: Permit certificate cache uses Storage path with no TTL — orphaned files on permit re-approval/cert-regen
- **Area:** failure | data-flow
- **Files:** `app/api/permits/[id]/certificate/route.ts:80-167`
- **Issue:** Cached cert PDFs go to `permit-certificates` bucket at `{permitId}/{certNumber}.pdf` with `upsert: true`. The cert row's `storage_path` is backfilled. No deletion logic when a permit is re-approved with a *different* cert number, or when the building details change post-approval. Storage grows unbounded.
- **Impact:** Slow storage cost growth; orphaned PDFs for deleted permits (storage cleanup on permit delete only happens for `permit_attachments`, not `permit_certificates`, per `actions/permits.ts:553-574`).
- **Fix sketch:** On permit deletion, also remove from `permit-certificates` bucket. On status revert from approved, invalidate the cached cert row.

---

## Low

### A-L-1: `loginAction` rate-limit is "fail-open" but per-account lockout still applies
- **Area:** failure
- **Files:** `actions/auth.ts:40-57`
- **Issue:** `checkLoginRateLimit` fails open (return `true`) on DB error. The defense-in-depth account lockout (`lib/login-lockout.ts`) catches sustained attacks, but a brief DB blip combined with a distributed brute-force could slip through the IP gate.
- **Impact:** Marginal. Acceptable.
- **Fix sketch:** Consider a per-process token-bucket fallback when DB is unreachable.

### A-L-2: `pdf-ingestion` invalidates registry + profile caches but not tree cache for cross-document changes
- **Area:** caches
- **Files:** `lib/pdf-ingestion.ts:261-262`
- **Issue:** After ingestion, `invalidateRegistryCache` + `invalidateProfileCache` are called. `clearDocumentTreeCache` is called from the action layer (`actions/ingest-pdf.ts:53,91`) but **not** from inside `pdf-ingestion.ts`. If anything ever calls `runIngestionPipeline` outside the action wrapper, the tree cache stays stale.
- **Impact:** Low — only one call site exists today. Footgun for future code.
- **Fix sketch:** Move all three invalidations to the same place (either the pipeline or the action; the pipeline is more cohesive).

### A-L-3: `MatchedChunk.id` is `number` but corresponds to BIGINT — silent precision loss above 2^53
- **Area:** data-flow
- **Files:** `types/index.ts:24-29`, `lib/citation-parser.ts:36`, `lib/rag.ts:42-49`
- **Issue:** Chunk IDs are JavaScript `number`. PostgreSQL BIGINT supports up to 2^63. At expected scale this is fine (millions of chunks max), but the type lies.
- **Impact:** None at current scale. Documentation/type-accuracy issue.
- **Fix sketch:** `id: bigint` or `string` when ingestion volume warrants it.

### A-L-4: `getPermitAttachments` generates signed URLs sequentially — O(n) round-trips
- **Area:** performance
- **Files:** `actions/permit-attachments.ts:302-313`
- **Issue:** A noted limitation (lines 293-298). For permits with up to 10 attachments, that's 10 Supabase calls per permit-detail page load.
- **Impact:** 10-50ms × 10 = 100-500ms added latency. Self-acknowledged.
- **Fix sketch:** As the comment suggests — proxy endpoint that signs on-demand, or pre-sign with longer TTLs at upload time.

### A-L-5: Email verification + password reset codes are stored in plaintext columns
- **Area:** security | state
- **Files:** `actions/auth.ts:286-296,432-438`, `lib/email.ts`
- **Issue:** `users.verification_code` and `users.reset_code` are plaintext 6-digit codes. A read-only leak of the users table (RLS bypass via service_role compromise) hands the attacker working codes for any pending verifications. Industry standard is to hash these like passwords. The 15-min TTL and 5-attempt cap mitigate, but defense-in-depth is missing.
- **Impact:** Diploma-scope concern; out-of-band exfiltration would already be game over.
- **Fix sketch:** Store `bcrypt(code)` instead of `code`. Update `safeEqual` callsite to `bcrypt.compare`.

### A-L-6: Pipeline registry+profile pre-warm runs every query — wasted async on cache hit
- **Area:** performance
- **Files:** `lib/chat-pipeline.ts:155-156`
- **Issue:** `await getAllDocuments(); await loadSearchProfiles();` runs even when both caches are warm (the functions early-return). Cheap (single Map check each), but it's two awaits on every query.
- **Impact:** ~0.1ms.
- **Fix sketch:** Microoptimisation — combine into a single `prewarmCaches()` that does both in parallel.

### A-L-7: No DB constraint preventing `dubai_code_chunks.parent_id` orphans
- **Area:** data-flow
- **Files:** Migration `000_full_setup.sql`
- **Issue:** Comment at `actions/permits.ts:553-557` etc. shows ordering discipline. But for parent/child chunks, the parent_chunks DELETE before child DELETE during re-ingestion (`lib/pdf-ingestion.ts:285`) could orphan children if interrupted mid-way. CASCADE FKs would help.
- **Impact:** Resume-from-failure ingestion may leave orphans.
- **Fix sketch:** Add `ON DELETE SET NULL` or `CASCADE` on `parent_id`.

---

## Architectural Observations

These are not action items but useful context for future refactors.

- **Pipeline orchestration is too long for one file.** `lib/chat-pipeline.ts` does: singleflight + topic classification + cache lookup + document selection + scope detection + search routing + CRAG + rerank + parent expansion + citation gen + cache write. That's 9 concerns. A `Pipeline.from([...steps])` builder pattern (each step a class with `name`, `run(ctx) -> ctx`) would make individual steps testable and reorderable. Trade-off: more indirection.

- **Two cache invalidation patterns coexist.** Some caches use a "leave entry, refresh on TTL" model (`document-registry`, `document-selector`). Others use "clear immediately" (`tree-cache`, `block-status-cache`). Both are correct for their use case but the inconsistency makes mental modelling harder. Worth a short ADR documenting which pattern to use when.

- **`createAdminClient` is overused.** ~70+ direct call sites bypass RLS. The `createUserContextClient` shim (lib/supabase-server.ts:129) is a recent positive move; expanding its use would let RLS catch ownership bugs that the action-layer checks miss.

- **Singleflight is process-local across all pods.** As scale grows past one Cloud Run instance, the singleflight benefit diminishes. The next horizontal scaling step needs a cross-instance dedup mechanism (Redis SETNX with TTL, or a Postgres-advisory-lock based approach reusing the rate-limit infrastructure).

- **Permit state machine is enforced in three layers** (DB RPC `FOR UPDATE` → server action `canPerformOperation` → client UI string compare). The DB layer is authoritative (correct), the server action layer prevents wasted round-trips (correct), the client UI is hint-only (correct in principle, brittle in practice — A-M-2).

- **Embedding quota is a hard ceiling at 1000/day on free tier.** Every chat query, every cache miss, every compliance check generates embeddings. At 100 active users issuing ~10 queries each, you exhaust 1000 embeddings. There is no quota-aware queueing — the pipeline either succeeds or throws `DailyQuotaExhaustedError`. Production needs either a paid Gemini plan or local embedding fallback (sentence-transformers via WASM at the edge, accepting quality loss).

- **No load-shedding strategy.** When Gemini is rate-limited or down, the retry storm in `generateEmbedding` (lines 140-149: up to 7 × 60s = 7 min wait per failed embedding) will pile up promises. Combined with A-C-1, the system has no circuit breaker. A simple "stop trying embeddings for 60s after 3 consecutive 429s" would prevent cascading failures.

- **Audit log is the de facto observability layer.** Without separate metrics, the team will look at `audit_logs` for everything — but that table is meant for security forensics and will grow unbounded (the comment in migration about "audit_logs_bounded" suggests there's a cap mechanism). Audit growth and metric growth should be decoupled.

- **The codebase makes excellent use of atomic RPCs** (`submit_permit_atomic`, `review_permit_atomic`, `revise_permit_atomic`, `create_permit_atomic`, `insert_permit_attachment_capped`, `check_rate_limit` with advisory lock). This pattern is consistent and correct. The one omission (`setPermitUnderReview`, A-C-5) is the exception.

- **The `transient` empty-cache pattern in `document-registry.ts` (lines 60-83) is a small but elegant correctness win** — preventing a single DB hiccup from blanking the registry for 5 min. Worth replicating this pattern in `tree-cache.ts` where the "stale beats empty" decision is currently ad-hoc.

- **The Edge runtime / Node runtime split is the project's biggest invisible boundary.** Anything that needs to be authoritative across both runtimes (block status, token version, future feature flags) must live in a shared store. The codebase has no convention for "where does this state belong"; documenting the rule in CLAUDE.md would prevent future A-C-4-style mistakes.
