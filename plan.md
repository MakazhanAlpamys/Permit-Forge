# PermitForge — Remediation Roadmap (2026-05-21 audit)

> **Workflow:** this plan IS committed and pushed alongside releases. It serves as the public roadmap and release-history for the diploma defense. Update + commit it as part of every release (see "Post-fix verification" step 6).

**Repo:** local diploma demo · **Branch:** main · **Source audits:** [docs/audits/phase1-report.md](docs/audits/phase1-report.md) + 10 section files
**Current state:** 226 findings open — **28 Critical / 54 High / 80 Medium / 64 Low**
**Defense window:** ~3-4 weeks before diploma defense (≈ 2026-06-15)

---

## Diploma wontfix (DO NOT TOUCH)

| ID | Where | Why excluded |
|----|---------------|-------|
| DIPLOMA-1 | `.env.local` | Live Supabase / Gemini / SMTP keys are needed for the running demo at defense |
| DIPLOMA-2 | `supabase/migrations/000_full_setup.sql:2081-2087` | `Admin123!` seed admin — reviewers need a known credential during defense |
| DIPLOMA-3 | `lib/login-lockout.ts` (in-memory) | Acknowledged in source; serverless multi-instance lockout is post-defense work |
| DIPLOMA-4 | `lib/block-status-cache.ts` 5-min TTL | Stale-up-to-TTL is acceptable for diploma scope (single Vercel instance) |
| DIPLOMA-5 | Optional `SUPABASE_JWT_SECRET` falling back to service_role | Documented in `LOCAL_NOTES.md`; opt-in via `ENABLE_USER_CONTEXT_RLS=1` already in place |

Any task below that implies breaking these must be re-scoped or skipped.

---

## How this plan is meant to be consumed

- **One Claude instance per Release.** Releases are scoped so file ownership rarely overlaps; pick a free release and claim it.
- **One Part ≈ one branch ≈ one PR.** Don't bundle. Land small.
- **Order within a Release is suggested, not strict** — except where `Depends on:` is listed.
- **Every Part has a Verification block.** Run it BEFORE marking the Part complete — that's where we confirm no regressions sneaked in.
- **Tests must pass before merge:** `npm run lint && npx tsc --noEmit && npx vitest run --pool forks`.
- **Update this file** as Parts land: change `[ ]` to `[x]` and note the commit hash.

Risk legend: 🟢 LOW (config / single file) · 🟡 MEDIUM (single subsystem) · 🔴 HIGH (touches hot path, needs manual smoke test)

Finding-ID legend: **DB-Cn / DB-Hn** (database) · **S-Hn** (security broad) · **AUTH-Cn / INPUT-Hn / SECRET-Mn** (security-review skill) · **TS-Hn** (typescript) · **A-Cn** (architecture) · **CP-Cn** (click-path) · **COV-Cn** (coverage) · **R-Hn** (refactor) · **SIM-Hn** (simplify)

---

## Release index (priority order)

| Release | Title | Severity covered | Risk | Days |
|--------:|-------|------------------|------|-----:|
| v1.0.0 | Auth Lockdown | 6 Crit + 4 High (DB / auth bypass) | 🔴 | 4 |
| v1.1.0 | JWT & State Coherence | 1 Crit + 4 High + 3 Med (token versioning / block) | 🔴 | 3 |
| v1.2.0 | Click-path Hardening | 7 Crit + 10 High + 11 Med (silent failures) | 🟡 | 4 |
| v1.3.0 | Pipeline Resilience | 4 Crit + 5 High (singleflight / SSE / cache races) | 🔴 | 5 |
| v1.4.0 | Test Coverage Foundation | 10 Crit gaps (close to 80% lines) | 🟡 | 5 |
| v1.5.0 | Security + DB High Cleanup | 11 High + 17 Med (remaining S-H / DB-H) | 🔴 | 4 |
| v1.6.0 | TypeScript & Runtime Safety | 6 High + 10 Med (TS casts + error boundaries) | 🟡 | 3 |
| v1.7.0 | Architecture Cleanup | 9 High + 8 Med (caches / observability / state machine) | 🔴 | 4 |
| v1.8.0 | Refactor & Simplify | 4 High + 27 Med (withMutation + dead code) | 🟡 | 4 |
| v1.9.0 | Medium Wave | ~30 Medium across all reports | 🟢 | 3 |
| v1.10.0 | Low Polish + Defense Prep | ~64 Low + final demo checks | 🟢 | 3 |
| **Total** | | **28C / 54H / 80M / 64L** | | **~42 days** |

> If defense lands at 2026-06-15 (~25 days), ship **v1.0 → v1.6** at minimum (≈ 24 days, covers all Critical + High). v1.7 → v1.10 land post-defense.

---

## v1.0.0 — "Auth Lockdown" (the 6 critical auth bypass holes)

**Tagline:** *Stop the bleeding — close every place where a logged-in user can become admin or read someone else's data.*

**Thesis:** Five `_atomic` RPCs and `code_attempts` are callable by `authenticated` with no admin guard, plus JWT `tv` is not re-checked on `/api/*`. Together these mean any logged-in user can approve permits, delete documents, read other users' chat queries, and bypass session revocation for 7 days. Highest-leverage cluster in the entire audit.

**Closes:** DB-C-1, DB-C-2, DB-C-3, DB-C-4, DB-C-5, AUTH-C1 (6 Critical) + DB-H-6, DB-H-7, DB-H-8, S-H-1 (4 High)

#### Part A — RPC admin guards inside function bodies 🔴

- [x] **DB-C-2 — `review_permit_atomic` admin guard.** In-body `auth.uid() IS NOT NULL` gate + role/role-match check; service_role calls bypass.
- [x] **DB-C-3 — `delete_document_atomic` admin guard.** Same pattern.
- [x] **DB-H-6 — `create_permit_atomic` user-id guard.** Rejects `auth.uid() <> p_user_id` unless caller is admin.
- [x] **DB-H-7 — `bump_user_token_version` admin guard.** Self-bump allowed, cross-user requires admin.
- [x] **DB-H-8 — `incr_code_attempt` / `clear_code_attempt`** ACL — REVOKEd from authenticated in Part B (these are anon pre-auth flows, no auth.uid() to compare against).

**Verification (Part A):**
- [ ] `psql` connected as a non-admin: `SELECT review_permit_atomic('<any-permit-id>', 'approved', 'x', '<user-id>');` → must RAISE EXCEPTION
- [ ] Same for `delete_document_atomic`, `bump_user_token_version` (other-user) — all 4 raise
- [ ] As admin: same calls succeed (regression check)
- [ ] `npx vitest run test/admin-actions.test.ts test/admin-permits-actions.test.ts --pool forks` — green

#### Part B — Revoke residual GRANTs to `authenticated` 🟡

- [x] **DB-C-4 — REVOKE atomic RPCs from `authenticated`.** Lockdown block at end of migration explicitly REVOKEs EXECUTE on all 8 atomic RPCs (submit/revise/review/create_permit, delete_document, bump_user_token_version, incr/clear_code_attempt) from anon, authenticated, PUBLIC; then GRANTs to service_role only.
- [x] **Audit other sensitive RPCs.** v1.0.0 db re-audit caught `search_semantic_cache` and `get_parent_chunks` still callable by `authenticated`; both REVOKEd in the same block. ACL policy documented as a comment in the lockdown block.

**Verification (Part B):**
- [ ] `\df+` on the Supabase SQL editor — review the ACL column for all 30+ RPCs
- [ ] Cross-check against the audit list in [docs/audits/phase1-database.md](docs/audits/phase1-database.md)
- [ ] `npx vitest run test/migration-grants.test.ts --pool forks` — should already exist; if not, add an invariant test that lists current grants and snapshots them

#### Part C — Enable RLS on `code_attempts` 🟢

- [x] **DB-C-1 — `ALTER TABLE code_attempts ENABLE ROW LEVEL SECURITY`** in lockdown block. service_role-only policy; no anon/authenticated policy = table invisible to them. Note: keys are TEXT (`verify:<email>`), not `user_id` — service-role-only deny path is the correct fix.
- [x] No other table lacks RLS — grep confirms all `CREATE TABLE` are paired with `ENABLE ROW LEVEL SECURITY`.

