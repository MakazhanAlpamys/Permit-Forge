# Phase 1 — TypeScript/JavaScript Review (2026-05-21)

## Summary

`tsc --noEmit` exits 0. ESLint exits 0. No CRITICAL issues found. The codebase follows strict TypeScript, uses Zod v4 throughout, and is generally well-structured. There are a cluster of HIGH-severity findings around unsafe casts in production code, unguarded abort-signal handling in the SSE stream, inconsistent date rendering, and missing error boundaries. Several MEDIUM findings relate to list-rendering keys, floating async calls, and production `console.log` usage.

---

## Critical

No critical security or correctness issues found.

---

## High

### TS-H-1: Unsafe `as unknown as` casts bypass type-checking on Supabase row data

- **Files:**
  - `actions/permits.ts:386`
  - `actions/permits.ts:441`
  - `actions/admin-permits.ts:48`
- **Issue:** Supabase query results are cast `(data || []) as unknown as PermitRow[]` and `data as unknown as PermitRow`. This double-cast completely bypasses structural type-checking. If a column is renamed or the DB schema diverges from `PermitRow`, the error is silent until runtime. The Supabase JS client returns `unknown`-typed query results; the correct fix is to use Supabase's generated types or a type-narrowing helper, not an escape hatch.
- **Impact:** Runtime crashes or data corruption if `PermitRow` fields diverge from the actual DB schema. TypeScript will not catch the mismatch.

### TS-H-2: `permit?.status as PermitStatus` casts a potentially `undefined` value to a non-nullable union

- **Files:**
  - `actions/permits.ts:135, 215, 548`
  - `actions/admin-permits.ts:213`
  - `actions/permit-attachments.ts:81`
  - `app/api/permits/[id]/certificate/route.ts:64`
- **Issue:** The query returns `permit?.status` which is `string | undefined` (from `?` optional chaining on a `.single()` result that may return null). Casting it `as PermitStatus` without a null guard passes `undefined` into `canPerformOperation`, which calls `ALLOWED_FROM[op].includes(status)`. When `status` is `undefined`, `Array.prototype.includes` returns `false`, so the operation is silently blocked rather than throwing — but the control flow reaches `describeBlocked(op, undefined)` which interpolates `undefined` into the error string, producing user-visible `"Cannot review a permit in status undefined"`.
- **Impact:** Confusing error messages and fragile control flow whenever the DB returns a null permit row for these status checks.

### TS-H-3: Non-null assertion `pipelineResult!.cachedResponse!` without preceding guard

- **File:** `app/api/chat/stream/route.ts:125`
- **Issue:** On line 119 the code checks `if (pipelineResult.fromCache && pipelineResult.cachedResponse)`, which guards `cachedResponse` being truthy. However, line 125 inside the `ReadableStream` constructor re-asserts `pipelineResult!.cachedResponse!`. The `ReadableStream` `start` callback is synchronous and called immediately, so `pipelineResult` cannot have been reassigned to null in between. The `!` is harmless but masks the fact that `pipelineResult` is typed `PipelineResult | null` at the outer scope — the guard on line 119 does not narrow `pipelineResult` inside the nested closure. If the closure were ever made async or refactored, this would silently break. The `!` assertion on a nullable outer variable inside a nested function is a type-safety smell.
- **Impact:** Low in current code but fragile; a future refactor could make `pipelineResult` genuinely null inside the closure while TypeScript remains silent.

### TS-H-4: `as any` on a Supabase join column in production server action

- **File:** `actions/chat-history.ts:472`
- **Issue:** `const session = m.chat_sessions as any;` casts the joined `chat_sessions` column to `any` for the purpose of accessing `.title` and `.updated_at`. This is in a production query path (message search). The comment marks it with `eslint-disable-next-line @typescript-eslint/no-explicit-any` confirming awareness, but it completely disables type checking for the session object's field access.
- **Impact:** Any typo in `.title` or `.updated_at` field names or a DB schema change goes undetected by TypeScript. A typed inline interface would cost three lines.

### TS-H-5: SSE streaming in `/api/chat/stream` does not honour the request's `AbortSignal`

