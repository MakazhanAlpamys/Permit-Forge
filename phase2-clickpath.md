# PermitForge — Click-Path Audit (Phase 2)

Scope: Permit creation (3-step), Chat interface, Admin user management, Admin document management, Admin permit review, Notification bell. Each finding traced from button click → handler → server action → DB → state reconciliation. Many issues stem from cross-state coupling, missing revalidation, and partially-awaited async chains, not individual function bugs.

---

## CRITICAL findings (data loss / wrong final state)

### C1. Step 3 "Submit" double-submits compliance + can leave permit in inconsistent draft on partial failure
- File: `app/permits/new/page.tsx` `handleSubmit` (lines 135-161); `actions/permits.ts` `submitPermit` (lines 231-326)
- Chain: click Submit → `updatePermitComplianceRequirements` → `submitPermit` (two separate non-transactional server actions).
- Bug: If user double-clicks, both clicks may pass the gate. The button is disabled by `loading` state but `loading` is only set after the first `await` resolves. Between mount and React paint, two synchronous click events can both pass the `if (!loading)` check. There is no idempotency token or in-flight guard on the action itself.
- Severity: CRITICAL
- What works individually: each action returns `{success: true}`, both write to DB.
- What breaks in chain: A second submit racing with the first can hit the RPC after status flipped to `submitted` — `updatePermitComplianceRequirements` rejects (status check), `submitPermit` rejects too — but in the time-of-check-time-of-use gap between the two calls in handler #1, handler #2's `updatePermitComplianceRequirements` may overwrite compliance flags that the first submit already snapshotted. Compliance JSON state at submit time can differ from what was at "Submit" click.
- Suggested fix: Wrap both writes in a single server action behind an atomic SQL transaction, OR add `useTransition` / a ref-based `inFlight` flag. Disable button via ref, not state.

### C2. AI compliance check is not cancellable; navigating away mid-check causes silent state divergence
- File: `app/permits/new/page.tsx` `handleRunCheck` (lines 163-188); `actions/permits.ts` `runComplianceCheck` (lines 540-616)
- Chain: click "Run AI Check" → `updatePermitComplianceRequirements` → `runComplianceCheck` → `checkPermitCompliance` (RAG + Gemini, can take 10-30s) → DB persist `compliance_check_result`.
- Bug: No abort controller. If user clicks Back/closes tab during the LLM call, the server-side write still happens. UI will not see the result. Worse: user could close tab, re-open `/permits/[id]`, and see a check result they never confirmed visually. There is no `setCheckLoading(false)` cleanup on unmount — but more importantly no signal propagation.
- Severity: CRITICAL (privacy/UX surprise: stale/unexpected compliance result attached to permit silently)
- Fix direction: Pass an `AbortSignal` from client; have `runComplianceCheck` accept it and check before DB write, OR make the persist step optional and confirm on the client side before saving.

### C3. Permit submit notification failure is swallowed but status already committed
- File: `actions/permits.ts` `submitPermit` lines 306-316
- Bug: After updating status to `submitted`, the notification is wrapped in `try { ... } catch { /* notification failure should not break submit */ }`. Email/in-app failure means user sees a "submitted" permit but never gets confirmation. No retry queue. No audit log of the notification failure. The CLAUDE.md spec calls for in-app + email; if email transport drops, in-app still happens (or fails silently). On the admin-permits.ts review path same issue.
- Severity: CRITICAL for trust ("Did my permit go through?")
- Fix direction: Persist a notifications-pending row and let a background worker retry; or surface notification failure in the action result with a non-blocking warning the UI can show.

### C4. Document ingestion on a re-ingest leaves stale chunks if pipeline crashes mid-run
- File: `components/admin/document-management.tsx` `handleIngestDocument` (lines 301-378); `app/api/ingest/route.ts`
- Chain: click "Re-ingest" → POST `/api/ingest` (SSE) → `runIngestionPipeline` writes chunks incrementally without first clearing prior chunks.
- Bug: The UI offers a separate "Clear" button but the Re-ingest path does not implicitly clear. The pipeline (per CLAUDE.md) "Has resume support (skips already-ingested chunks)" — fine for completeness, but if the doc text changed (file replaced) the old chunks are orphans with stale page numbers and you get duplicate-by-content embeddings under the same `document_name`. There is no checksum gate / version key.
- Severity: CRITICAL for retrieval correctness (citations point to wrong page / page text mismatched)
- Fix direction: When re-ingesting after a PDF replace, transactionally clear prior chunks first or mark them by `pdf_hash` and only return latest version. Add a confirmation step "Replace existing N chunks?" to the re-ingest path when the storage path's modified-time changed.

