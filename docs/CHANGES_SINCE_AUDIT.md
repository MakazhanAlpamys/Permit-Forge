# Changes Since the 2026-05-21 Audit

> Summary of every release that landed between the 2026-05-21 phase-1+2 audit
> (226 findings across 10 reports) and the v1.10.0 defense-prep release.
> Companion to [`plan.md`](../plan.md) — that file is the live roadmap; this
> file is the after-action report.

## Headline numbers

| Bucket | Audit baseline (2026-05-21) | Closed in v1.0.0–v1.10.0 | Remaining |
|--------|----------------------------:|-------------------------:|----------:|
| Critical | 28 | **28** | 0 |
| High | 54 | **47** (3 wontfix per DIPLOMA, 4 deferred to post-defense) | 0 in scope |
| Medium | 80 | **48** | ~32 (lower-leverage polish, deferred per per-PR cadence) |
| Low | 64 | **~10** (v1.10 Part A papercuts) | ~54 (cosmetic) |
| **Total in-scope closed** | **226** | **~133** | |

The defense-window goal was *"zero Critical, ≤ 5 High remaining, all of those
diploma-deferred."* **Result: 0 Critical, 0 High in scope** (DIPLOMA-1..5 sit
outside the in-scope list — see [`plan.md`](../plan.md) for the explicit
wontfix table).

Test count: **1028 → 1202 tests** (+174 net new). Line coverage: **67.0% →
~72.1%**. Branch coverage: **53.9% → ~60.3%**.

## Per-release summary

### v1.0.0 — "Auth Lockdown" (`028dc69`)
Closes the 6 critical auth-bypass holes and 4 paired Highs. Five `_atomic`
RPCs gained admin guards inside their `SECURITY DEFINER` bodies; `code_attempts`
and `semantic_cache` got RLS; `tv` (token_version) re-check now fires inside
`requireAuth` on every `/api/*` route; chat-stream rate-limit uses its own
`endpoint:'chat'` bucket. Re-audit caught 3 follow-ups (5 API routes still
bypassing `requireAuth`, 2 chat-history mutations ungated, two extra RPCs
needing REVOKE) — all folded in pre-push.

### v1.1.0 — "JWT & State Coherence" (`56d9b00`)
Fixes the regression where changing your username after a password change
logged you out (CP-C-1 — `updateProfileAction` was minting JWTs without
`tokenVersion`). Logout now bumps `token_version` so other tabs lose
session. Block-status cache tightened 5 min → 30 s and flipped from
fail-open to fail-closed.

### v1.2.0 — "Click-path Hardening" (`394cef6`)
Sweep of the silent-failure family — the audit found ~1/3 of all
Critical/High findings reduce to *"`if (result.success) {...}` with no else
branch."* Added a `useServerAction` hook + `ResultDialog` everywhere, in-flight
guards on every mutation, dirty-tracking on permit form step 2, confirm
dialogs on every destructive action, document soft-delete collision
handling, re-ingest hides chunks via `is_active=false`, certificate
download blob revoke uses `setTimeout(_,0)` so Firefox doesn't truncate, and
8 more mediums. The biggest UX-visible release.

### v1.3.0 — "Pipeline Resilience" (`783de45`)
Singleflight has a 30 s timeout + AbortController now; SSE plumbs
`request.signal` so a closed tab stops Gemini token consumption; semantic
cache has `ON CONFLICT` via a UNIQUE INDEX on `md5(query_text)`; new
`start_review_permit_atomic` RPC moves the previously-3-statement transition
into an atomic `SECURITY DEFINER` body. Re-audit added an audit log to the
new RPC + tightened the cache UPSERT to not overwrite `query_embedding` on
hits.

### v1.4.0 — "Test Coverage Foundation" (`8bab47c`)
+101 net tests. API-route coverage from 0% → 80%+ on `/api/ingest` and
`/api/admin/documents/upload`. Component coverage on permit-card +
compliance-check-panel + message-bubble + source-citation +
permit-management. Tightened weak `expect.any(Object)` assertions to typed
matchers. Playwright E2E deferred to post-defense (5-step manual smoke
substitutes during diploma window).

### v1.5.0 — "Security + DB High Cleanup" (`688cb23`)
All 11 remaining High security findings + 5 DB Highs closed.
`SUPABASE_JWT_SECRET` fail-fast when `ENABLE_USER_CONTEXT_RLS=1`; RFC 5987
`Content-Disposition` encoding via `lib/http-headers.ts`; `DEV_INSECURE_COOKIES`
flag rename removes `NEXT_PUBLIC_` leak (production-only safety guard added
in re-audit); advisory-lock collision in `check_rate_limit` fixed via
single-bigint hash; `match_count` capped at 50 across all 8 search RPCs;
`get_all_users_admin` push-down via `filtered_users` CTE; CRAG threshold
re-calibrated 0.3 → 0.08 against actual post-RRF score range; chat history
budget walks newest-first within `MAX_CHAT_HISTORY_CHARS = 12_000` instead
of `.slice(-10)`; PDF parse gets a 30 s timeout. Re-audit caught the
4-arg/6-arg `get_all_users_admin` overload resolution bug + `userFacingError`
overreach + 2 Lows.

### v1.6.0 — "TypeScript & Runtime Safety" (`8f270d1`)
All 5 TS High + 4 of 7 TS Medium closed. `rowToPermit`/`rowsToPermits`
boundary helpers + `assertPermitRowShape` replace `as unknown as
PermitRow[]` casts. `transformPermit` returns `undefined` instead of
`{} as BuildingDetails`. New `app/error.tsx` + `app/global-error.tsx` +
3 segment boundaries. Hydration-safe `Intl.DateTimeFormat` instead of
`toLocaleString`. New `lib/debug-log.ts` gates hot-path `console.log`
behind `DEBUG_PERMITFORGE=1`. Empty `} catch {}` blocks now log.