- **File:** `app/api/chat/stream/route.ts:207-251`
- **Issue:** The `ReadableStream` `start` callback calls `getStreamingModel().stream(langchainMessages)` and then iterates over chunks in a `for await` loop. `request.signal` is never passed to the streaming model call (contrast with `lib/permit-compliance.ts:210` where `signal` is forwarded). If a client disconnects mid-stream, the LangChain/Gemini call continues consuming quota and blocking the Node event-loop slot until the full response is generated. The ingest route (`app/api/ingest/route.ts`) correctly wires `requestSignal` through to the pipeline.
- **Impact:** Wasted Gemini API quota on every client disconnection; on a free tier this can exhaust daily limits quickly. In high-traffic scenarios it can exhaust server threads.

### TS-H-6: `transformPermit` returns `{} as BuildingDetails` and `{} as ComplianceRequirements` when DB columns are null

- **File:** `lib/transforms.ts:82-83`
- **Issue:** Lines `buildingDetails: row.building_details || ({} as BuildingDetails)` and `complianceRequirements: row.compliance_requirements || ({} as ComplianceRequirements)` cast empty objects to structured interfaces. Consumers that read `buildingDetails.numberOfFloors` will get `undefined`, but TypeScript types that field as `number | undefined` in `BuildingDetails`. In `lib/permit-compliance.ts:41` the code does `if (buildingDetails.buildingHeight)` — this is fine. But in `actions/permits.ts:641` the code does `if (!bd || !bd.numberOfFloors || !bd.totalBuiltUpArea)` — because `bd` is the empty `{}` cast, `!bd` is false, and the guard passes even though `numberOfFloors` is `undefined`, meaning `undefined.toString()` or arithmetic on `undefined` can appear in the compliance query strings.
- **Impact:** Silent degradation of compliance check queries when building details are incomplete; the empty-object cast allows semantically invalid data to pass type checks.

---

## Medium

### TS-M-1: `key={index}` (and `key={i}`) used on dynamic, mutable lists

- **Files:**
  - `components/permits/compliance-check-panel.tsx:63,101` — compliance `codeReferences` and `checks` arrays rendered with `key={i}`
  - `components/chat/source-citation.tsx:140,163` — table rows and list items with `key={i}`
  - `components/admin/permit-status-chart.tsx:77` — chart `<Cell>` with `key={index}`
- **Issue:** `key={i}` is acceptable for static lists that never reorder. However, `compliance-check-panel.tsx` renders AI-generated data where the order can change between renders (LLM may return categories in different order). React uses the key to reconcile DOM; an index key causes incorrect state retention when items reorder. The `ComplianceCheckItem.category` field is a stable string that would make a better key. For chart cells the order is stable, so this is lower priority there.
- **Impact:** Potential stale state in `CheckItem`'s `expanded` state after a re-run of compliance check that returns categories in a different order.

### TS-M-2: Floating async call without error handling in `useEffect` (CSRF fetch)

- **File:** `components/chat/chat-interface.tsx:165`
- **Issue:** `getCSRFTokenAction().then(token => { csrfTokenRef.current = token; })` — the promise returned from `getCSRFTokenAction()` is not chained with a `.catch()`. If the server action throws (e.g., because the cookie jar is unavailable at SSR edge), the rejection is unhandled in the browser and the CSRF ref stays `null`, silently preventing all subsequent chat messages.
- **Impact:** Silent failure of CSRF token initialisation with no user feedback; every subsequent message will fail with a 403 that the UI surfaces only after the first send attempt.

### TS-M-3: `loadSessionMessages` is a non-memoized `async` function called inside `useEffect` — potential stale closure / missing cleanup

- **File:** `components/chat/chat-interface.tsx:127-131`
- **Issue:** `loadSessionMessages` is declared as a `const` inside the component body without `useCallback`, then called inside a `useEffect` whose dependency array only contains `[sessionId]`. The function captures `setMessages`, `setHasMoreMessages`, `setMessageCursor` from the closure, which are stable refs, so this is unlikely to cause a real bug. However, if the component unmounts while the async call is in flight, `setMessages` would be called on an unmounted component — there is no cancellation token passed to `getSessionMessages` and `isMountedRef.current` is not checked inside `loadSessionMessages`. The existing `isMountedRef` pattern is used in the streaming path but not here.
- **Impact:** Possible React "setState on unmounted component" warning; low probability of real data corruption but sets a risky precedent.