### C5. Cancelling ingestion mid-stream leaves partial chunks committed
- File: `components/admin/document-management.tsx` `handleIngestDocument` (lines 301-378)
- Bug: Reader is consumed in a while loop; if user navigates away or closes the tab there is no `AbortController` on the fetch and the server keeps processing (the route handler does not check `request.signal`). Embedding generation continues to consume Gemini quota. The DB ends up with a partial chunk set with no "incomplete" marker.
- Severity: CRITICAL (cost + integrity)
- Fix direction: Pass `AbortController.signal` to fetch, listen for `request.signal.aborted` in the route, mark ingestion as `pending`/`completed` in `document_registry` and require explicit completion to flip the state.

---

## HIGH findings

### H1. Permit form: state lost on page navigation (Back-button or any reload)
- File: `app/permits/new/page.tsx` (entire component)
- Bug: All step state lives in `useState`. The "Back to Permits" button (line 200) router-pushes away with no warning even when step 1 has unsaved input. After step 1 succeeds the permit ID is held only in component state — refresh of the page during step 2/3 loses the `permitId` and the form silently restarts at step 1, but the DB has a dangling draft permit (visible on /permits page).
- Severity: HIGH
- Chain: step1 success → permit row created → reload → user thinks form is fresh → creates a second draft.
- Fix: Persist the in-progress permit ID + step in the URL (search params or `[id]` route), or load latest open draft on mount.

### H2. File upload only enabled after permit created — but no upload step in /new flow
- File: `app/permits/new/page.tsx`; `components/permits/file-upload-zone.tsx`
- Chain: New permit form has 3 steps, no attachment step. Files can only be uploaded from `/permits/[id]` after submit-or-save-draft.
- Bug: The CLAUDE.md spec says step 3 includes file uploads, but step 3 in code only handles compliance toggles. Users will submit permit without attachments because they were never asked. Need to navigate to detail page and upload before submitting.
- Severity: HIGH (workflow correctness)
- Fix direction: Add a 4th step or render `FileUploadZone` inside step 3 once `permitId` exists.

### H3. handleSubmit on submit page does NOT navigate user away after submit success
- File: `app/permits/new/page.tsx` line 156-160 vs `app/permits/[id]/page.tsx` line 76-87
- New page: redirects to `/permits/[id]` (correct).
- Detail page `handleSubmit`: re-loads permit only. Good.
- But: after submit on detail page, the action buttons (`isDraft &&`) immediately disappear (status flips to `submitted`) — that's OK. However the Compliance Check button is shown even if the user already ran a check; clicking again rebuilds the result. No rate-limit beyond the global one.
- Severity: HIGH (cost waste; quota burn)
- Fix: Disable AI Check button when result is fresh (within last hour) or until building details change.

### H4. Race in `saveMessageToSession` after stream ends — second send can fire before previous save commits
- File: `components/chat/chat-interface.tsx` lines 220-229, 348-357
- Chain: send → save user message (await) → fetch SSE → on stream end, save assistant message (await).
- Bug: Both saves are awaited in handleSendMessage but if the user types a new message and presses Enter while the assistant save is pending, `MIN_REQUEST_INTERVAL` rate limit prevents send (good) — BUT `isLoading`/`isStreaming` flags are reset BEFORE the assistant save completes (`finally` block at 376-382 runs after the assistant `setMessages` but the save promise itself is awaited inline at 350-356 inside the same try). So `isStreaming=false` happens after both saves. OK on the happy path, but if the assistant `saveMessageToSession` throws, the catch block fires AFTER setMessages already added the assistant locally — message exists in UI but not in DB. On reload it disappears.
- Severity: HIGH (data loss perception)
- Fix: If save fails, surface a small "save failed — resync" indicator and refetch on re-mount, or queue retries.

