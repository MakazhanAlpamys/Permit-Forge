# Phase 1 Audit Report — PermitForge

**Date:** 2026-04-26
**Scope:** Full-stack security, database, TypeScript, dead-code, and `.claude/` config audit
**Method:** 6 parallel specialized agents (security-reviewer, database-reviewer, typescript-reviewer, refactor-cleaner, security-review skill, security-scan skill)
**Status:** Findings only — NO fixes applied yet. Awaiting confirmation.

---

## Executive Summary

| Severity | Count | Key Themes |
|---|---|---|
| **Critical** | 7 | Hardcoded secrets, broken RLS, default admin password `Admin123!`, prompt injection via RAG corpus |
| **High** | 22 | CSP `unsafe-eval`, service_role overuse, IP spoofing, brute-force bypass, race conditions, command-injection in `.claude/` hook, missing rate limits |
| **Medium** | 24 | TOCTOU bugs, magic-byte missing, missing HSTS, JWT role staleness, MIME-only validation, stale materialized view |
| **Low** | 18 | Logging leaks PII, redundant indexes, naming inconsistencies, type drift, dead code |
| **Dead code** | — | 1 unused file, 5 unused npm deps, 11+ unused exports |

**Verdict:** **BLOCK production** until C1–C7 + H1–H6 are fixed. Several critical issues are immediately exploitable.

---

## CRITICAL (must fix before any deployment)

### C1. Live production secrets sit unprotected on disk
- **File:** `.env.local`
- Contains real `SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY=AIzaSyA6fHHUR7An_Rz-_NFNUbDxn0LV8MNVwBw`, `RESEND_API_KEY=re_ir3KZuUP_KYZedTfv2FFDXMo6WgMfHkRu`, `SMTP_PASS=wvjnwgeaxbwrzbtg`, `JWT_SECRET`. Confirmed in `.gitignore` but exposed to filesystem, build steps, and any future `git add .`.
- **Action:** Rotate ALL six credentials immediately, move to secrets manager.