### TS-M-4: `toLocaleString()` and `toLocaleDateString()` called without a locale argument

- **Files:**
  - `components/permits/compliance-check-panel.tsx:106` — `new Date(result.checkedAt).toLocaleString()`
  - `components/permits/permit-detail-view.tsx:129` — `new Date(permit.reviewedAt).toLocaleString()`
  - `components/dashboard/sidebar.tsx:69` — `date.toLocaleDateString()`
- **Issue:** Calling `toLocaleString()` without a locale uses the runtime environment's locale, which differs between Node (SSR) and the browser, causing a React hydration mismatch. Dates rendered server-side will differ from dates rendered client-side when the server and browser have different locales. The `formatTimestamp` in `message-bubble.tsx` correctly uses `Intl.DateTimeFormat('en-US', ...)` with an explicit locale — the permit components should follow the same pattern.
- **Impact:** React hydration warnings; inconsistent date display depending on server locale vs. user locale.

### TS-M-5: `JSON.parse` in `use-ingestion-stream.ts` without try/catch wrapper

- **File:** `hooks/use-ingestion-stream.ts:108`
- **Issue:** `const data = JSON.parse(line.slice(6))` is inside a `for` loop that processes SSE lines. There is an outer `try`/`catch` at line 140 for the loop body, but the catch block is empty (`} catch {`), silently swallowing parse errors. If the server emits a malformed SSE line, the error is caught and ignored, the progress update is lost, and the UI may stall in an indeterminate progress state.
- **Impact:** Silent failure of ingestion progress display; admin would see a spinner with no progress rather than an error message.

### TS-M-6: `console.log` calls left in production library code

- **Files:**
  - `lib/chat-pipeline.ts` — 4 occurrences (document selector, tree reasoning confidence logs)
  - `lib/semantic-cache.ts` — 1 occurrence (`Cache HIT (similarity: ...)`)
  - `lib/tree-cache.ts` — 5 occurrences
  - `lib/email.ts` — 6 occurrences
- **Issue:** These log internal pipeline state (document selector results, cache hit ratios, tree reasoning confidence scores) to stdout on every chat request. In production this populates server logs with high-volume, low-value noise and can expose internal system details in shared log aggregators. `console.error` and `console.warn` are appropriate; bare `console.log` is not.
- **Impact:** Log pollution in production; potential information disclosure in log aggregation services.

### TS-M-7: Empty `catch` blocks swallow errors silently in server actions

- **Files:**
  - `actions/chat-history.ts:54, 118, 191, 285, 341, 397, 491` — seven action functions catch all errors with `} catch {` and return generic messages without logging the underlying exception.
  - `actions/auth.ts:54` — `checkLoginRateLimit` catches all errors with `} catch { return true; }` — appropriate fail-open, but the error is not logged.
- **Issue:** The catch-all pattern in `chat-history.ts` returns user-facing messages like `'Failed to save message'` but logs nothing. When these fail in production there is no diagnostic trace. At minimum, `console.error('actionName error:', error)` should be present in each catch block.
- **Impact:** Undiagnosable production failures in chat history operations; debugging requires adding logging reactively.

### TS-M-8: `withMutation` uses `let parsed: T = undefined as T` — type-unsafe initializer

- **File:** `lib/security.ts:253`
- **Issue:** `let parsed: T = undefined as T` initializes a typed variable to `undefined` by force-casting. If `schema` is not provided in `options`, `parsed` stays `undefined` but the handler receives it as type `T`. The handler is typed `(ctx: { user: AuthenticatedUser; parsed: T })`, so a caller providing no schema but consuming `ctx.parsed` as a non-nullable `T` would get `undefined` at runtime without a TypeScript error.
- **Impact:** Potential runtime `undefined` dereference in handlers that assume `parsed` is populated regardless of whether a schema was passed.

### TS-M-9: No `error.tsx` boundaries in the App Router — async data fetching failures crash the entire tree