### H5. Switching session mid-stream may show old stream's content under new session
- File: `components/chat/chat-interface.tsx` lines 63-90
- Chain: assume sending message in session A → SSE in flight → user clicks session B in sidebar → `useEffect` fires with `sessionId=B` → `abortControllerRef.current?.abort()` is NOT in this branch when sessionId is non-null (the abort only happens in the `!sessionId` "New Chat" branch, lines 75-80).
- Bug: switching from one existing session directly to another existing session does NOT abort the in-flight stream. Stream continues, eventually appends an assistant message via `setMessages(prev => ...)` to whatever session is now mounted (B), and `saveMessageToSession({sessionId: activeSessionId})` saves it under A. UI shows phantom message under B that vanishes on reload.
- Severity: HIGH
- Fix: In the `if (sessionId)` branch, also call `abortControllerRef.current?.abort()` before loading new session messages.

### H6. CSRF token fetched once on mount; never refreshed if stale
- Files: many — `chat-interface.tsx`, `user-management.tsx`, `document-management.tsx`, `permit-management.tsx`, `notification-bell.tsx`, `file-upload-zone.tsx`, `app/permits/new/page.tsx`
- Bug: `getCSRFTokenAction()` runs in mount-only `useEffect`. CSRF cookies likely have a TTL. After long idle time, token expires → all subsequent actions return `{success: false, error: 'Invalid CSRF token'}` until manual refresh. The chat UI fails to refresh CSRF after a 401-type response.
- Severity: HIGH
- Fix: On `csrf invalid` error, refetch token and retry once, or schedule periodic refresh.

### H7. Admin block/unblock — middleware cache lag means user stays "logged in" up to 5 minutes after block
- Files: `actions/admin.ts` `blockUser`; `middleware.ts` lines 7-12, `BLOCK_CHECK_INTERVAL_MS`
- Bug: blocked user's existing session continues to function until their `blockStatusCache` entry expires (5 minutes). The admin click does not invalidate the cached entry. There's no per-user cache bust mechanism in middleware.
- Severity: HIGH (security)
- Fix: After successful block, invalidate any in-memory caches; or look up block status on every request for blocked roles; or push a server event (revoke) and version-cache.

### H8. Admin permit review — concurrent reviewers can both pass status check
- File: `actions/admin-permits.ts` `reviewPermit` lines 116-126
- Good: code uses `.in('status', ['submitted','under_review']).select('id')` — atomic conditional update with check on number of updated rows. This IS race-safe.
- Issue: but the audit log + notification + history insert run unconditionally after that update. If two admins fire simultaneously and only one passes, the loser still receives `'Permit status has changed'` error so no log/notification — that's fine. Verified safe for the reviewPermit case.
- However `setPermitUnderReview` lines 209-219 — same atomic pattern. Also OK.
- Status: Correctly handled — but this needs documentation. Mark as a verified strength rather than a bug.
- Severity: N/A (verified safe)

### H9. Document upsert without PDF can silently leave a "document with no PDF" in registry
- File: `components/admin/document-management.tsx` `handleSave` lines 204-272
- Chain: click Register → `upsertDocument` → if `pdfFile`, `uploadDocumentPDF`. If upload fails after metadata save, we keep the registry entry with `storage_path: null`.
- Bug: code attempts a sensible "metadata saved but upload failed — user can retry upload via edit" message (line 257), but the document card now shows a "No PDF" badge and the Ingest button is disabled. User has to remember to revisit and upload. No notification indicator.
- Severity: HIGH (silent half-state)
- Fix: roll back the metadata insert if upload fails (compensating delete), or persist an explicit `pending_upload` state and surface it as a sticky warning.

### H10. Notification bell — read-state optimistic update isn't reconciled if server rejects
- File: `components/notifications/notification-bell.tsx` lines 65-80
- Bug: handleMarkRead immediately decrements `unreadCount` and flips local state. If `markNotificationRead` rejects (network/CSRF/auth), there is no rollback, no error UI. Bell shows a count that doesn't match server.
- Severity: HIGH
- Fix: rollback on `result.success === false`.

---

## MEDIUM findings