### v1.7.0 — "Architecture Cleanup" (`b12a0bc`)
Permit compliance TOCTOU fixed via conditional `UPDATE … WHERE version`.
Tree cache gained LRU eviction at 50 docs + dead-entry pruning. New
`lib/document-cache.ts` centralizes the 3-way cache invalidation. Zod
boundary validation on `dubai_code_chunks.metadata`. Password reset email
failure now wipes `reset_code` and surfaces an error. New `lib/logger.ts`
(structured JSON, zero deps, routes through `console.error/.warn/.info/.debug`
for Vercel parsing) + `x-request-id` propagation through middleware.
`lib/llm-config.ts` centralizes Gemini model names with env overrides + an
embed-dim drift warning.

### v1.8.0 — "Refactor & Simplify" (`e9c6cd8` + `f1c75cb`)
Tightened `withMutation` to a discriminated union (no more `.data` wrapper).
17 of 24 audit-flagged `logAuditWithMeta` adopters swept. Deleted dead
`uploadDocumentPDF` + empty `app/reset-password/` directory. Two new
helpers: `applyOptimisticUpdate` (in `lib/permit-versioning.ts`) collapses
the twin optimistic-locking blocks; `firstRpcRow<T extends object>(data)`
centralizes the 6 RPC-row-array-or-scalar shims. `verifyAndConsumeCode`
extracted from verify-email + reset-password. Removed `@paper-design/shaders`
+ `@types/bcryptjs` from `package.json`.

### v1.9.0 — "Medium Wave" (`dd2ba95`)
Sweep of 18 medium-leverage items: admin permit list `limit` cap with
`Number.isFinite()` guards; persisted prompt injection sanitizer for the
semantic cache (strips `<script>`, rewrites `javascript:` / `vbscript:` /
`data:text/html`); password-change rate limit moved to per-user `checkCodeAttempts`
bucket with reset-on-success; column-level UPDATE grants on `users`
(`role`/`blocked`/`password_hash`/`token_version` now service-role-only);
`get_all_users_admin` OFFSET cap at 1000; `save_document_tree` 4 MB cap;
HNSW `ef_construction` 64 → 128. Refactor mediums: 5 unused exports
deleted, 3 dead interfaces removed. Simplify mediums: `getOffTopicResponse`
+ `getGreetingResponse` collapsed; single `NOTIFICATION_TEMPLATES`;
`validatePasswordClient` helper for client preflight; `escapeHtml`
extracted to `lib/html-escape.ts`. Re-audit caught a Crit DB signature
mismatch (`save_document_tree` `VARCHAR/BIGINT` vs original `TEXT/UUID`
would create a 2nd overload instead of replacing) + an admin RPC param
rename — both fixed pre-push.

### v1.10.0 — "Low Polish + Defense Prep" (`d2485e4` + `f626b33` + this commit)
Part A (low-severity papercuts): `parseInt` radix arg in `lib/email.ts`;
`generateCertificateNumber` uses `getUTCFullYear` so region-stratified
Lambdas can't generate different cert numbers for a permit issued near
midnight UTC; `rowsToChatSessions` boundary helper replaces a
`rows as unknown as ChatSession[]` double-cast; new `HYBRID_SEARCH_RRF_K`
+ `PERMIT_ATTACHMENT_SIGNED_URL_TTL_SECONDS` constants; nested ternaries in
`reviewPermit` replaced with lookup maps; `treeReasoner` section regexes
memoized via a 1000-entry LRU instead of recompiling per-node-per-call;
`getPermitAttachments` parallelizes the per-row `createSignedUrl` calls
with `Promise.all`. Part B: defense-day runbook captured in
[`DEFENSE_DAY_CHECKLIST.md`](DEFENSE_DAY_CHECKLIST.md). Part C: this file
+ CLAUDE.md refresh. Part D: subset audit re-run via reviewer agents.

## What was deferred and why

Per the diploma wontfix table in [`plan.md`](../plan.md):

| ID | What | Why deferred |
|----|------|--------------|
| DIPLOMA-1 | `.env.local` containing live keys | Needed for the running demo at defense |
| DIPLOMA-2 | `Admin123!` seed admin | Reviewers need a known credential |
| DIPLOMA-3 | In-memory `lib/login-lockout.ts` | Multi-instance Redis lockout is post-defense |
| DIPLOMA-4 | Block-status 30s TTL | Stale-up-to-TTL acceptable for diploma scope |
| DIPLOMA-5 | Optional `SUPABASE_JWT_SECRET` fallback | Opt-in via `ENABLE_USER_CONTEXT_RLS=1`; documented |

Also intentionally not in scope: Playwright E2E layer (v1.4 Part D — substituted
by 5-step manual smoke + 73 vitest suites), `executeRAGPipeline` strategy
router (v1.7 A-M-6 — would collapse `checkPermitCompliance` into the chat
pipeline but the two paths have intentionally divergent prompt-building
rules), 632-line `chat-interface.tsx` split (v1.9 / v1.10 polish), and the
remaining 19/24 `withMutation` action-file adopters (v1.8 Part A —
diminishing-returns sweep).

## Audit-ID → release map

To find which release closed any audit ID, grep [`plan.md`](../plan.md) for
the ID — every release's "Closes:" line lists its audit-IDs explicitly.
Burndown table at the bottom of `plan.md` has commit hashes.