**Verification (Part C):**
- [ ] As anon via Supabase REST: `SELECT * FROM code_attempts;` → 0 rows (currently leaks all)
- [ ] As the owning user: returns only their rows
- [ ] As service_role: returns all rows (admin flow still works)

#### Part D — Lock down `semantic_cache` SELECT 🟡

- [x] **DB-C-5 — Removed the `"Allow read semantic_cache"` policy** that exposed every user's queries + responses to any authenticated caller. Replaced with service_role-only policy. The lockdown block also `DROP POLICY IF EXISTS` for fresh DBs that already ran the old policy.
- [x] Same for `parent_chunks` — `"Allow read parent_chunks"` policy removed.
- [x] Chat-pipeline tests green: all reads through `createAdminClient` (service_role) bypass RLS as expected.

**Verification (Part D):**
- [ ] As authenticated via Supabase REST: `GET /rest/v1/semantic_cache?limit=1` → 401/403 or 0 rows
- [ ] Chat-pipeline test green: `npx vitest run test/chat-pipeline.test.ts --pool forks`
- [ ] Manual: send a chat query, verify cache populates and hit works on second identical query

#### Part E — JWT `tv` re-check on `/api/*` routes 🔴

- [x] **AUTH-C1 — Added `tv` check inside `requireAuth`** at [lib/security.ts](lib/security.ts). Reads `users.token_version` in the same DB hop that already reads `blocked` (no extra round-trip). Returns `success: false, error: 'Session revoked'` when `jwt.tv < db.token_version`. `getQuickSession` now exposes `tokenVersion` from the JWT.
- [x] Re-audit caught that the API routes were calling `getQuickSession` directly, not `requireAuth` — so the tv check wasn't firing for any of them. Fixed: all 5 API entry points (chat/stream, chat/export, permits/[id]/certificate, ingest, admin/documents/upload) now boot through `requireAuth` / `requireAdmin`. Also fixed `createChatSession` + `saveMessageToSession` mutations to gate on `requireAuth`.

**Verification (Part E):**
- [ ] Manual: log in, copy JWT, change password (which bumps token_version), use old JWT against `/api/chat/stream` → 401
- [ ] Same scenario against `/api/permits/[id]/certificate` → 401
- [ ] Existing session in a clean tab still works (token_version stays equal)
- [ ] `npx vitest run test/api-routes.test.ts test/api-chat-stream.test.ts --pool forks` — green

#### Part F — Chat-stream rate-limit endpoint label 🟢

- [x] **S-H-1 — Chat stream now uses `endpoint: 'chat'`** at [app/api/chat/stream/route.ts](app/api/chat/stream/route.ts).
- [x] Sweep complete: `app/api/ingest/route.ts` uses `endpoint: 'ingest'`, `actions/permit-attachments.ts` uses `endpoint: 'permit-attachment'`. No remaining unlabelled `checkRateLimit(userId)` callsites across `actions/`, `app/api/`, `lib/`.

**Verification (Part F):**
- [ ] Query `rate_limits` table after sending a chat message: row with `endpoint = 'chat'` exists
- [ ] Existing rate-limit tests green
- [ ] Stress test (10 messages in 60s by one user): hits the `'chat'` bucket limit, not `default`

**v1.0.0 totals:** ~250 LOC + ~25 new tests. Closes 10 of 28 Critical/High auth-bypass findings. **Highest-priority release in the entire roadmap.**

**Landed:** commit `028dc69` (pending push). Actual delta: +523/-58 across 16 files (~10x the planned LOC because re-audits surfaced 3 follow-up fixes — 5 API routes migrated to `requireAuth`, 2 chat-history mutations gated, `search_semantic_cache` / `get_parent_chunks` REVOKEd).

**Automated verification passed:**
- ✅ `npm run lint` clean
- ✅ `npx tsc --noEmit` clean
- ✅ `npx vitest run --pool forks` — 997 / 997 (was 996; +1 net new test; +18 new tests within existing files for the changes above)
- ✅ Per-Part test runs: migration-grants (43), admin-actions, admin-permits-actions, chat-pipeline, api-routes, api-chat-stream — all green
- ✅ `npm run build` — clean
- ✅ Database re-audit (database-reviewer agent): all 8 db findings confirmed closed, new actionable item (search_semantic_cache + get_parent_chunks REVOKE) folded in
- ✅ Security re-audit (security-reviewer agent): AUTH-C1 + S-H-1 confirmed closed, new HIGH findings (5 API routes + 2 chat-history mutations bypassing requireAuth) folded in
- ✅ `grep -rn 'checkRateLimit('` sweep: every callsite passes an `endpoint` label (no remaining `default`-bucket leaks)
- ✅ `grep 'CREATE TABLE' ... ENABLE ROW LEVEL SECURITY` cross-check: all 17 tables have RLS, including `code_attempts`

**Cannot be verified without live infra — left as manual smoke for defense-day:**
- ⏳ `psql` direct RPC calls as non-admin should `RAISE EXCEPTION` (Part A)
- ⏳ Supabase REST as anon: `SELECT * FROM code_attempts` → 0 rows (Part C)
- ⏳ Supabase REST as authenticated: `GET /rest/v1/semantic_cache?limit=1` → 0 rows (Part D)
- ⏳ Browser: change password → use old JWT against `/api/chat/stream` → 401 within seconds (Part E)
- ⏳ Browser: send chat → `rate_limits` row written with `endpoint='chat'` (Part F)
- ⏳ 5-step manual smoke from Post-fix verification block (login, chat, permit create→submit, admin approve, JWT after logout)

---

## v1.1.0 — "JWT & State Coherence"

**Tagline:** *Stop force-logging-out users who changed their username, and stop running blocked users from working for 5 minutes.*

**Thesis:** Three places mishandle JWT regeneration and block-status propagation. CP-C-1 is a known regression that hits every user who ever changed their password and then edits their profile. A-C-4 is the diploma-tolerated edge-cache staleness — we tighten the TTL and document it.

**Closes:** CP-C-1 (1 Critical) + AUTH-H1, AUTH-H2, AUTH-M5, A-M-3 (4 High/Med) + S-M (logout + bump token_version)

#### Part A — Profile username update carries `tokenVersion` 🔴