### M1. Sidebar reloads chat sessions whenever currentSessionId changes — extra DB calls
- File: `components/dashboard/sidebar.tsx` lines 88-91
- Bug: Sidebar's `useEffect` depends on `currentSessionId`. Selecting a session in sidebar → sets `currentSessionId` in parent → reloads sessions list (no real change). Wasted server action call on every selection. After "New Chat", parent sets to null → list reloads even though nothing changed.
- Severity: MEDIUM (perf / cost)
- Fix: Use realtime/optimistic updates from chat handlers (notify on session create/delete) or load only on mount + after delete.

### M2. Permit Detail "Run AI Check" reuses stored compliance_check_result indefinitely
- File: `app/permits/[id]/page.tsx` lines 63-74; `components/permits/compliance-check-panel.tsx`
- Bug: Compliance result persists with the permit. User edits building details (only possible while draft) — the old compliance result still displays until user clicks "AI Check" again. No invalidation hook tied to building_details update. User may submit relying on stale check.
- Severity: MEDIUM
- Fix: Set `compliance_check_result = null` whenever `building_details` or `compliance_requirements` change.

### M3. PermitManagement filter pills: filter state local; loses state on tab change
- File: `components/admin/permit-management.tsx` lines 49-64
- Bug: `activeFilter` is component state. Clicking "Permits" tab → `useEffect` in admin page calls `loadPermits()` (no status). PermitManagement mount default state is `all`. So filter is always reset on tab switch — visually inconsistent if user expects retention.
- Severity: MEDIUM
- Fix: Promote filter state to URL search params or localStorage.

### M4. Chat Export button opens PDF in new tab without auth wait — race possible
- File: `components/chat/chat-interface.tsx` lines 491-503
- Chain: click Export → `window.open('/api/chat/export?sessionId=...')` — fire-and-forget popup. If session was just created internally and DB row hasn't propagated, export may 404.
- Severity: MEDIUM
- Fix: Add a short post-create delay or guard Export button until first message is saved.

### M5. UserManagement onRefresh after action — no debounce; rapid-fire calls
- File: `components/admin/user-management.tsx` `handleBlockConfirm`/`handleRoleConfirm`/`handleDeleteConfirm`
- Bug: `onRefresh()` fires `loadUsers()` from the parent (`app/admin/page.tsx` line 130-135). If a user toggles block/unblock/role rapidly across multiple users, multiple loadUsers run and last-one-wins races can briefly flicker stale rows.
- Severity: MEDIUM
- Fix: Add a request token / cancel previous fetch.

### M6. CreateUserDialog doesn't invalidate username cache on conflict
- File: `components/admin/create-user-dialog.tsx` `handleSubmit` lines 46-62
- Bug: if `result.error === "Username already exists"`, error shows but the form is not cleared — fine. But after success, `setFormData(...)` resets BEFORE `onSuccess()`/`onClose()`. Potentially safe; but if onSuccess takes time (loadUsers), the dialog content visibly flickers blank for a frame.
- Severity: LOW-MEDIUM
- Fix: close first, then clear, then refresh.

### M7. Admin password change toast hides itself in 1500ms — no manual close
- File: `app/admin/page.tsx` lines 183-187
- Bug: `setTimeout(() => { setProfileOpen(false); setProfileSuccess(false); }, 1500);` — if user closes manually before the timer, the cleanup still fires later and may briefly re-open or interfere.
- Severity: LOW-MEDIUM
- Fix: clear the timeout in close handler or use ref + cleanup on close.

### M8. Permit certificate API generates PDF even when prior cert exists — wasted work
- File: `app/api/permits/[id]/certificate/route.ts` lines 57-95
- Bug: `existingCert` is checked, but PDF is regenerated unconditionally; only the DB insert is skipped. Each download call invokes PDFKit again.
- Severity: MEDIUM (perf)
- Fix: Cache PDF in storage and stream from there, or use ETag/If-None-Match.

### M9. FileUploadZone — `handleUpload` inside drag-drop / click both fire if user clicks during drop
- File: `components/permits/file-upload-zone.tsx` lines 74-85
- Bug: while uploading, the dropzone div is still `cursor-pointer` and clickable (only the `<input>` itself is disabled via `disabled={uploading}`). Clicking the div triggers `inputRef.current?.click()` — input is disabled so no file dialog opens, but the drag-drop is NOT prevented. Drop while uploading → `setUploading(true)` is already true — so handleUpload runs, sets uploading=true again, awaits. The two uploads run in parallel and second may fail at file count check, but order/timing is non-deterministic.
- Severity: MEDIUM
- Fix: gate `onDrop` and `onClick` on `uploading` flag.