- **Files:** `app/` (no `error.tsx` found anywhere in the directory tree)
- **Issue:** Next.js App Router uses `error.tsx` files as React Error Boundaries for each route segment. Without them, any unhandled exception thrown during RSC rendering or `async` component execution propagates to the nearest parent boundary, which is the root `layout.tsx` — meaning a single DB query failure on `/permits/[id]` crashes the entire application shell. The `app/not-found.tsx` exists but no `error.tsx` counterparts do.
- **Impact:** A transient Supabase error or uncaught exception in any server component renders the entire page unusable instead of showing a scoped error UI.

### TS-M-10: `EXAMPLE_QUESTIONS` array rendered with `key={index}` in a stable static list

- **File:** `components/chat/chat-interface.tsx:613`
- **Issue:** `EXAMPLE_QUESTIONS.map((item, index) => <button key={index} ...>)` — this list is statically defined and never reorders, so the index key is harmless here. However it is inconsistent with the general guidance against index keys. The `item.question` string or `item.title` would be a more semantically correct key.
- **Impact:** No functional impact in current form; purely a consistency concern.

---

## Low

### TS-L-1: `parseInt(process.env.SMTP_PORT || '587')` without radix in `lib/email.ts`

- **File:** `lib/email.ts:26`
- **Issue:** `parseInt(process.env.SMTP_PORT || '587')` is missing the radix argument. ESLint's `radix` rule flags this; it works correctly for decimal strings (the only real use case for a port number) but is technically ambiguous for strings with leading zeros. The idiomatic fix is `parseInt(process.env.SMTP_PORT || '587', 10)` or `Number(process.env.SMTP_PORT) || 587`.
- **Impact:** No practical risk (port numbers are always decimal) but violates coding standards.

### TS-L-2: `generateCertificateNumber` uses `new Date().getFullYear()` — server timezone-dependent

- **File:** `lib/permit-certificate.ts:29`
- **Issue:** `const year = new Date().getFullYear()` returns the year in the server's local timezone. For a server deployed to UTC+0 this is fine, but for a server deployed to UTC-5 on New Year's Eve, a permit approved at 11 PM local time gets a certificate year of the old year while the client's browser shows the new year. Certificate numbers are permanent identifiers; the fix is `new Date().getUTCFullYear()`.
- **Impact:** Cosmetic inconsistency in certificate numbers near year-end; permanent since cert numbers are stored in the DB.

### TS-L-3: `rows as unknown as ChatSession[]` discards pagination-library type safety

- **File:** `actions/chat-history.ts:187`
- **Issue:** `paginateByCursor` returns `Array<Record<string, unknown>>` and the result is cast `rows as unknown as ChatSession[]`. The `ChatSession` interface has four fields (`id`, `title`, `created_at`, `updated_at`), all of which the query selects. A typed helper function or a Zod parse of the rows would be safer than the double-cast.
- **Impact:** Silent type drift if `ChatSession` interface diverges from the selected columns.

### TS-L-4: `snakeToCamel<T>` in `lib/transforms.ts` relies on caller type assertion with no runtime validation

- **File:** `lib/transforms.ts:32`
- **Issue:** The function `snakeToCamel<T>(row)` returns `out as T` where `T` is whatever the caller specifies. It provides no runtime guarantee that the keys on the output object actually match `T`. The docstring says "the caller asserts the row's keys line up via the generic" — that is a type assertion, not type safety.
- **Impact:** Low — only used in analytics/audit contexts, not permit data. But it is a typed lie that can silently hide DB column mismatches.

### TS-L-5: Magic number for compliance LLM response size cap defined as a bare local constant

- **File:** `lib/permit-compliance.ts:21`
- **Issue:** `const MAX_LLM_JSON_BYTES = 64 * 1024` is defined as a module-local constant. It is referenced once and has no corresponding test. Moving it to `lib/constants.ts` alongside `MAX_CONTEXT_LENGTH` would make it discoverable and testable.
- **Impact:** No functional issue; purely a maintainability/discoverability concern.

---

## Diploma Exceptions (wontfix-diploma)

### WONTFIX-DIPLOMA-1: `Admin123!` password hash in migration SQL

- **File:** `supabase/migrations/000_full_setup.sql`
- **Issue:** The full setup migration seeds a default admin user with a well-known password hash for the credential `Admin123!`. This is intentional for the diploma demo environment (local Supabase instance seeded with test data). It is not a deployed credential. Marked wontfix-diploma per scope instructions.