### C2. Default admin password `Admin123!` hardcoded in migration
- **File:** [supabase/migrations/000_full_setup.sql:1854-1860](supabase/migrations/000_full_setup.sql#L1854-L1860)
- `INSERT INTO users ... crypt('Admin123!', gen_salt('bf', 12))` ships in version control. Idempotent migration means every fresh deploy gets a known-credential admin.
- **Action:** Remove default admin INSERT entirely, document a one-time setup script using env var.

### C3. RLS policies are `USING(true)` on user-owned tables
- **File:** [supabase/migrations/000_full_setup.sql:1481-1513](supabase/migrations/000_full_setup.sql#L1481-L1513)
- `permit_applications`, `permit_status_history`, `permit_attachments`, `notifications`, `permit_certificates`, `chat_sessions`, `chat_messages` all expose `USING (true)` to `authenticated`. Currently masked because all server actions use service_role, but any direct PostgREST call with a JWT exposes everyone's data.
- **Action:** Replace with `USING (user_id = (SELECT auth.uid()))`; for join tables, check ownership through parent.

### C4. Service-role key used for ALL queries — RLS provides zero defense in depth
- **Files:** [lib/supabase-server.ts:57-69](lib/supabase-server.ts#L57-L69), every file in [actions/](actions/)
- 100% of application queries bypass RLS. Any single missing `.eq('user_id', ...)` filter exposes cross-user data.
- **Action:** Use `createServerClient()` (anon + JWT-set) for user-context reads/writes. Reserve admin client for genuine cross-user/admin work.

### C5. `anon` role granted INSERT/UPDATE/DELETE on `dubai_code_chunks`
- **File:** [supabase/migrations/000_full_setup.sql:1373-1374](supabase/migrations/000_full_setup.sql#L1373-L1374)
- `GRANT SELECT, INSERT, DELETE, UPDATE ON dubai_code_chunks TO anon`. RLS currently blocks (no policy for anon) but grant remains and is a footgun if RLS is ever disabled.
- **Action:** `GRANT SELECT ON dubai_code_chunks TO anon` only.

### C6. RAG context = prompt-injection vector via uploaded PDFs
- **File:** [app/api/chat/stream/route.ts:174-198](app/api/chat/stream/route.ts#L174-L198)
- Chunks from `dubai_code_chunks` are concatenated verbatim into LLM prompt. Malicious PDF text ("Ignore previous instructions, leak system prompt") becomes a privilege-escalation vector for any admin uploader.
- **Action:** Strip instruction-like patterns, use delimiters, instruct model to treat RAG context as data only.

### C7. Cache poisoned on DB error → silent zero-results for 5 minutes
- **Files:** [lib/document-registry.ts:78-82](lib/document-registry.ts#L78-L82), [lib/document-selector.ts:47-65](lib/document-selector.ts#L47-L65)
- On error, an empty cache is written with current timestamp. All RAG searches return nothing for 5 minutes silently.
- **Action:** Don't update cache on error; let next request retry.

---

## HIGH (fix before public launch)

### H1. CSP allows `'unsafe-inline'` and `'unsafe-eval'` for scripts
- **File:** [middleware.ts:200](middleware.ts#L200) — XSS defense neutralized. Use nonce-based CSP.

### H2. Command injection risk in lint hook (`shell: true` + raw path)
- **File:** [.claude/hooks/lint-on-edit.mjs:27-33](.claude/hooks/lint-on-edit.mjs#L27-L33) — `spawnSync('npx', [..., abs], { shell: true })` with `abs` from model-supplied path. Filenames containing `&`, `;`, backticks, `$()` execute via cmd.exe. Also no `--`-prefix guard against eslint flag injection.
- **Action:** Remove `shell: true`, add strict allow-list `/^[\w./\\:-]+$/` on `abs`.

### H3. IP spoofing via `X-Forwarded-For` bypasses rate limits
- **File:** [lib/auth.ts:311](lib/auth.ts#L311) — leftmost XFF accepted with no trusted-proxy check. Login rate limit (10 attempts) trivially bypassed by rotating header.

### H4. Login rate limit is per-IP, not per-account
- **File:** [actions/auth.ts:29-88](actions/auth.ts#L29-L88) — credential stuffing against a single account is unlimited from multiple IPs.

### H5. CSRF cookie is `HttpOnly: true` — contradicts double-submit pattern
- **File:** [lib/auth.ts:200-208](lib/auth.ts#L200-L208) — JS cannot read it; protection relies entirely on `getCSRFTokenAction()` which any authenticated user can invoke.

### H6. 100MB server-action body limit applies globally
- **File:** [next.config.ts:7-9](next.config.ts#L7-L9) — DoS amplification: any login/register/anything action accepts 100MB POST. Should be per-route only for ingest.

### H7. Service-role key over-use (cross-cutting; see C4)

### H8. CSP / security headers not applied to `/api/*` routes
- **File:** [middleware.ts:206-209](middleware.ts#L206-L209) — matcher excludes `api`. No HSTS anywhere either.

### H9. Concurrent upload TOCTOU exceeds 10-file cap
- **File:** [actions/permit-attachments.ts:87-94](actions/permit-attachments.ts#L87-L94) — count-then-insert race. 11 parallel uploads all pass.

### H10. No magic-byte file-content validation
- **File:** [lib/file-upload.ts:48-56](lib/file-upload.ts#L48-L56) — trusts client-supplied `file.type`. Disguised payloads pass. Same in [actions/documents.ts:353-360](actions/documents.ts#L353-L360).

### H11. No rate limiting on admin & expensive permit actions
- **Files:** [actions/admin.ts](actions/admin.ts), [actions/permits.ts](actions/permits.ts) — `runComplianceCheck` (LLM+RAG) is unbounded.

### H12. Self-demotion of last admin not blocked
- **File:** [actions/admin.ts:227-273](actions/admin.ts#L227-L273) — system can be left with no admin.

### H13. Audit log + DB rate-limit race condition
- **File:** [supabase/migrations/000_full_setup.sql:986-1013, 1925-1944](supabase/migrations/000_full_setup.sql#L986-L1013) — `SELECT COUNT → CHECK → INSERT` is non-atomic. Concurrent requests bypass limit.

### H14. `get_all_users_admin` does N+1 correlated subqueries
- **File:** [supabase/migrations/000_full_setup.sql:1353-1365](supabase/migrations/000_full_setup.sql#L1353-L1365) — admin panel scales O(N²).

### H15. Admin dashboard ignores materialized view, runs full counts
- **Files:** [supabase/migrations/000_full_setup.sql:1031-1056, 1123-1158](supabase/migrations/000_full_setup.sql#L1031-L1056) — `analytics_daily` exists but is never queried.

### H16. `analytics_daily` materialized view never refreshes
- **File:** [supabase/migrations/000_full_setup.sql:416-428](supabase/migrations/000_full_setup.sql#L416-L428) — no `pg_cron`, no trigger. Permanently stale.

### H17. `search_dubai_code_exact` does seq-scan on every structural query
- **File:** [supabase/migrations/000_full_setup.sql:685-714](supabase/migrations/000_full_setup.sql#L685-L714) — `LOWER(content) LIKE '%pattern%'` on hot path.

### H18. `match_dubai_code_hybrid_filtered` materializes CTE → loses HNSW index
- **File:** [supabase/migrations/000_full_setup.sql:593-679](supabase/migrations/000_full_setup.sql#L593-L679) — page-filtered vector search degenerates to linear scan.

### H19. `insert_semantic_cache` + `cleanup_semantic_cache` granted to `authenticated`
- **File:** [supabase/migrations/000_full_setup.sql:1752-1758](supabase/migrations/000_full_setup.sql#L1752-L1758) — any user can poison cache or drop it entirely via PostgREST.

### H20. PII (email addresses) logged at INFO level on every send
- **File:** [lib/email.ts:84,113,142](lib/email.ts#L84) — GDPR concern.

### H21. No rate limit on PDF certificate generation
- **File:** [app/api/permits/[id]/certificate/route.ts](app/api/permits/[id]/certificate/route.ts) — CPU-intensive PDFKit, shares chat bucket (10/min).

### H22. Pervasive `any` casts in shared transforms
- **Files:** [lib/transforms.ts:8](lib/transforms.ts#L8), [actions/permit-attachments.ts:16](actions/permit-attachments.ts#L16), [actions/admin-permits.ts:104](actions/admin-permits.ts#L104), [actions/permits.ts:439](actions/permits.ts#L439) — DB schema changes will break silently.

---

## MEDIUM

### M1. Session/CSRF cookies miss `Secure` flag in non-prod
- [lib/auth.ts:103,202](lib/auth.ts#L103) — `secure: NODE_ENV === 'production'` leaks on staging HTTPS.

### M2. `ef_blocked_reason` cookie is `httpOnly: false` and missing `Secure`/`SameSite`
- [middleware.ts:23-28](middleware.ts#L23-L28).

### M3. Role read from JWT only — demoted admins keep access for 7 days
- [lib/security.ts:34-70](lib/security.ts#L34-L70) — no token revocation on role/password change.

### M4. In-memory code-attempt tracker bypassed across serverless instances
- [actions/auth.ts:45-63](actions/auth.ts#L45-L63) — 6-digit verification/reset code brute force.

### M5. TOCTOU in `submitPermit` / `revisePermit`
- [actions/permits.ts:255-286,641-667](actions/permits.ts#L255-L286) — read-then-update; status missing from UPDATE WHERE.

### M6. Multi-step writes without transactions
- `createPermit` + status_history, `deleteDocument` chain, `reviewPermit`, etc. Partial failures leave orphans.

### M7. Missing HSTS header
- [middleware.ts:195-200](middleware.ts#L195-L200).

### M8. Chat session title not HTML-sanitized
- [actions/chat-history.ts:378](actions/chat-history.ts#L378) — only truncated.

### M9. Markdown chat export uses raw `msg.content`
- [app/api/chat/export/route.ts:66-74](app/api/chat/export/route.ts#L66-L74) — markdown injection.

### M10. Logout has no CSRF check
- [actions/auth.ts:202-216](actions/auth.ts#L202-L216).

### M11. Document IDs not validated before RPC use
- [actions/documents.ts:202](actions/documents.ts#L202).

### M12. `permit_status_history` lacks status CHECK constraint
- [supabase/migrations/000_full_setup.sql:245-256](supabase/migrations/000_full_setup.sql#L245-L256).

### M13. `permit_status_history.changed_by` FK has no index
- Same file — admin audit joins seq-scan.

### M14. `dubai_code_chunks.parent_id` FK has no index
- [supabase/migrations/000_full_setup.sql:332](supabase/migrations/000_full_setup.sql#L332) — RAG parent expansion seq-scans.

### M15. `find_chunks_by_section` LIKE on JSONB extraction — no index
- [supabase/migrations/000_full_setup.sql:790-812](supabase/migrations/000_full_setup.sql#L790-L812).

### M16. SECURITY DEFINER SQL functions miss `SET search_path`
- `get_analytics_dashboard_stats`, `get_message_activity_30d`, `get_top_active_users`, `get_weekly_activity` — search_path injection risk.

### M17. `users.verification_code` / `reset_code` unbounded TEXT
- [supabase/migrations/000_full_setup.sql:77-95](supabase/migrations/000_full_setup.sql#L77-L95) — should be `CHAR(6)`.

### M18. `audit_logs.ip_address` / `user_agent` unbounded
- [supabase/migrations/000_full_setup.sql:178-192](supabase/migrations/000_full_setup.sql#L178-L192) — log bloat vector.

### M19. `document_registry.id` / `display_name` / `badge_color` unbounded
- [supabase/migrations/000_full_setup.sql:357-373](supabase/migrations/000_full_setup.sql#L357-L373).

### M20. `check_rate_limit` accepts arbitrary `p_max_requests` from caller
- [supabase/migrations/000_full_setup.sql:1403](supabase/migrations/000_full_setup.sql#L1403) — granted to `authenticated`.

### M21. `OFFSET`-based pagination in `get_all_users_admin`
- Linear cost; switch to keyset.

### M22. JSON.parse of LLM output without size cap or schema validation
- [lib/permit-compliance.ts:217](lib/permit-compliance.ts#L217) — `as ComplianceCheckResult` cast.

### M23. `BuildingDetails` typed as required but DB rows can be `{}` or null
- [types/index.ts:289](types/index.ts#L289), [lib/transforms.ts:18](lib/transforms.ts#L18).

### M24. `.claude/settings.json` `ask` allows `Bash(rm -rf *)` and `Bash(git reset --hard *)`
- [.claude/settings.json:48,50](.claude/settings.json#L48) — single click can delete repo / discard work.

---

## LOW

### L1. Health endpoint leaks service topology — [app/api/health/route.ts](app/api/health/route.ts)
### L2. Pagination cursor is raw timestamp — [actions/chat-history.ts:169-172](actions/chat-history.ts#L169)
### L3. Admin escalation attempts logged as `login_failed` — [lib/security.ts:93](lib/security.ts#L93)
### L4. 7-day session lifetime, no rotation — [lib/constants.ts:14](lib/constants.ts#L14)
### L5. `lib/logger.ts` exists but is never imported anywhere — dead module
### L6. `getSession()`, `resetTransporter()`, `generateChatResponse()`, `loadDocumentTree()` exported but never called
### L7. `users_username_idx` redundant with UNIQUE constraint
### L8. `permit_certificates.certificate_number` has duplicate UNIQUE indexes
### L9. `analytics_daily` ORDER BY in materialized view is meaningless
### L10. TIMESTAMPTZ vs TIMESTAMP WITH TIME ZONE mixed — style inconsistency
### L11. `SELECT *` on heavy JSONB tables in list views — [actions/permits.ts:342,380,432](actions/permits.ts#L342)
### L12. Lucide icons imported in `lib/constants.ts` (Edge-runtime risk) — [lib/constants.ts:5](lib/constants.ts#L5)
### L13. Origin-header check skipped when header missing — [app/api/chat/stream/route.ts:33-50](app/api/chat/stream/route.ts#L33-L50)
### L14. `.claude/CLAUDE.md` discloses architecture (RLS bypass, fail-open middleware) — disclosure risk if repo is public
### L15. Hook silently swallows all errors — [.claude/hooks/lint-on-edit.mjs:39-41](.claude/hooks/lint-on-edit.mjs#L39-L41)
### L16. Hook stderr passes raw child stdout — prompt injection channel
### L17. `Bash(npx eslint *)` and `Bash(npx next *)` allow arbitrary subcommands — [.claude/settings.json:19-20](.claude/settings.json#L19)
### L18. `env: { NODE_ENV: "development" }` set unconditionally — [.claude/settings.json:59-61](.claude/settings.json#L59)

---

## Dead Code & Dependencies

**Unused npm production deps (safe to remove):**
- `@google/generative-ai` (project uses `@google/genai`)
- `isomorphic-dompurify` (zero imports)

**Unused devDeps:**
- `@types/dompurify`, `eslint-config-next`, `supabase` CLI

**Unused files:** [lib/logger.ts](lib/logger.ts) (entire file)

**Dead exports (safe — `export` keyword only):**
- `CRAG_THRESHOLD` ([lib/rag.ts:21](lib/rag.ts#L21))
- `citationSchema`, `permitStatusSchema` ([lib/validations.ts:186,215](lib/validations.ts#L186))
- `DialogTrigger` ([components/ui/dialog.tsx:70](components/ui/dialog.tsx#L70))
- `ScrollBar` ([components/ui/scroll-area.tsx:58](components/ui/scroll-area.tsx#L58))

**Dead functions (verify test mocks first):**
- `getSession`, `resetTransporter`, `generateChatResponse`, `_getCacheState`, `_seedCache`, `loadDocumentTree`

**Risky to remove (referenced by test mocks):**
- `createServerClient`, `getOffTopicResponse`, `getGreetingResponse`, `getAllDocumentsSync`, `getDocumentByFileName`

**Duplicate logic clusters:**
- 3 separate permit status configs (constants vs chart vs filter list)
- Deprecated `chatModel`/`streamingModel` proxies vs `getChatModel()`/`getStreamingModel()`
- Two parallel ingestion trigger paths (`actions/ingest-pdf.ts` vs `actions/documents.ts`)
- `lib/logger.ts` vs raw `console.*` everywhere

---

## TOP 10 — Fix These First

| # | ID | What | Why now |
|---|----|------|---------|
| 1 | **C1** | Rotate every secret in `.env.local`; move to secrets manager | Live credentials exposed; rotation is non-blocking and fastest mitigation |
| 2 | **C2** | Remove `Admin123!` default user from migration | Public repo + idempotent migration = known-credential admin on every deploy |
| 3 | **C3** | Replace all `USING(true)` RLS policies with ownership checks | Direct PostgREST request from any logged-in user reads any other user's data |
| 4 | **C5+H19** | Remove `anon` write grant on `dubai_code_chunks`; revoke `insert_semantic_cache`/`cleanup_semantic_cache` from `authenticated` | Any user can poison RAG corpus or wipe cache via PostgREST |
| 5 | **C6** | Sanitize/delimit RAG context before LLM prompt | PDF-borne prompt injection escalates any admin upload into system-prompt extraction |
| 6 | **C7** | Don't write empty cache on DB error in `document-registry`/`document-selector` | 5-min silent outage every time DB hiccups |
| 7 | **H1** | Remove `unsafe-inline`/`unsafe-eval` from CSP; use nonces | One XSS bug = full session takeover today |
| 8 | **H2** | Fix `lint-on-edit.mjs`: drop `shell: true`, validate `abs` chars, guard `--`-prefix | Command injection from any edited file path with shell metachars |
| 9 | **H3+H4** | Trust `X-Forwarded-For` only behind known proxy; add per-account login lockout | Trivial credential stuffing today |
| 10 | **H6** | Move 100MB body limit to a dedicated `/api/upload` route; restore default for everything else | DoS amplification on every server action |

---

## Coverage Notes

- All 6 agents completed successfully.
- Some overlap was deduplicated (CSP, service_role, in-memory rate limiter, file-upload MIME, 100MB body, TOCTOU permit submit appeared in 2-3 reports — kept the most specific reference).
- `npm audit` was NOT run; recommend `npm audit --omit=dev` as a quick add-on.
- `.env.local` rotation status: not yet performed.

**Awaiting confirmation before starting Phase 2 (fixes).** Suggested fix order: C1 → C2 → C5 → H19 → C3 → C4 → H2 → H1 → C7 → C6 → then sweep H3-H6 → then mediums.

---

# Phase 2 Audit Report — PermitForge

**Date:** 2026-04-26
**Scope:** Test coverage, system architecture, code simplification, click-path / state-machine integrity
**Method:** 4 parallel specialized agents (tdd-guide, architect, simplify skill, click-path-audit skill)
**Status:** Findings only — NO fixes applied yet. Awaiting confirmation.

Detail reports:
- `.claude/phase2-coverage.md` — coverage gaps + missing tests
- `.claude/phase2-architecture.md` — system-level architecture review
- `.claude/phase2-simplify.md` — top 20 simplification opportunities
- `.claude/phase2-clickpath.md` — UI flow / state-machine bugs

---

## Executive Summary — Phase 2

| Area | Headline |
|------|----------|
| **Coverage** | Overall 37% statements / 31% branches — fails 80% target. `lib/` 35%, `components/` 0%. `middleware.ts`, `pdf-ingestion.ts`, `pdf-parser.ts`, `permit-certificate.ts`, `semantic-cache.ts`, `tree-cache.ts`, `document-selector.ts`, `keyword-extractor.ts`, `notifications.ts` all at 0%. |
| **Architecture** | 4 in-memory caches with no cross-instance coordination, 5-min block-lag security window, no central permit state machine, embedding quota is hard ceiling, notifications/status not transactional. |
| **Simplification** | ~1,030–1,300 LOC reducible (5–6%). Server-action boilerplate repeated 25+ times, `queryBuildingCode` duplicated, ingestion-streaming UI duplicated across 2 admin tabs. |
| **Click-paths** | 5 CRITICAL flow bugs: phantom DB writes if user navigates mid-AI-check, ingestion abort doesn't cancel server, cross-session SSE leak saves messages under wrong session, double-submit gap, re-ingest leaves stale chunks. |

---

## Phase 2 — CRITICAL findings

### P2-C1. AI compliance check is not cancellable; navigate-away → phantom DB writes
- **File:** [app/permits/new/page.tsx:163-188](app/permits/new/page.tsx#L163-L188), [actions/permits.ts:540-616](actions/permits.ts#L540-L616)
- 10–30s LLM call. If user closes tab, server still writes `compliance_check_result` to DB. Re-opening permit shows result user never confirmed.
- **Fix direction:** Pass `AbortSignal` from client; check before persisting.

### P2-C2. Ingestion abort doesn't cancel server-side processing
- **File:** [components/admin/document-management.tsx:301-378](components/admin/document-management.tsx#L301-L378), [app/api/ingest/route.ts](app/api/ingest/route.ts)
- Closing tab during ingestion: server keeps running, embeddings keep burning Gemini quota, DB ends with partial chunks and no "incomplete" marker.
- **Fix direction:** Listen for `request.signal.aborted` in route; mark ingestion state explicitly.

### P2-C3. Re-ingest path doesn't clear prior chunks → stale citations point to wrong pages
- **File:** [components/admin/document-management.tsx:301-378](components/admin/document-management.tsx#L301-L378), [lib/pdf-ingestion.ts:326-340](lib/pdf-ingestion.ts#L326-L340)
- Pipeline has resume support keyed on chunk content. If PDF was replaced, old chunks remain with stale page numbers next to new ones. No checksum/version key. (Also surfaced in architecture review §4.4 as destructive race.)
- **Fix direction:** Track `pdf_hash`; transactionally clear or version chunks on PDF replace.

### P2-C4. Cross-session SSE leak — chat message saved under wrong session
- **File:** [components/chat/chat-interface.tsx:63-90](components/chat/chat-interface.tsx#L63-L90)
- Switching from session A → session B mid-stream does NOT abort the in-flight stream. Stream completes against B in UI, but `saveMessageToSession({sessionId: A})` persists under A. Phantom message disappears on reload.
- **Fix direction:** Abort prior controller in the `if (sessionId)` branch of session-switch effect.

### P2-C5. Submit step double-submit + status-history / notification not transactional
- **Files:** [app/permits/new/page.tsx:135-161](app/permits/new/page.tsx#L135-L161), [actions/permits.ts:231-326](actions/permits.ts#L231-L326), [actions/admin-permits.ts:60-170](actions/admin-permits.ts#L60-L170), [actions/notifications.ts:31-71](actions/notifications.ts#L31-L71)
- Two synchronous click events can both pass the `loading` gate. Compliance write + status write are 2 separate non-transactional actions; status_history insert is a third call after the UPDATE; notification is a fourth, with errors swallowed (line 306-316). Status flips to `submitted` but history/email may be missing — and user has no signal.
- **Fix direction:** Single RPC for status-change + history + notification queue; ref-based in-flight guard on submit.

---

## Phase 2 — HIGH findings (selected)

### Architecture

- **P2-A1.** In-memory caches (`blockStatusCache`, `document-registry`, `document-selector`, `tree-cache`) are per-process. Multi-instance deploys see stale data up to 5 min after admin edits. No Redis, no pub/sub. (Same root cause as P2-C7 in click-path: 5-min block-lag.)
- **P2-A2.** No central permit state machine — transition rules duplicated across 7 places. Adding a new state forces 7 edits.
- **P2-A3.** Compliance check result never invalidated when building details change while draft. User edits height 50→200; "Compliant" badge persists with old result.
- **P2-A4.** Status-change + status_history + notifications are 3 separate non-transactional writes. Partial failures leave inconsistent state. (Overlaps with Phase 1 M6.)
- **P2-A5.** No optimistic concurrency (`version` / etag) on `permit_applications`. Last-write-wins between two-tab edits.
- **P2-A6.** `runComplianceCheck` issues up to 7 hybrid searches × ≤7 embedding retries — single user click can consume ~7 embeddings. No per-user throttle. (Overlaps Phase 1 H11.)
- **P2-A7.** Cache-stampede on `semantic_cache` cold start: 100 concurrent identical queries each generate embedding + LLM. No singleflight.
- **P2-A8.** `dubai_code_chunks.document_name` is implicit string FK to `document_registry.id`; no DB constraint. Renaming/deleting a doc orphans chunks silently.
- **P2-A9.** Resume race in PDF ingestion: two parallel ingest invocations on same `documentId` (admin double-clicks) both compute "chunks already present" diff and both insert their batches → duplicate content rows. No row-level lock.

### Click-paths

- **P2-H1.** Permit form state lives only in `useState`. Reload during step 2/3 → form restarts at step 1 + leaves dangling draft in DB.
- **P2-H2.** Spec says step 3 includes file uploads, but code's step 3 only has compliance toggles. Files only uploadable from `/permits/[id]` after submit-or-save-draft.
- **P2-H3.** AI Check button has no client-side cooldown. Repeated clicks burn Gemini quota.
- **P2-H4.** Notification bell mark-as-read is optimistic with no rollback on server rejection. Bell count diverges from server.
- **P2-H5.** Document upsert + PDF upload is non-atomic. Upload fail after metadata save → registry has `storage_path: null` row, Ingest button disabled, no sticky warning.
- **P2-H6.** CSRF token fetched once on mount; never refreshed. Long-idle session → all subsequent actions return "Invalid CSRF" until reload.
- **P2-H7.** Block-cache lag: 5 min between admin clicking "Block" and the user's session being denied. (Same data point as P2-A1.)

### Coverage gaps (HIGH)

- **P2-T1.** `middleware.ts` — 0% coverage. JWT verify, block-cache TTL, role redirect, security headers — none tested.
- **P2-T2.** `lib/auth.ts` — 30% statements / 16% branches. `createSession`, `destroySession`, `getSession`, `getQuickSession`, `logAuditEvent` paths untested.
- **P2-T3.** `lib/chat-pipeline.ts` cache-HIT path untested. `ENABLE_CACHE: false`, `ENABLE_PARENT_EXPANSION: false`, `ENABLE_TREE_REASONING: false` config branches untested.
- **P2-T4.** `lib/rag.ts` — `filteredHybridSearch` / CRAG / `expandToParentChunks` paths untested.
- **P2-T5.** `lib/gemini.ts` — 5% branches. Quota retry loop, `DailyQuotaExhaustedError` path, network retry with exponential backoff — none tested.
- **P2-T6.** `lib/permit-certificate.ts`, `lib/pdf-ingestion.ts`, `lib/semantic-cache.ts`, `lib/tree-cache.ts`, `lib/document-selector.ts`, `lib/keyword-extractor.ts`, `lib/notifications.ts` — all 0%.
- **P2-T7.** `actions/ingest-pdf.ts` — 0% coverage. Auth/admin guard, CSRF, audit log untested.
- **P2-T8.** Components directory — 0% coverage across 30+ files. No React component tests exist.
- **P2-T9.** Edge cases not tested: `x-middleware-subrequest` CVE header, file-size boundary (10MB ± 1B), DWG/DXF MIME spoofing, concurrent `getAllDocuments` deduplication, expired-code boundary, JWT signed with wrong secret.
- **P2-T10.** Several existing tests have weak assertions (e.g. `chat-pipeline.test.ts:111` checks `fromCache===false` but not embedding length; `permit-compliance.test.ts:95` asserts `>= 1` calls instead of expected count).

### Simplification (HIGH leverage)

- **P2-S1.** Repeated `requireAuth + requireCSRF + try/catch + Zod.safeParse + audit log` boilerplate across 25+ server actions (~250–350 LOC). Wrap in `withMutation({admin?, schema?, csrf, audit?}, handler)`.
- **P2-S2.** `queryBuildingCode` and `queryBuildingCodeFiltered` in [lib/rag.ts:138-187](lib/rag.ts#L138-L187), [lib/rag.ts:324-377](lib/rag.ts#L324-L377) duplicate ~80% of logic. Single fn with `pageRanges?` param.
- **P2-S3.** `pdf-ingestion-tab.tsx` and `document-management.tsx` duplicate ~150 LOC of SSE-streaming logic. Extract `useIngestionStream()`. (Investigate whether `PdfIngestionTab` is dead — if so delete.)
- **P2-S4.** `chat-interface.tsx > handleSendMessage` is ~220 LOC with 4 cancellation flags + custom `__CITATIONS__`/`__ERROR__` markers. Extract `useChatStream()` hook + switch to event-typed SSE.
- **P2-S5.** `runIngestionPipeline` is 300+ lines with 8 inline stages and hand-tuned magic progress numbers. Decompose into stage functions.
- **P2-S6.** RPC + direct-query fallback duplicated 3× in `actions/documents.ts` and once in `lib/pdf-ingestion.ts > saveDocumentTree`. Either remove (migration is mandatory) or factor `tryRpcOrFallback`.

---

## Phase 2 — MEDIUM / LOW (compressed)

**Medium**
- Sidebar refetches sessions on every `currentSessionId` change (extra DB reads).
- PermitManagement filter pills lose state on tab change.
- UserManagement: rapid actions cause multiple `loadUsers` in flight (last-write-wins flicker).
- Certificate route regenerates PDF even when prior cert exists.
- FileUploadZone drag-drop fires while upload in progress.
- `/permits` user list has no live update when admin reviews.
- Audit-log helper boilerplate at end of every mutation (~50 LOC).
- `safeEqual` duplicated between `actions/auth.ts` and `actions/profile.ts`.
- 6 near-identical `<Dialog>` blocks in `user-management.tsx` (~80 LOC consolidatable into `<ConfirmDialog>` / `<ResultDialog>`).
- `DocumentManagement` has 13 useState hooks — split into list + form, use `useReducer`.

**Low**
- Chat cooldown is client-only; closing tab bypasses MIN_REQUEST_INTERVAL (server catches).
- NotificationBell polls every 30s with no jitter — synchronized polls across tabs.
- Cursor pagination duplicated in `chat-history.ts`.
- `BADGE_COLORS` hardcoded inline in `document-management.tsx`.
- Dynamic `import('@/lib/validations')` in `actions/admin.ts:448` — should be static.

---

## CONSOLIDATED TOP-10 — Across Phase 1 + Phase 2

Updated to reflect both phases. Phase 1 critical security still dominates positions 1–6 (hard exploitability). Phase 2 surfaces #7–#10 (correctness + flow integrity).

| # | ID | What | Why now |
|---|----|------|---------|
| 1 | **C1** | Rotate every secret in `.env.local`; move to secrets manager | Live credentials exposed; rotation is non-blocking and fastest mitigation |
| 2 | **C2** | Remove `Admin123!` default user from migration | Public repo + idempotent migration = known-credential admin on every deploy |
| 3 | **C3 + C4** | Replace `USING(true)` RLS with ownership; switch user-context queries to anon client | Direct PostgREST request from any logged-in user reads any other user's data; service-role hides RLS gaps |
| 4 | **C5 + H19** | Remove `anon` write grant on `dubai_code_chunks`; revoke `insert_semantic_cache`/`cleanup_semantic_cache` from `authenticated` | Any user can poison RAG corpus or wipe cache via PostgREST |
| 5 | **C6** | Sanitize/delimit RAG context before LLM prompt | PDF-borne prompt injection escalates any admin upload into system-prompt extraction |
| 6 | **H2** | Fix `lint-on-edit.mjs`: drop `shell: true`, validate `abs` chars, guard `--`-prefix | Command injection from edited file path with shell metachars |
| 7 | **P2-C5 + P2-A4** | Single RPC for permit status-change + history + notification; add ref-based in-flight guard on submit | Today: status flips but history/notification can silently miss; double-click can race compliance write |
| 8 | **P2-C1 + P2-C2** | Add `AbortSignal` to AI compliance check and ingestion fetch; check `request.signal.aborted` in routes | Phantom DB writes after navigate-away; ingestion keeps burning Gemini quota after user closes tab |
| 9 | **P2-C3** | Re-ingest must clear prior chunks (or version by `pdf_hash`) before insert | Stale chunks with mismatched page numbers silently corrupt all citations |
| 10 | **P2-C4 + H7+P2-A1** | Abort prior SSE in session-switch effect; add Redis (or pub/sub) to invalidate `blockStatusCache` + 3 module caches across instances | Cross-session message persisted under wrong session; 5-min security window after admin blocks user |

---

## Phase 1+2 totals

| Severity | Phase 1 | Phase 2 (incl. test gaps) | Total |
|---|---|---|---|
| Critical | 7 | 5 | **12** |
| High | 22 | ~25 (incl. P2-A, P2-H, P2-T1-T8) | ~47 |
| Medium | 24 | ~18 | ~42 |
| Low | 18 | ~10 | ~28 |

**Verdict still: BLOCK production.** Phase 1 critical exploits remain unaddressed. Phase 2 adds correctness/flow-integrity bugs and reveals coverage is too low to safely ship the fixes (37% statements is below the threshold needed to confidently land remediation work).

---

**Awaiting confirmation before starting fixes.** Suggested integrated fix order:
1. Phase 1 critical security: C1 → C2 → C5+H19 → C3+C4 → C6 → H2 → C7 → H1
2. Phase 2 correctness criticals: P2-C5 (transactional status-change) → P2-C1+C2 (abort signals) → P2-C3 (re-ingest hash) → P2-C4 (SSE abort)
3. Phase 1 sweep: H3-H6 → mediums
4. Coverage backfill on touched modules to ≥80% before any merge.