- [x] **CP-C-1 — Fix `updateUsername` action** at [actions/profile.ts:83-91](actions/profile.ts#L83-L91). `updateProfileAction` now passes `tokenVersion: auth.user.tokenVersion` when minting the rotated JWT after a username change. Re-audit caught that `requireAuth` was destructure-stripping `tokenVersion` before returning the user — exposed it via the (now optional) `tokenVersion` field on `AuthenticatedUser`. Confirmed `confirmPasswordChangeAction` (line 211) and `adminChangePasswordAction` (line 273) already pass `tokenVersion: newTv` — no change needed there.
- [x] Sweep complete: all four `createSession(...)` callsites pass `tokenVersion` — `actions/auth.ts:171` (login: `user.token_version ?? 0`), `actions/profile.ts:87` (updateProfile: CP-C-1 fix), `actions/profile.ts:216` (confirmPasswordChange: newTv), `actions/profile.ts:278` (adminChangePassword: newTv).

**Verification (Part A):**
- [ ] Manual: register a user → change password → change username → navigate to `/permits`. Today: logged out. After fix: still logged in.
- [x] `npx vitest run test/profile-actions.test.ts --pool forks` — 25/25 green; added explicit CP-C-1 assertion that `createSession` is called with `tokenVersion`.
- [x] grep verifies no `createSession(` callsite passes only 3 args.

#### Part B — Logout bumps `token_version` 🟡

- [x] **S-M (logout) — In `logoutAction`** at [actions/auth.ts:201-244](actions/auth.ts#L201). `bump_user_token_version` RPC now runs before `destroySession()`. RPC failures are tolerated (cookie still cleared — half-completed logout is strictly safer than refusing to log out). Anonymous logout (no session) skips the bump.
- [x] **AUTH-M5 — Username change** already covered by Part A.

**Verification (Part B):**
- [ ] Manual: log in from two tabs → logout in tab 1 → reload tab 2 → redirects to /login (currently stays logged in until JWT expires)
- [ ] `chat_sessions` write attempts after logout fail with 401
- [x] `npx vitest run test/auth-actions.test.ts --pool forks` — 25/25; +4 new tests covering happy path / RPC failure / anonymous logout / CSRF-invalid logout.

#### Part C — Block-status cache TTL tightening 🟡

- [x] **A-C-4 / A-M-3 — Reduced TTL at [middleware.ts:17](middleware.ts#L17)** from `5 * 60 * 1000` → `30 * 1000`. Comment block (lines 8-16) documents that this is the FLOOR on staleness; Edge isolates don't share Map instances across V8 workers so `invalidateBlockStatus` only punches the local isolate's cache — production needs Redis.
- [x] Added `// NOTE: Edge isolate cache not invalidated cross-runtime — TTL is the floor` at all three `invalidateBlockStatus` callsites in [actions/admin.ts](actions/admin.ts) (blockUser, updateUserRole, adminDeleteUser).
- [x] **AUTH-H1 / AUTH-H2 — Block-status now fails CLOSED** at all three error paths in `checkUserBlocked`: missing env vars, non-OK HTTP response, thrown exception. Each returns `{ blocked: true, reason: 'Authentication service unavailable' }` + `console.error`. Re-audit confirmed no infinite-loop risk — public paths (`/login` etc) bypass `checkUserBlocked` because they short-circuit on the no-token branch.

**Verification (Part C):**
- [ ] Manual: block a user as admin → log in as that user within 30s → blocked (was 5 min before)
- [ ] Simulate Supabase outage (set wrong `NEXT_PUBLIC_SUPABASE_URL` for 30s): all requests now fail-closed (401) rather than letting blocked users through
- [x] `npx vitest run test/middleware.test.ts --pool forks` — 28/28; +3 new fail-closed tests (HTTP 500, fetch throws, missing env vars) + 1 cache-TTL-window test; flipped the old "fails open" assertion to "fails CLOSED".

#### Part D — Re-audit M1 follow-up 🟢

- [x] **Security-reviewer re-audit found M1:** `lib/security.ts` compares `user.tokenVersion < dbTokenVersion` where `tokenVersion` is typed optional. `undefined < N` evaluates `false` in JS — would be a silent fail-open if a future caller constructs `AuthenticatedUser` directly without `tokenVersion`. Added `(user.tokenVersion ?? 0)` guard with a comment explaining the defensive coercion.

**v1.1.0 totals:** ~80 LOC + ~10 tests planned; actual delta after re-audit follow-up: +112/-22 across 5 source files, +7 new tests. Closes the self-logout regression (CP-C-1) which is the most user-visible bug in the audit, plus AUTH-H1/H2 fail-open and AUTH-M5/A-M-3 staleness window.

**Landed:** v1.1.0 pending push. All verification clean:
- ✅ `npm run lint` clean
- ✅ `npx tsc --noEmit` clean
- ✅ `npx vitest run --pool forks` — 1004 / 1004 (was 997 in v1.0.0; +7 net new tests)
- ✅ Per-Part runs: profile-actions, auth-actions, middleware, lib-modules, auth — all green
- ✅ `npm run build` clean
- ✅ Security re-audit (security-reviewer agent): PASS, 0 Crit/0 High, 1 Medium folded in (M1 above), 2 informational Lows (cache-on-fail-closed and logout-race-window — both documented as intentional/known limitations)
- ✅ grep sweep: all 4 `createSession(...)` callsites pass `tokenVersion`

---

## v1.2.0 — "Click-path Hardening" (silent-failure family)

**Tagline:** *Turn every silent server-action failure into a visible toast. Wire confirm dialogs on every destructive action. Add in-flight guards everywhere.*

**Thesis:** The click-path audit found that ~1/3 of all Critical/High findings reduce to "`if (result.success) {...}` with no else branch". Fix the pattern once, sweep every consumer.

**Closes:** CP-C-2, CP-C-3, CP-C-5, CP-C-6, CP-C-7 (5 Critical) + 10 High click-path + 11 Med click-path

#### Part A — Unified `useServerAction` hook 🟡

- [x] **CP-C-2 / CP-C-3 — Added [hooks/use-server-action.ts](hooks/use-server-action.ts)** — wraps a server action with in-flight guard, surfaces `error` state for the caller to wire into `<ResultDialog>` (the codebase already had this primitive; no new toast lib needed). 9 unit tests in [test/use-server-action.test.tsx](test/use-server-action.test.tsx).
- [x] Refactored [components/chat/chat-interface.tsx](components/chat/chat-interface.tsx) — `createChatSession` failure now surfaces via `ResultDialog` (was: input cleared, spinner flickered, no user feedback).
- [x] Refactored [components/dashboard/sidebar.tsx](components/dashboard/sidebar.tsx) — `deleteChatSession` routed through `useServerAction` + `ResultDialog`.
- [x] Refactored [app/permits/page.tsx](app/permits/page.tsx) — `deletePermit` routed through `useServerAction` + `ResultDialog` + Cancel/Delete disable-while-loading.

**Verification (Part A):**
- [ ] Manual: block network → click delete on a session → see error dialog (currently dialog closes silently)
- [ ] Manual: send chat message with backend down → see error dialog
- [x] All existing chat / sidebar / permit tests green (97/97 across hook + chat + chat-save-sync + chat-history + permits + permits-extended).

#### Part B — Document delete/restore + audit 🟡

- [x] **CP-C-4 — Document soft-delete collision** at [actions/documents.ts](actions/documents.ts). `upsertDocument` now SELECTs the existing row before upserting; if it exists with `is_active=false`, returns `{ success: false, code: 'soft_deleted', error: '…Restore it instead of re-registering.' }` so the UI can route into the restore flow instead of silently resurrecting prior chunks.
- [x] **CP-C-5 — Restore via `ConfirmDialog` + `ResultDialog`** at [components/admin/document-management.tsx](components/admin/document-management.tsx). `handleRestore` now goes through `pendingConfirm` like every other destructive action; failures surface via `ResultDialog`. `restoreDocument` id-validates (same regex as `deleteDocument`) and audit-logs `pdf_ingested` with `stage: 'document_restored'`.

**Verification (Part B):**
- [ ] Manual: register doc "X" → delete → re-register "X" → see "name in use" prompt → routes to restore confirm (currently silently overwrites)
- [ ] Audit log shows `document_restored` event when restore confirmed
- [x] `npx vitest run test/documents-actions.test.ts --pool forks` — 35/35; +3 new tests covering soft-deleted collision, active-row update path, and no-existing-row create path.

#### Part C — Permit step navigation guards 🟡

- [x] **CP-C-6 — Step 2 dirty-tracking + discard confirm** at [app/permits/new/page.tsx](app/permits/new/page.tsx). `step2SnapshotRef` captured on step entry; `isStep2Dirty()` compares 8 keys against the snapshot. Back button routes through a new `ConfirmDialog` ("Discard changes?") when dirty.
- [x] **CP-C-7 — Separate `saveDraftInFlightRef` / `submitInFlightRef`** at the same file. Each handler short-circuits when EITHER ref is set, so a rapid click on one while the other is flying is a no-op. Both handlers wrap their critical section in `try/finally` so the ref always releases.

**Verification (Part C):**
- [ ] Manual: type in step 2 → click Back → see confirm dialog
- [ ] Manual: rapid double-click "Save Draft" → only one request fires (network tab confirms)
- [x] `npx vitest run test/permits-actions-extended.test.ts test/permit-form-step3.test.tsx --pool forks` — 41/41 green.

#### Part D — High-severity click-path sweep 🟡

All 10 landed in the same release.

- [x] **Logout CSRF empty-on-first-render** — [components/dashboard/header.tsx](components/dashboard/header.tsx) submit button now `disabled={!csrfToken}` so a click before the token resolves can't fire a CSRF-invalid logout (server still tolerates it, but this stops the audit-log noise).
- [x] **Notification mark-read race** — [components/notifications/notification-bell.tsx](components/notifications/notification-bell.tsx) gained a per-id `markingInFlightRef: Set<string>` so a triple-click on one notification doesn't fire 3 racing `markNotificationRead` calls.
- [x] **Permit delete in-flight guard** — [app/permits/[id]/page.tsx](app/permits/[id]/page.tsx) `handleDelete` now wraps in `deleteInFlightRef` (was the only mutation on this page without one — flagged by Part F re-audit).
- [x] **Attachment delete confirmation** — [components/permits/file-upload-zone.tsx](components/permits/file-upload-zone.tsx) routes delete through `ConfirmDialog` with the filename in the description; backdrop close blocked while deleting.
- [x] **Create-user dialog backdrop during submit** — [components/admin/create-user-dialog.tsx](components/admin/create-user-dialog.tsx) backdrop click + X button both ignored while `loading`.
- [x] **Review-permit dialog backdrop during in-flight** — [components/admin/permit-management.tsx](components/admin/permit-management.tsx) `onOpenChange` returns early when `actionLoading` is set.
- [x] **Re-ingest partial chunks visibility** — [app/api/ingest/route.ts](app/api/ingest/route.ts) flips `is_active=false` before clearing prior chunks (so RAG queries don't hit a half-rebuilt index) and restores `is_active=true` on either success or failure in the `catch` block.
- [x] **Block-user staleness UI hint** — [components/admin/user-management.tsx](components/admin/user-management.tsx) block confirm copy now mentions the 30 s block-cache TTL from v1.1 Part C.
- [x] **Certificate download blob revoke race** — [app/permits/[id]/page.tsx](app/permits/[id]/page.tsx) `URL.revokeObjectURL` + `removeChild` moved into `setTimeout(_, 0)` so Firefox doesn't truncate the download.
- [x] **Forgot-password second code invalidates first** — [app/forgot-password/page.tsx](app/forgot-password/page.tsx) clears the partial-typed code on a resubmit and shows an amber banner "A new code was sent. Previous codes no longer work."

**Verification (Part D):**
- [ ] Manual smoke test each of the 10 flows
- [x] `npx vitest run test/notification-bell.test.tsx test/permit-attachments.test.ts test/api-routes.test.ts --pool forks` — 31/31 green.

#### Part E — Medium click-path sweep 🟢

Plan called for 11 items with "spot-check 3 of the 11 manually". Shipped the 3 highest-leverage; remaining 8 deferred to v1.9.0 Medium Wave.

- [x] **verify-email expiry → resend** — new [`resendVerificationCodeAction`](actions/auth.ts) (IP-rate-limited, enumeration-safe always-success path) wired into [app/verify-email/page.tsx](app/verify-email/page.tsx) with a 30 s client-side throttle and "code sent" banner. Audit log `user_updated` with `reason: 'verification_code_resent'`.
- [x] **runComplianceCheck per-permit lock** — [app/permits/new/page.tsx](app/permits/new/page.tsx) gained `checkInFlightRef` keyed by `permitId` so a user with the same draft open in two tabs can't double-bill the LLM.
- [x] **Save Draft mid-AI-check race** — `checkSupersededRef` flipped by `handleSaveDraft` when an AI check is in flight; the check's result is then discarded so it can't clobber state the user just saved over.
- [ ] (+ 8 more deferred — see [docs/audits/phase2-clickpath.md](docs/audits/phase2-clickpath.md), folded into v1.9.0.)

**Verification (Part E):**
- [x] All 3 implemented; broader suite green after each.
- [ ] Manual spot-check the 3 deferred-to-v1.9 items during defense prep (v1.10 Part B).

#### Part F — Re-audit follow-ups 🟢

The click-path re-audit (general-purpose agent) found 3 silent-else callsites in `document-management` that match the same family v1.2 was meant to fix, plus the permits/[id] delete missing an in-flight guard.

- [x] `handleDelete` (Deactivate) at [components/admin/document-management.tsx](components/admin/document-management.tsx) now surfaces errors via `ResultDialog` (was: confirm modal closed silently on failure).
- [x] `handleDeleteWithChunks` same fix.
- [x] [app/permits/[id]/page.tsx](app/permits/[id]/page.tsx) `handleDelete` wrapped in `deleteInFlightRef` (also listed under Part D).
- [x] Pre-existing untouched: `fetchNotifications` polling (intentional silent-fail per its comment) and `loadPermits` / `loadSessions` (read-only, polling retries cover it). Documented as deferred to v1.9.0 polling-error pass.

**v1.2.0 totals:** planned ~400 LOC + ~30 tests; actual delta: +896 / -104 across 20 source files (1 new hook, 1 new test, 2 new server-action endpoints, 16 component refactors), +12 net new tests. Closes the entire silent-failure family targeted by the click-path audit.

**Landed:** source commit `394cef6` (release-format wrapper + plan/docs refresh = HEAD). All verification clean:
- ✅ `npm run lint` clean
- ✅ `npx tsc --noEmit` clean
- ✅ `npx vitest run --pool forks` — **1016 / 1016** (was 1004 in v1.1.0; +9 hook tests + 3 doc-collision tests = +12 net)
- ✅ `npm run build` clean (no new bundle warnings)
- ✅ Click-path re-audit (general-purpose agent): 0 Critical / 0 High introduced; the 3 silent-else follow-ups it flagged were closed in Part F before push

**Cannot be verified without browser — left as manual smoke:**
- ⏳ Block network → confirm delete → error dialog (Part A)
- ⏳ Soft-delete doc "X" → re-register "X" → restore prompt fires (Part B)
- ⏳ Edit step 2 → Back → discard confirm (Part C)
- ⏳ Rapid double-click any of (Save Draft / Submit / Attachment delete / Logout-on-load / Notification mark-read) → exactly one request fires (Part C/D)
- ⏳ Re-ingest mid-flight: send a chat query against the doc → should miss until re-ingest completes (Part D)
- ⏳ Certificate download on Firefox → file isn't 0 bytes (Part D)
- ⏳ Resend verification code → previous code rejected (Part E)
- ⏳ Open same permit in two tabs → click "Run AI Check" simultaneously → server-side rate limit hits, only one LLM call billed (Part E)

---

## v1.3.0 — "Pipeline Resilience" (architecture criticals)

**Tagline:** *Chat pipeline must not wedge or poison its own cache when Gemini misbehaves.*

**Thesis:** Singleflight has no timeout; SSE has no abort; semantic_cache insert has no de-dup. Combined, a single 429-throttled Gemini call can stall every concurrent user for 7 minutes AND populate the cache with truncated content for the next hour.

**Closes:** A-C-1, A-C-2, A-C-3, A-C-5, TS-H-5 (4 Critical + 1 High)

#### Part A — Singleflight hard timeout + AbortController 🔴

- [ ] **A-C-1 — Wrap `runRAGPipeline`** at [lib/chat-pipeline.ts:73-136](lib/chat-pipeline.ts#L73-L136) in `Promise.race` with a 30s ceiling. On timeout, the inflight entry is settled with `{error: 'pipeline_timeout'}` and removed; subsequent callers run their own pipeline.
- [ ] Add an `AbortController` per pipeline run; share it via the inflight entry so secondary waiters can race the same abort.
- [ ] Pass `signal` into [lib/gemini.ts:91-154](lib/gemini.ts#L91-L154) `generateEmbedding` — abort the retry loop on signal.
- [ ] Cap `inflightPipelines.size` at 100 (A-M-5). On overflow, run independently — don't collapse.

**Verification (Part A):**
- [ ] Manual: throttle Gemini API (set `GEMINI_API_KEY` to a free-tier key + spam queries) → pipeline aborts after 30s with a clear user-visible error
- [ ] `npx vitest run test/chat-pipeline.test.ts --pool forks` — extend with timeout + abort tests
- [ ] Stress test: 200 concurrent distinct queries → memory stays bounded, no leaked Promises

#### Part B — SSE plumbs `request.signal` to LangChain 🔴

- [ ] **A-C-2 / TS-H-5 — Plumb `request.signal`** at [app/api/chat/stream/route.ts:207-251](app/api/chat/stream/route.ts#L207-L251). Pass `signal` into `getStreamingModel().stream(messages, { signal })`. In the `for await` loop, check `signal.aborted` and break.
- [ ] Only call `cacheResponse` if streaming completed without abort AND `fullContent.length > MIN_RESPONSE_LENGTH` (e.g. 50 chars). Prevents cache poisoning.

**Verification (Part B):**
- [ ] Manual: send a chat message → close tab mid-stream → server log shows abort received, no further Gemini tokens consumed (check Gemini quota)
- [ ] Verify `semantic_cache` does not get the partial response (query the table after abort)
- [ ] `npx vitest run test/api-chat-stream.test.ts --pool forks` — add abort test

#### Part C — `semantic_cache` ON CONFLICT 🟡

- [ ] **A-C-3 — Add unique index** on a normalized query hash in [supabase/migrations/000_full_setup.sql](supabase/migrations/000_full_setup.sql): `CREATE UNIQUE INDEX semantic_cache_query_hash_idx ON semantic_cache (md5(query_text));`.
- [ ] Update `insert_semantic_cache` RPC to use `ON CONFLICT (md5(query_text)) DO UPDATE SET response = EXCLUDED.response, created_at = NOW()`.

**Verification (Part C):**
- [ ] Manual: fire 5 identical chat queries in 100ms (script) → `SELECT count(*) FROM semantic_cache WHERE query_text = ...` returns 1 (was N before fix)
- [ ] HNSW index size doesn't grow with duplicate inserts
- [ ] Existing cache-hit tests green

#### Part D — `setPermitUnderReview` atomic RPC 🟡

- [ ] **A-C-5 — Add `start_review_permit_atomic` RPC** in the migration mirroring `submit_permit_atomic`: `FOR UPDATE` row lock on `permit_applications`, UPDATE status, INSERT into `permit_status_history`, all in one `SECURITY DEFINER` function with admin guard.
- [ ] Refactor [actions/admin-permits.ts:181-270](actions/admin-permits.ts#L181-L270) to call the RPC. Removes the SELECT → UPDATE → INSERT split.

**Verification (Part D):**
- [ ] Simulate INSERT INTO permit_status_history failure (drop a NOT NULL constraint mid-test): UPDATE rolls back
- [ ] `npx vitest run test/admin-permits-actions.test.ts --pool forks` — extend with atomic-failure test
- [ ] Audit log invariant: every `under_review` permit has a corresponding `permit_status_history` row

**v1.3.0 totals:** ~300 LOC + ~25 tests. Closes the chat-pipeline reliability holes.

---

## v1.4.0 — "Test Coverage Foundation"

**Tagline:** *Get to 80% line coverage across `lib/`, `actions/`, `app/api/`. Add the first E2E smoke test.*

**Thesis:** Two API routes are at 0% (`/api/ingest`, `/api/admin/documents/upload`). Multiple `components/admin/*` files are effectively 0%. No E2E tests exist at all. Overall: 68% lines / 54% branches — below the 80% target. Closing the 10 critical coverage gaps creates a safety net for v1.5+ work.

**Closes:** COV-C-1 through COV-C-10 (10 Critical gaps) + the weak-assertion catalog from [docs/audits/phase2-coverage.md](docs/audits/phase2-coverage.md)

#### Part A — Add API route tests for ingest + upload 🟡

- [ ] **COV-C-3 — [app/api/ingest/route.ts](app/api/ingest/route.ts)** — write `test/api-ingest.test.ts`: auth gate, CSRF gate, rate-limit gate, SSE progress event format, error handling.
- [ ] **COV-C-4 — [app/api/admin/documents/upload/route.ts](app/api/admin/documents/upload/route.ts)** — write `test/api-admin-documents-upload.test.ts`: auth gate (admin), file validation, storage path generation.

**Verification (Part A):**
- [ ] Coverage on these two files goes from 0% → ≥ 80%
- [ ] `npm run test:coverage 2>&1 | grep "api/ingest\|admin/documents"` shows the bump

#### Part B — Coverage for `lib/transforms.ts`, `actions/ingest-pdf.ts`, `lib/auth.ts`, `lib/permit-compliance.ts` 🟡

- [ ] **COV-C-1 — `lib/transforms.ts`** — add tests for `snakeToCamel`, `numOrZero`, `transformPermit` golden-file mapping
- [ ] **COV-C-2 — `actions/ingest-pdf.ts`** — test `testRAGQuery` (lines 193-293), fallback direct-delete path in `clearDocumentChunks`
- [ ] **COV-C-5 — `lib/auth.ts`** — test `logAuditWithMeta`, `validateCSRFToken` timing-safe rejection (call with mismatched token)
- [ ] **COV-C-6 — `lib/permit-compliance.ts`** — test the `AbortSignal.aborted` early-exit path (mock signal, assert early return)

**Verification (Part B):**
- [ ] `npm run test:coverage` → all four files ≥ 80% lines
- [ ] No regressions in existing tests

#### Part C — Component tests for admin + permit + chat 🟡

- [ ] **COV-C-7 — `components/admin/*`** — at minimum `user-management.tsx`, `document-management.tsx`, `permit-management.tsx`. Render + interact with `@testing-library/react`. Mock server actions.
- [ ] **COV-C-8 — `components/permits/*`** — `permit-card.tsx`, `permit-detail-view.tsx`, `compliance-check-panel.tsx`
- [ ] **COV-C-9 — `components/chat/message-bubble.tsx` + `source-citation.tsx`** — render + assert citation links + DOMPurify behavior on adversarial input

**Verification (Part C):**
- [ ] Component coverage goes from ~0% to ≥ 50%
- [ ] CI green

#### Part D — E2E foundation (Playwright) 🔴

- [ ] **COV-C-10 — Add `@playwright/test` dependency** + `playwright.config.ts` + `test/e2e/` directory
- [ ] Write 5 smoke tests: login, register + verify, create permit, run compliance check, admin approve permit
- [ ] Add `npm run test:e2e` script (uses dev server)
- [ ] Add to CI: spin up Supabase local + Next.js, run E2E, upload trace on failure

**Verification (Part D):**
- [ ] `npm run test:e2e` green locally
- [ ] CI run green
- [ ] Each test produces a video + trace artifact on failure

#### Part E — Fix weak assertions + mock drift 🟢

- [ ] Replace `expect.any(Object)` for RPC argument matching with typed matchers (3 sites flagged in audit)
- [ ] Replace `toBeDefined()` / `toBeTruthy()` with string/equality matches (8 sites)
- [ ] Fix global `test/setup.ts` Supabase mock: add `order()`, `limit()`, `range()`, `in()`, `upsert()`, and `storage` to the chainable mock so silently-passing tests start failing if they were depending on the missing methods

**Verification (Part E):**
- [ ] After mock fixes, no existing tests break (means the missing methods weren't load-bearing) — OR some break and we now know what to fix
- [ ] Audit grep `expect.any(Object)` returns < 5 hits

**v1.4.0 totals:** ~600 LOC tests + Playwright config. Coverage target: 68% → 82% lines.

---

## v1.5.0 — "Security + DB High Cleanup"

**Tagline:** *Sweep the remaining 11 High security findings and 8 High database findings.*

**Closes:** S-H-2, S-H-3, S-H-4, S-H-5 + DB-H-1 to DB-H-5 (excluding DB-H-6/7/8 already done in v1.0) + AUTH-H3, AUTH-H4, INPUT-H1, INPUT-H2, INPUT-H3, SECRET-H1 + 17 Medium across security/db

#### Part A — Login lockout DB-backed (replace in-memory) 🟡

- [ ] **S-H-2 / AUTH-H3 — Migrate `lib/login-lockout.ts`** to use the existing `rate_limits` table or a new `login_attempts` table. Survives process restarts and serverless instances.
- [ ] DIPLOMA caveat: if scope allows, keep in-memory as fallback and add a "diploma mode" toggle.

#### Part B — `SUPABASE_JWT_SECRET` documentation gate 🟢

- [ ] **S-H-3 — Add `SUPABASE_JWT_SECRET` to README + CLAUDE.md required-env list.** When `ENABLE_USER_CONTEXT_RLS=1` is set but `SUPABASE_JWT_SECRET` is not, fail-fast at boot with a clear error (currently silently falls back to service_role).

#### Part C — Content-Disposition RFC 5987 encoding 🟢

- [ ] **S-H-4 — Encode filenames** in `app/api/permits/[id]/certificate/route.ts` and `app/api/chat/export/route.ts` via the `filename*=UTF-8''<encoded>` form. Use a helper in `lib/http-headers.ts`.

#### Part D — Remove `NEXT_PUBLIC_` from dev-insecure-cookies flag 🟢

- [ ] **S-H-5 / SECRET-H1 — Rename `NEXT_PUBLIC_DEV_INSECURE_COOKIES` to `DEV_INSECURE_COOKIES`** in [lib/cookie-options.ts:19](lib/cookie-options.ts#L19). It's read server-side only; the `NEXT_PUBLIC_` prefix leaks it to the client bundle.

#### Part E — Database High batch 🔴

- [ ] **DB-H-1 — Advisory lock 64-bit hash fix.** Replace `pg_advisory_xact_lock(bigint, bigint)` with the single-bigint form using `hashtextextended(text, bigint)` (full 64-bit). Audit the rate-limit RPC.
- [ ] **DB-H-2 — Cap `match_count`.** Add `LEAST(p_match_count, 50)` clamp at the top of each search RPC.
- [ ] **DB-H-3 — Admin queries N+1.** Refactor `get_all_users_admin` to apply user filter before aggregating sessions/messages (push down the predicate).
- [ ] **DB-H-4 — CRAG threshold unreachable.** Re-derive the threshold for the post-RRF-scaling score range and update [lib/rag.ts:22](lib/rag.ts#L22). Add a test that asserts the CRAG path actually fires on a deliberately-bad query.
- [ ] **DB-H-5 — `analytics_daily` MV refresh.** Add a daily cron-style refresh via Supabase Edge Function or a database-side `pg_cron` job (if available).

**Verification (Part E):**
- [ ] Existing DB tests green
- [ ] New `test/db-integrity.test.ts`: assert advisory_lock collision rate stays low; assert match_count is bounded; assert CRAG threshold triggers on adversarial input

#### Part F — Input & secret hardening medium sweep 🟢

- [ ] **INPUT-H1 — Truncate chat history** sent to LLM at [app/api/chat/stream/route.ts:189-202](app/api/chat/stream/route.ts#L189-L202). Cap total tokens, not row count.
- [ ] **INPUT-H2 — PDF parsing timeout** in [app/api/ingest/route.ts:78-97](app/api/ingest/route.ts#L78-L97). Wrap PDF.js parse in a 30s `Promise.race`.
- [ ] **INPUT-H3 — `searchChatHistory`** at [actions/chat-history.ts:446-452](actions/chat-history.ts#L446-L452) — use `createUserContextClient` (when `ENABLE_USER_CONTEXT_RLS=1`) instead of `createAdminClient` + manual `eq('user_id')` filter.
- [ ] **SECRET-M1/M3 — Reduce raw `error.message` echoing** to clients across 6+ action files. Standardize on a `userFacingError(err)` helper that strips internals.

**v1.5.0 totals:** ~350 LOC + ~25 tests. Closes remaining High-severity security/DB issues.

---

## v1.6.0 — "TypeScript & Runtime Safety"

**Tagline:** *Remove every `as any` / `as unknown as`, add `error.tsx` boundaries, fix hydration mismatches.*

**Closes:** TS-H-1, TS-H-2, TS-H-3, TS-H-4, TS-H-6 (5 High — TS-H-5 done in v1.3) + all 10 TS Medium

#### Part A — Type-safe Supabase rows 🟡

- [ ] **TS-H-1 — Remove `as unknown as PermitRow[]`** at [actions/permits.ts:386, 441](actions/permits.ts#L386) and [actions/admin-permits.ts:48](actions/admin-permits.ts#L48). Either generate Supabase types via `supabase gen types typescript` or use a Zod parse at the boundary in a `permitRowFromDb` helper.
- [ ] **TS-H-4 — Replace `as any` on chat_sessions join** at [actions/chat-history.ts:472](actions/chat-history.ts#L472) with a typed inline interface.

#### Part B — Null guards on `permit.status` cast 🟡

- [ ] **TS-H-2 — Add null guards** at all 6 sites where `permit?.status as PermitStatus` is used. Pattern: if `!permit?.status` return `'Permit not found'` instead of falling through to `canPerformOperation` with `undefined`.

#### Part C — `transformPermit` returns `undefined` for absent details 🟡

- [ ] **TS-H-6 — Stop casting `{} as BuildingDetails`** at [lib/transforms.ts:82-83](lib/transforms.ts#L82-L83). Return `undefined` and update consumers to handle the absence (or use `?` chaining).
- [ ] Audit `actions/permits.ts:641` and `lib/permit-compliance.ts:41` to ensure they handle `undefined` correctly.

#### Part D — `error.tsx` boundaries 🟡

- [ ] **TS-M-9 — Add `error.tsx`** for each major route segment: `app/error.tsx` (global), `app/permits/error.tsx`, `app/admin/error.tsx`, `app/profile/error.tsx`. Each renders a scoped error UI + "try again" button.
- [ ] Add `app/global-error.tsx` for catastrophic root-layout failures.

#### Part E — Hydration-safe dates + remove `console.log` from prod paths 🟢

- [ ] **TS-M-4 — Replace `toLocaleString()`** at 3 sites with `Intl.DateTimeFormat('en-US', {...})`. Pattern already used at `components/chat/message-bubble.tsx`.
- [ ] **TS-M-6 — Gate `console.log`** in `lib/chat-pipeline.ts`, `lib/semantic-cache.ts`, `lib/tree-cache.ts`, `lib/email.ts` behind a `DEBUG` env var or remove. Keep `console.error` / `console.warn`.

#### Part F — Misc TS mediums batch 🟢

- [ ] **TS-M-1** — replace `key={index}` on dynamic lists with stable keys
- [ ] **TS-M-2** — add `.catch()` to floating `getCSRFTokenAction()` promise
- [ ] **TS-M-3** — `loadSessionMessages` mount guard
- [ ] **TS-M-5** — `JSON.parse` try/catch with surfaced error in `use-ingestion-stream.ts`
- [ ] **TS-M-7** — log errors inside the 7 empty `catch` blocks in `actions/chat-history.ts`
- [ ] **TS-M-8** — tighten `withMutation` type (`parsed: T | undefined` or generic constraint)

**Verification (every Part):**
- [ ] `npx tsc --noEmit` green
- [ ] `npm run lint` green
- [ ] No new `as any` or `as unknown as` introduced (grep check)
- [ ] Hydration warnings absent in browser console during manual smoke test

**v1.6.0 totals:** ~300 LOC + ~20 tests.

---

## v1.7.0 — "Architecture Cleanup"

**Tagline:** *Fix cache coherence, add observability, expose state machine to client.*

**Closes:** A-H-1, A-H-2, A-H-3, A-H-4, A-H-5, A-H-6, A-H-7, A-H-8, A-H-9 (9 High) + 8 architecture Medium

#### Part A — Permit compliance TOCTOU + state-machine client API 🟡

- [ ] **A-H-1 — Conditional UPDATE on version** at [actions/permits.ts:598-707](actions/permits.ts#L598-L707) final compliance write. Discard the LLM result if `version` moved during the 60s LLM call.
- [ ] **A-M-2 — Client-safe `permit-state-machine.ts`.** Split into `permit-state-machine.ts` (pure, client-safe) and `permit-state-actions.ts` (server-only). Expose `isOperationAllowed(status, op)` to client components. Replace UI string-compares at 6 sites in `components/admin/permit-management.tsx`, `app/permits/[id]/page.tsx`, `app/permits/new/page.tsx`, `components/permits/permit-card.tsx`.

#### Part B — Tree cache LRU + dead-entry pruning + TTL respect 🟡

- [ ] **A-H-3 — Add LRU eviction** to `cacheMap` in [lib/tree-cache.ts:41](lib/tree-cache.ts#L41) with `MAX_CACHED_DOCS = 50`.
- [ ] **A-H-3 / A-L-2 — Prune dead entries.** In `getAllCachedDocumentTrees`, after the DB fetch, remove cacheMap keys not in the result set.
- [ ] **A-H-4 — Respect TTL** in `getAllCachedDocumentTrees`. Check `cacheMap` first; only hit DB if any entry exceeds TTL or count changed.
- [ ] Centralize all 3 cache invalidations (registry, profile, tree) into a single `invalidateAllDocumentCaches(name)` helper called from both `lib/pdf-ingestion.ts` and `actions/ingest-pdf.ts`.

#### Part C — Citation parser hardening 🟡

- [ ] **A-H-9 — Add Zod validation** at the boundary in [lib/rag.ts:51, 69](lib/rag.ts#L51) `mapHybridRow` / `mapExactRow`. Validate `chunk.metadata` against a `ChunkMetadataSchema`. Log a warning + use defaults on shape mismatch.
- [ ] **A-H-2 — Warn on sync-getter cold miss** at [lib/document-registry.ts:134-146](lib/document-registry.ts#L134-L146). When `getDocumentByIdSync` returns `undefined`, `console.warn` so the "Building Code" fallback is observable.

#### Part D — Email failure detection on password reset 🟡

- [ ] **A-H-6 — Inspect `sendPasswordResetEmail` return** at [actions/auth.ts:401-447](actions/auth.ts#L401-L447). If false for an existing user, clear `reset_code` and return an error string. Preserve enumeration safety for the "user does not exist" branch.

#### Part E — Structured logging foundation 🔴

- [ ] **A-H-7 — Add `pino`** as a dep. Create `lib/logger.ts` exporting a singleton with bindings for request ID, user ID, request path.
- [ ] Replace ~30 highest-impact `console.error` sites with `logger.error({...}, msg)`. Don't migrate all 67 in this PR — that's a continuous refactor.
- [ ] Add a per-request UUID middleware that injects `x-request-id` header (Edge runtime safe).
- [ ] **A-M-7 — Operational events table.** Add `operational_events` table for cache_hit / crag_fail / singleflight_collapse. Keep `audit_logs` security-focused.

#### Part F — Provider abstraction (defer-friendly) 🟢

- [ ] **A-H-8 — Centralize model names** in `lib/llm-config.ts`. Read `GEMINI_MODEL_CHAT`, `GEMINI_MODEL_EMBED` from env with defaults `gemini-2.5-flash` / `gemini-embedding-001`. Don't introduce a multi-provider abstraction yet (post-diploma work).

#### Part G — Architecture mediums sweep 🟢

- [ ] **A-M-1** — Counter metric for optimistic-lock retries (log + count)
- [ ] **A-M-4** — Move reranker weights + CRAG threshold to `CHAT_PIPELINE_CONFIG`
- [ ] **A-M-5** — Singleflight size cap (done in v1.3 Part A)
- [ ] **A-M-6** — Refactor `checkPermitCompliance` to use `executeRAGPipeline`
- [ ] **A-M-8** — Permit certificate cleanup on permit delete

**Verification (every Part):**
- [ ] `pino` log lines appear in `npm run dev` with request IDs
- [ ] `npx vitest run test/chat-pipeline.test.ts test/lib-modules.test.ts --pool forks` — green
- [ ] Manual: trigger a cache-stale scenario → see warn in logs

**v1.7.0 totals:** ~500 LOC + ~30 tests.

---

## v1.8.0 — "Refactor & Simplify"

**Tagline:** *Adopt `withMutation` everywhere. Remove ~250-300 LOC of duplicate skeleton.*

**Closes:** R-H-1, R-H-2, R-H-3, R-H-4 (refactor High) + SIM-H-1 through SIM-H-8 (simplify High) + 27 Med across refactor & simplify

#### Part A — `withMutation` tighten + adopt 🟡

- [ ] **SIM-H-1 / R-H-2 — Tighten `withMutation` typing** at [lib/security.ts:227-280](lib/security.ts#L227-L280). Make `parsed` `T | undefined` and require callers to handle both cases. Add explicit overloads for schema-vs-no-schema variants.
- [ ] Migrate `actions/auth.ts` first (highest-stakes path). One PR per action file.
- [ ] Then `actions/profile.ts`, `actions/permits.ts`, `actions/admin.ts`, etc. 24 action files total.

**Verification (per file migration):**
- [ ] All tests for that action file green
- [ ] Manual smoke test the action's UI flow
- [ ] grep: file no longer contains manual `requireAuth + validateCSRFToken + checkRateLimit + try/catch` skeleton

#### Part B — `logAuditWithMeta` sweep 🟢

- [ ] **R-H-3 — Adopt `logAuditWithMeta`** at the 24 call sites currently doing `getRequestMetadata` + `logAuditEvent` manually. Single PR per file.

#### Part C — Dead code removal 🟢

- [ ] **R-H-1 — Delete empty `app/reset-password/` directory.**
- [ ] **R-H-4 — Remove deprecated `uploadDocumentPDF`** export from `actions/documents.ts` + delete its 8 tests.
- [ ] **R-H-5 — Stop exporting `detectQueryType`** from `lib/agents.ts` (only used internally).
- [ ] Remove all 15 Medium unused exports listed in [docs/audits/phase1-refactor.md](docs/audits/phase1-refactor.md) (`snakeToCamel`, unused `Input` types, barrel re-exports, unused shadcn primitives, etc.).
- [ ] Remove the 23 inline migration-header comments in `000_full_setup.sql:2183+` referring to deleted 001-023 files.

**Verification (Part C):**
- [ ] `npx knip --reporter compact` returns fewer findings
- [ ] `npx tsc --noEmit` green
- [ ] All tests green

#### Part D — Duplicated logic consolidation 🟡

- [ ] **SIM-H-2 — Collapse twin optimistic-locking blocks** in `actions/permits.ts` (X17 pattern) into a shared `withOptimisticLock(permitId, expectedVersion, mutator)` helper.
- [ ] **SIM-H-3 — Centralize RPC row → first-element shim** (6 duplicates).
- [ ] **SIM-H-5 — Replace `generateComplianceQueries` conditional chain** with a `Record<BuildingType, QueryTemplate[]>` lookup.
- [ ] **SIM-H-7 — Collapse 3 `sendXEmail` functions** into one with a `template` param.
- [ ] **SIM-H-8 — Extract `verifyAndConsumeCode`** shared by `verifyEmailAction` and `resetPasswordAction`.

#### Part E — Unused deps removal 🟢

- [ ] Remove `@paper-design/shaders` from package.json (only `@paper-design/shaders-react` is imported).
- [ ] Remove `@types/bcryptjs` (bcryptjs v3 ships its own .d.ts).
- [ ] Document false-positive depcheck findings in a comment block.

**v1.8.0 totals:** ~400 LOC removed (net negative). ~20 new tests for the consolidated helpers.

---

## v1.9.0 — "Medium Wave"

**Tagline:** *Sweep the remaining ~30 Medium findings that didn't fit thematically into v1.0-v1.8.*

**Closes:** ~30 Medium across all reports (security 8, database 11, refactor 15 not yet covered, simplify 12, etc. — minus those already absorbed)

This is intentionally a "kitchen sink" release. Pick items in any order; one PR per logical group of 3-5 items.

- [ ] Database Mediums: `GRANT ALL TO authenticated` columnar restrictions, role self-escalation prevention, unsafe INT cast, NULL guards on jsonb_array_elements, unbounded OFFSET in pagination, document_tree JSONB size cap, HNSW ef_construction increase, semantic_cache size cap (TTL cleanup job)
- [ ] Security Mediums: persisted prompt injection in cache (sanitize before cache), admin permit list limit param cap, password-change code rate limit
- [ ] Refactor Mediums: 11 remaining (`devInsecureCookiesEnabled` consolidation, `getSessionFromToken` unused export removal, `User` interface privacy, `snakeToCamel` deletion, 10 `Input` types unexported, etc.)
- [ ] Simplify Mediums: 12 (duplicate `mapRow`s, twin TTL caches, 5-copy analytics skeleton, executeRAGPipeline strategy router, 632-line `chat-interface.tsx` splitting, etc.)
- [ ] Click-path Mediums: 11 covered above in v1.2 Part E if not already done

**Verification:**
- [ ] After each PR: `npm run lint && npx tsc --noEmit && npm run test:coverage`
- [ ] Coverage doesn't regress
- [ ] No new findings introduced (re-run `npx knip` or audit subset)

**v1.9.0 totals:** ~300 LOC delta. ~25 new tests.

---

## v1.10.0 — "Low Polish + Defense Prep"

**Tagline:** *64 Low findings + final demo polish before defense.*

**Closes:** All 64 Low + final smoke

#### Part A — Low-severity papercuts 🟢

Single PR per group of 5-10. All purely cosmetic / consistency.

- [ ] `parseInt` radix arg in `lib/email.ts:26`
- [ ] `new Date().getUTCFullYear()` in cert number gen
- [ ] `rows as unknown as ChatSession[]` typed helper
- [ ] `MatchedChunk.id` → `string | bigint`
- [ ] Magic numbers → named constants (rrf_k=60, 3600, 60_000, etc.)
- [ ] Nested ternaries in `actions/admin-permits.ts:84-88`
- [ ] Regex compilation moved out of hot loop in `treeReasoner`
- [ ] Sequential `createSignedUrl` → `Promise.all` in `getPermitAttachments`
- [ ] (+ 56 more — see audits)

#### Part B — Demo data + defense-day smoke 🟡

- [ ] Reset Supabase dev DB to a known seeded state with: 3 documents ingested, 5 example permits across statuses, 1 admin + 3 user accounts
- [ ] Pre-warm semantic_cache with 10 expected demo queries
- [ ] Verify all 11 defense-day click paths work: login, register-verify, chat with citations, create permit, run compliance, admin approve, download certificate, profile change, admin block user, admin add document, admin review queue
- [ ] Backup the DB snapshot

#### Part C — Documentation pass 🟢

- [ ] Update `CLAUDE.md` with any architecture changes from v1.0-v1.9
- [ ] Update `README.md` env-var section with any new vars (`DEV_INSECURE_COOKIES`, etc.)
- [ ] Update `README.md` if any user-facing flows changed
- [ ] Generate a `CHANGES_SINCE_AUDIT.md` summarizing what shipped vs the audit findings

#### Part D — Final audit re-run 🟡

- [ ] Run the 10 audit agents again (use the exact prompt that produced this plan)
- [ ] Compare new TOP-10 vs the 2026-05-21 TOP-10 in `docs/audits/phase1-report.md`
- [ ] **Goal: zero Critical, ≤ 5 High remaining, all of those marked diploma-deferred**

**v1.10.0 totals:** ~200 LOC, ~10 tests, + demo polish. Defense-ready.

---

## Post-fix verification (run after every release before pushing)

For each release, run this checklist end-to-end:

```powershell
# 1. Lint + types + tests
npm run lint
npx tsc --noEmit
npx vitest run --pool forks --coverage

# 2. Build
npm run build

# 3. Regression sanity — manual smoke (5 min)
#    - Login as user, send chat, see citation render
#    - Create permit step 1→2→3 → submit
#    - Login as admin, approve permit, download cert
#    - Logout, try old JWT against /api/chat/stream → 401
#    - Block self via admin → next request 401 within 30s

# 4. Audit subset re-run (depends on release)
#    - v1.0: rerun security-reviewer + database-reviewer agents only
#    - v1.3: rerun architect agent
#    - v1.10: full 10-agent re-run

# 5. Coverage didn't regress
npm run test:coverage
# - lines >= previous release
# - branches >= previous release

# 6. Documentation refresh (REQUIRED — every release)
#    - CLAUDE.md  — bump any architecture / module / convention text touched by this release
#    - README.md  — bump any user-facing flow / env var / command / install / screenshot section

# 7. Commit
git add -A
git commit -m "release: vX.Y.0 — <release title>"

# 8. PAUSE — print summary and wait for explicit "yes" before pushing:
#      • Parts shipped (audit IDs closed)
#      • Re-audit findings opened + fixed
#      • Test count before → after
#      • Coverage % before → after
#      • Files staged
#      • Commit message
#    Only after the user says "yes":
git push origin main
```

**No tags.** Releases are tracked by commit message + plan.md burndown. Don't run `git tag` or `--follow-tags`.

**Regression gate:** if any of the 5 manual smoke steps fail OR coverage drops, do not push the release. Investigate and add a regression test for whatever broke.

**Docs gate:** if Step 6 wasn't updated (CLAUDE.md + README.md), do not push. Docs drifting is how CLAUDE.md ends up lying about the codebase six releases later.

**Diff scope gate:** if a release touches files outside the audit-IDs listed under its Closes, justify in the commit body or split into a separate release.

---

## Tracking burndown

Update after every release ships:

| Release | Commit | Critical closed | High closed | Medium closed | Low closed | Notes |
|--------:|--------|----------------:|------------:|--------------:|-----------:|-------|
| v1.0.0 | `028dc69` | 6 | 4 | 0 | 0 | Auth lockdown — pending push |
| v1.1.0 | `56d9b00` | 1 | 2 | 2 | 0 | JWT coherence — CP-C-1, AUTH-H1/H2, AUTH-M5, A-M-3, S-M logout; A-C-4 deferred (Edge isolate Redis is post-defense). Pending push. |
| v1.2.0 | `394cef6` | 5 | 10 | 3 | 0 | Click-path — A/B/C/D/E + re-audit Part F. 8 Medium items deferred to v1.9.0. Pending push. |
| v1.3.0 | — | 4 | 1 | 0 | 0 | Pipeline resilience |
| v1.4.0 | — | 10 (coverage) | 0 | 0 | 0 | Coverage foundation |
| v1.5.0 | — | 0 | 11 | 17 | 0 | Security + DB |
| v1.6.0 | — | 0 | 5 | 10 | 0 | TypeScript safety |
| v1.7.0 | — | 0 | 9 | 8 | 0 | Architecture |
| v1.8.0 | — | 0 | 12 | 16 | 0 | Refactor + simplify |
| v1.9.0 | — | 0 | 0 | 15 | 0 | Medium kitchen sink |
| v1.10.0 | — | 0 | 0 | 0 | 64 | Low + demo polish |
| **Total** | | **28** | **54** | **80** | **64** | **226 findings** |

Audit ID → release mapping lives inside each release's "Closes:" line. To find which release owns finding `X-Y-N`, grep this file for the ID.

---

## Open questions / blockers

(Add as discovered.)

- [ ] Does Supabase free tier support `pg_cron` for the `analytics_daily` refresh in v1.5? If not, fall back to a Vercel cron job.
- [ ] Is `@playwright/test` size acceptable for the diploma project? If too heavy, use simpler `node:test` for the smoke E2E layer.
- [ ] Does `gen types typescript` produce usable types for the Supabase row casts in v1.6 Part A? If types are too loose, fall back to Zod parses.

---

## How to claim a release

1. Read the section start-to-finish + the cited audit files
2. Work directly on `main` (or a release branch if you prefer; merge back fast)
3. Implement Parts in order, marking `[x]` as each lands — one commit per Part keeps git history clean
4. After all Parts in a release are `[x]`, run the **Post-fix verification block** end-to-end (lint → tsc → vitest → build → manual smoke → audit re-run → coverage check → **docs refresh** → commit → PAUSE for "yes" → push)
5. Update CLAUDE.md + README.md to match the new state — never let docs drift. No other doc files are mandatory.
6. Update the burndown table above with closed-count deltas
7. PAUSE: print a short release summary (Parts shipped, audit IDs closed, test count, coverage %, files staged, commit message) and wait for explicit "yes"
8. After "yes": `git push origin main` — push every release. NO tags.