### M10. Permit list page has no live update when admin reviews permit while user is viewing
- File: `app/permits/page.tsx` (not read but obvious)
- Bug: User on `/permits` doesn't get a polling/SSE update; needs manual refresh to see status change. Notification bell DOES poll every 30s — but the list doesn't.
- Severity: MEDIUM (UX)
- Fix: Use the same 30s poll, or supabase realtime channel.

---

## LOW findings

### L1. Chat: cooldown is set in client memory only — closing/reopening tab bypasses MIN_REQUEST_INTERVAL
- File: `components/chat/chat-interface.tsx` lines 173-178
- Severity: LOW (server rate limit catches it)

### L2. Sidebar delete dialog cancel does NOT release sessionToDelete state — minor leak
- File: `components/dashboard/sidebar.tsx` lines 127-130
- The state IS cleared in cancelDelete — fine. False alarm. Skip.

### L3. PermitFormStep3 "Run AI Check" does not require building details to be set on client
- File: `components/permits/permit-form-step3.tsx` lines 109-124
- The server action enforces it, but the UX could short-circuit — minor.

### L4. NotificationBell polls every 30s with no jitter — synchronized polls when many tabs open
- File: `components/notifications/notification-bell.tsx` line 61
- Severity: LOW

### L5. Permit detail handleDownloadCertificate uses `setActionLoading(null)` without try-finally
- File: `app/permits/[id]/page.tsx` lines 112-135
- Lines 134 set `actionLoading=null` after blob creation. If exception thrown synchronously after blob, `setActionLoading(null)` IS reached because the catch sets it via `setError`. But if a thrown err propagates outside of try (e.g., DOM removeChild errors in some browsers when `body.removeChild(a)` runs after `revokeObjectURL`), the function exits without resetting loading. Edge case.
- Severity: LOW

### L6. Document Management — confirm() dialog blocks event loop and is not test-friendly
- Files: `components/admin/document-management.tsx` lines 274, 283, 380
- `window.confirm` for destructive ops. Inconsistent with Dialog-based confirms used elsewhere (UserManagement uses shadcn Dialog).
- Severity: LOW (UX inconsistency)

### L7. PermitManagement expanded permit row resets on `permits` array reference change
- File: `components/admin/permit-management.tsx` line 50, 159
- Bug: After approve/reject, `onRefresh()` reloads the whole list, the new permits array has new object refs but `expandedPermit` is by `permit.id` so it's preserved — fine. Verified safe.

### L8. revalidatePath / revalidateTag never used anywhere
- Grepped: no Next.js cache revalidation calls present.
- Bug: Pages rely on `'use client'` re-fetch via callbacks, which works but means there is no shared cache invalidation. If two tabs are open, second tab's stale data persists. With `'use client'` everywhere this is consistent — but admin permits page does not invalidate `/permits` so the user's permit page has no "permit was reviewed" signal except the notification.
- Severity: LOW (intentional pattern but worth noting)

---

## Verified-safe (no bug, but inspected)

- `reviewPermit` and `setPermitUnderReview` use atomic conditional UPDATE with row count check — race-safe across multiple admins.
- `submitPermit` re-checks status and uses `.eq('user_id', authCheck.user.id)` — owner-bound.
- `deletePermit` orders DB delete BEFORE storage delete (prevents orphan DB record pointing to deleted file).
- `uploadPermitAttachment` cleans up storage if DB insert fails.
- Certificate route handles concurrent insert with 23505 check.
- Self-block protection: `blockUser` rejects if `userId === authCheck.user.id`.
- Self-delete protection: `adminDeleteUser` rejects same.

---

## Recommendation priority (top 6)

1. **C2 — AI compliance check cancellability**: highest risk of phantom DB writes after navigation away.
2. **C5 — Ingestion abort**: cost and integrity risk — Gemini quota burn.
3. **H7 — Block-cache lag**: 5-min security window after admin blocks user.
4. **H5 — Cross-session SSE leak**: phantom messages saved under wrong session.
5. **C3 — Notification swallow**: trust issue around permit submission.
6. **H1 / H2 — Permit form workflow**: missing attachments step + state loss on reload.
