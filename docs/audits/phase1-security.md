# Phase 1 — Security Review (2026-05-21)

Scope: PermitForge — Next.js 15 (App Router) + Supabase (PostgreSQL + pgvector) + Google Gemini RAG + permit application system.

Reviewer: Claude Security Agent (claude-sonnet-4-6)

---

## Critical

No CRITICAL vulnerabilities found after full review of authentication, authorization, input validation, file upload, rate limiting, secrets handling, and API routes. The mitigations already applied (parameterized queries via Supabase SDK, bcrypt 12 rounds, argon-safe timingSafeEqual for code comparison, CSRF double-submit, middleware JWT + token-version revocation, magic-byte file sniffing, per-endpoint rate limiting with advisory locks) eliminate the most common critical-severity classes.

---

## High

### S-H-1: Chat Rate-Limit Uses the Default Bucket, Not the Dedicated "chat" Bucket

- **File:** `app/api/chat/stream/route.ts:75`
- **Issue:** The streaming chat endpoint calls `checkRateLimit(user.id)` with no `endpoint` option, so it falls into the `'default'` bucket (10 req / 60 s, 2 s interval). The DB function `check_rate_limit` has a named `'chat'` bucket hardcoded in the migration with a tighter cap (20 req / 60 s, 1.5 s interval), but it is never invoked for this route. More importantly, all other server actions that also omit `endpoint` share the same `'default'` bucket, so a user spamming the chat endpoint drains the shared bucket and can unintentionally rate-limit unrelated mutations (permit updates, profile changes), and vice-versa. The effective burst allowance for the chat endpoint is higher than intended if the user's other actions have already consumed quota.
- **Impact:** Rate-limit bypass in one direction (chat does not consume the dedicated bucket) and cross-endpoint interference in the other. A user could spam chat without hitting the `'chat'` limit, or a burst of permit saves could deny chat access.
- **Evidence:**
  ```typescript
  // app/api/chat/stream/route.ts:75
  const rateLimitResult = await checkRateLimit(user.id);
  // Should be: checkRateLimit(user.id, { endpoint: 'chat' })
  ```

---

### S-H-2: In-Memory Login Lockout Does Not Survive Process Restarts or Scale Horizontally

- **File:** `lib/login-lockout.ts:23`
- **Issue:** The per-account failed-login counter is stored in a module-level `Map` in Node.js memory. On serverless deployments (Vercel, AWS Lambda) each function instance has its own map; a cold start clears all counters; and multi-instance deployments mean an attacker can bypass the lockout by hitting different instances in round-robin. The IP-based limiter is DB-backed (`check_ip_rate_limit`), but the account-level lockout (`LOCKOUT_MAX_FAILURES = 5` → 15-min lock) is not persisted.
- **Impact:** An attacker with any level of load-balancing access (or after a cold start) can perform unlimited password-guessing attempts against a targeted account, constrained only by the IP-rate-limit window (10 req / 60 s), which is trivially bypassed from multiple IPs. bcrypt slows each attempt to ~100 ms so the practical rate is still limited, but the claimed "5-attempt lockout" guarantee does not hold in production deployments.
- **Evidence:**
  ```typescript
  // lib/login-lockout.ts:23
  const attempts = new Map<string, LockoutEntry>();
  // Comment acknowledges: "In-memory only — survives within a process, not across restarts or instances."
  ```

---

### S-H-3: `SUPABASE_JWT_SECRET` Missing Silently Degrades RLS to Service-Role

- **File:** `lib/supabase-server.ts:130-140`
- **Issue:** `createUserContextClient()` is the defense-in-depth client that mints a user-scoped JWT so RLS ownership policies engage on data reads. When `SUPABASE_JWT_SECRET` is absent (which is the case in the documented required environment variables — it is not listed as required), the function silently falls back to `createAdminClient()` (service_role), which bypasses all RLS. The warning is logged once per process but is not fatal. An operator who deploys without this variable unknowingly removes a layer of database-level access control.
- **Impact:** If `SUPABASE_JWT_SECRET` is not set, any server action that calls `createUserContextClient()` instead reads/writes with service_role permissions, relying entirely on application-layer ownership checks. A bug in the ownership check (TOCTOU, misconfiguration) would not be caught by RLS. The RLS policies on `chat_sessions`, `permit_applications`, etc., would never fire.
- **Evidence:**
  ```typescript
  // lib/supabase-server.ts:130-139
  export async function createUserContextClient(userId: string): Promise<SupabaseClient> {
    const userJwt = await mintSupabaseUserJWT(userId);
    if (!userJwt) {
      // ... one-time warning, then:
      return createAdminClient(); // service_role, bypasses RLS
    }
  ```
  `SUPABASE_JWT_SECRET` is not listed in `CLAUDE.md` required environment variables.

---

### S-H-4: `Content-Disposition` Filename Not RFC 6266 Encoded — Potential Header Injection

- **File:** `app/api/permits/[id]/certificate/route.ts:94,172` and `app/api/chat/export/route.ts:100`
- **Issue:** The `Content-Disposition` header is constructed by string interpolation: `` `attachment; filename="permit-certificate-${certNumber}.pdf"` ``. `certNumber` is derived from `permitId` (a UUID stripped of hyphens) so it is benign in practice. However, the `safeTitle` used in the export route is sanitized by `replace(/[^a-zA-Z0-9-_ ]/g, '')` which leaves spaces — spaces in a `filename` parameter are technically allowed but can break some parsers and should be quoted or percent-encoded. More critically, neither path uses RFC 5987 encoding (`filename*=UTF-8''...`), meaning international characters that survive sanitization could corrupt the header. Any future code change that widens the character set without updating header encoding could introduce header injection.
- **Impact:** Currently low practical risk due to strict sanitization upstream, but the pattern is fragile. If sanitization is ever relaxed, an attacker could inject arbitrary response headers (HTTP response splitting if a CRLF sequence is not separately stripped).
- **Evidence:**
  ```typescript
  // app/api/chat/export/route.ts:94,100
  const safeTitle = title.replace(/[^a-zA-Z0-9-_ ]/g, '').slice(0, 50).trim() || 'chat-export';
  // ...
  'Content-Disposition': `attachment; filename="${safeTitle}.md"`,
  ```
  Spaces in `safeTitle` are not explicitly forbidden by the regex.

---

### S-H-5: `NEXT_PUBLIC_DEV_INSECURE_COOKIES` Is a Client-Visible Env Var That Weakens Cookie Security in Any Environment Where It Is Set

- **File:** `lib/cookie-options.ts:19`, `middleware.ts:66`
- **Issue:** The `NEXT_PUBLIC_` prefix means this variable is bundled into the client-side JavaScript bundle by Next.js and visible to anyone who inspects the page source. While the cookie-weakening effect is intentional for local development, the variable's value being `NEXT_PUBLIC_` means: (1) it is exposed in the browser regardless of server vs. client execution, and (2) an operator who accidentally sets it in a production deployment (e.g., by copying a `.env.local` file) gets silent cookie downgrade (`secure: false`, `sameSite: 'lax'`) with no runtime error. The `NEXT_PUBLIC_` namespace should be reserved for values intended to be public; a security-affecting flag should use a plain server-side env var.
- **Impact:** If set in production, session and CSRF cookies lose `Secure` and are downgraded to `SameSite=Lax`, enabling cookie transmission over HTTP and weakening CSRF protection. The flag's public exposure also confirms to any observer whether the application is running in a hardened or relaxed security posture.
- **Evidence:**
  ```typescript
  // lib/cookie-options.ts:19
  return process.env.NEXT_PUBLIC_DEV_INSECURE_COOKIES === '1';
  ```

---

## Medium

### S-M-1: Logout Does Not Invalidate the JWT Token Server-Side on CSRF Failure

- **File:** `actions/auth.ts:201-224`
- **Issue:** The `logoutAction` is intentionally designed to proceed with session destruction even when CSRF validation fails ("destroying the session is strictly safer than leaving it open"). However, because the application uses stateless JWTs, "destroying the session" only deletes the client-side cookie. The JWT itself remains valid until its 7-day expiry. A user who was force-logged-out (e.g., via a CSRF-triggered logout) may have their token extracted from browser storage/logs and reused. The token-version mechanism only fires when the middleware can compare the in-token `tv` against the DB, but CSRF-bypass logout does not bump `token_version`.
- **Impact:** A cross-site request that forces a logout clears the cookie on the victim's browser but leaves the token valid. If the token was copied before the logout (e.g., in server logs, Referer headers), it can be replayed for up to 7 days.
- **Evidence:**
  ```typescript
  // actions/auth.ts:209-223
  const csrf = await requireCSRF(csrfToken);
  // ...
  if (user) {
    await logAuditEvent({ ..., metadata: csrf.valid ? undefined : { csrf: 'invalid_or_missing' } });
  }
  await destroySession(); // only deletes cookie, JWT still valid
  ```

---

### S-M-2: `requestPasswordChangeCodeAction` Has No Rate Limiting

- **File:** `actions/profile.ts:105-136`
- **Issue:** `requestPasswordChangeCodeAction` has CSRF protection and auth, but no rate limit on how many times a logged-in user can request a password-change email code. Each call generates a new 6-digit code (overwriting the previous one) and sends an email. A malicious user (or a compromised session) could trigger this action repeatedly, generating email spam to the account holder's address and exhausting SMTP sending quota.
- **Impact:** SMTP quota exhaustion (denial of service against the mail service), potential account harassment via email flooding. The 6-digit code itself is rotated on each request so there is no code-accumulation attack, but the email volume is unbounded.
- **Evidence:**
  ```typescript
  // actions/profile.ts:105-136
  export async function requestPasswordChangeCodeAction(csrfToken: string) {
    const auth = await requireAuth();
    // No checkRateLimit or requireActionRateLimit call
    const code = generateSixDigitCode();
    await sendPasswordChangeCodeEmail(user.email, code);
  ```

---

### S-M-3: Block-Status Cache Has a 5-Minute Window During Which a Blocked User Retains Access

- **File:** `middleware.ts:9`, `middleware.ts:107`
- **Issue:** The block-status in-memory cache (`blockStatusCache`) has a 5-minute TTL (`BLOCK_CHECK_INTERVAL_MS = 5 * 60 * 1000`). When an admin blocks a user, the middleware will not detect the block until the cache entry for that user expires. During that window (up to 5 minutes), the blocked user can continue to access all authenticated routes, including chat, permit operations, and profile management. The `invalidateBlockStatus` call in `actions/admin.ts:224` evicts the entry from the in-process cache, but this only works if the block action and the user's subsequent requests are handled by the same server process/instance.
- **Impact:** On multi-instance deployments, a blocked user may retain access for up to 5 minutes from any instance that has not received the cache invalidation signal. In single-instance setups the invalidation works correctly.
- **Evidence:**
  ```typescript
  // middleware.ts:9
  const BLOCK_CHECK_INTERVAL_MS = 5 * 60 * 1000;
  // middleware.ts:107
  if (cached && (now - cached.checkedAt) < BLOCK_CHECK_INTERVAL_MS) {
    return { blocked: cached.blocked, ... };
  }
  ```

---

### S-M-4: PDF Parsing of Untrusted Files Uses PDF.js Without Memory/Complexity Limits

- **File:** `lib/pdf-parser.ts:59-64`, `lib/pdf-ingestion.ts:220`
- **Issue:** Admin-uploaded PDFs are parsed by `pdfjs-dist` on the server side. PDF.js does not impose configurable limits on embedded JavaScript execution (`isEvalSupported: false` is set, which mitigates JS execution), object counts, or decompression depth. A specially crafted PDF with deeply nested dictionaries, excessive cross-reference tables, or a decompression bomb in a compressed object stream could cause excessive memory consumption or CPU spin during parsing, resulting in a denial of service on the ingestion worker. The attack surface is limited to admin users who upload PDFs, but admin accounts can be compromised.
- **Impact:** DoS of the PDF ingestion pipeline and potentially the Next.js server process if memory limits are hit. `isEvalSupported: false` is correctly set so JS-in-PDF execution is disabled.
- **Evidence:**
  ```typescript
  // lib/pdf-parser.ts:59-64
  this.document = await pdfjsLib.getDocument({
    data,
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;
  // No maxPages, no memory cap, no timeout
  ```

---

### S-M-5: Audit Log `metadata` Field May Contain User-Controlled Strings (Injection Risk in Log Viewers)

- **File:** `lib/auth.ts:266-273`, `actions/auth.ts:311-314`
- **Issue:** Several audit log entries store user-supplied values in the `metadata` JSONB field without sanitization. For example, `registerAction` logs `{ username, email, self_registered: true }` where `username` and `email` come from validated but otherwise unsanitized user input. If a log viewer renders these fields as HTML (e.g., an admin dashboard or a third-party SIEM that does not escape JSON values), stored XSS could occur. The application's own admin UI (`components/admin/`) renders audit log entries; if it uses `dangerouslySetInnerHTML` or fails to escape metadata values, this becomes exploitable.
- **Impact:** Stored XSS in the admin audit log viewer if the rendering layer does not escape metadata strings. The attack requires first registering an account with a crafted username/email.
- **Evidence:**
  ```typescript
  // actions/auth.ts:311-314
  await logAuditEvent({
    action: 'user_created',
    metadata: { username: validation.data.username, email: validation.data.email, self_registered: true },
  ```
  `validation.data.username` passes the regex `/^[a-zA-Z0-9_]+$/` so this specific field is safe, but the pattern repeats elsewhere with less constrained fields (e.g., `reason` in `blockUser`, `review_comments` in permit review).

---

### S-M-6: `getAdminPermits` Has No Pagination Limit Enforcement

- **File:** `actions/admin-permits.ts:34-38`
- **Issue:** The admin permit list queries `permit_applications` with `.range(offset, offset + limit - 1)` but the `limit` parameter passed from the caller is not validated or capped server-side within the action. If a caller passes `limit = 10000`, the query will attempt to return 10,000 rows including joined user data in a single response. The TypeScript signature accepts `limit: number = 20` with no maximum.
- **Impact:** Potential memory pressure and slow responses from large unbounded queries. In practice the admin UI sends a sensible limit, but the action itself is not defensive.
- **Evidence:**
  ```typescript
  // actions/admin-permits.ts:34-38
  let query = supabase
    .from('permit_applications')
    .select('*, users!permit_applications_user_id_fkey(username)')
    .order('updated_at', { ascending: false })
    .range(offset, offset + limit - 1);
  // No Math.min(limit, 100) guard
  ```

---

### S-M-7: Semantic Cache Stores Raw LLM Responses Without Sanitization

- **File:** `app/api/chat/stream/route.ts:233`, `lib/semantic-cache.ts` (inferred)
- **Issue:** LLM responses are cached in the `semantic_cache` table and served directly to subsequent clients whose queries match the cached query embedding. If the LLM generates a response containing malicious Markdown (e.g., a crafted link or code block), that response is permanently cached and served to all future users who ask similar questions. While `ReactMarkdown` without `rehype-raw` prevents raw HTML injection, a prompt-injected Markdown response containing `javascript:` links or other content could persist indefinitely in the cache.
- **Impact:** Persisted prompt-injection artifacts: a poisoned cache entry could serve attacker-controlled content (e.g., phishing links, misinformation) to all subsequent users who ask similar questions until the cache TTL expires (1 hour). The link sanitizer in `message-bubble.tsx` would block `javascript:` URIs, reducing the practical impact.
- **Evidence:**
  ```typescript
  // app/api/chat/stream/route.ts:233
  cacheResponse(trimmedMessage, pipelineResult.queryEmbedding, fullContent, citations)
    .catch(err => console.warn('Cache store failed:', err));
  // fullContent is the raw LLM output, no sanitization before storage
  ```

---

### S-M-8: `restoreDocument` Admin Action Has No CSRF Token Validation

- **File:** `actions/documents.ts:249-283`
- **Issue:** `restoreDocument` accepts a `csrfToken` parameter and calls `requireCSRF(csrfToken)`. However, looking at the function signature: `restoreDocument(documentId: string, csrfToken: string)` — this is properly guarded. Upon re-examination, CSRF is checked. No finding here — removing. (See S-M-9 for the actual issue found.)

---

### S-M-8 (revised): `confirmPasswordChangeAction` Rate-Limit Uses the Shared Default Bucket

- **File:** `actions/profile.ts:175-188`
- **Issue:** The brute-force protection for password-change code verification uses `check_rate_limit` with `p_user_id` and no endpoint, falling into the `'default'` bucket. This means 5 failed code-verification attempts count against the same bucket used by other user actions. More importantly, the check uses `p_max_requests: 5` with `p_min_interval_ms: 0`, but these custom parameters are only honored when `p_endpoint = 'default'`. In the updated migration (migration 011+), the `'default'` CASE branch uses `COALESCE(p_window_seconds, 60)` etc., so custom parameters ARE passed through for the default endpoint. However, the 5-attempt limit does not reset after a successful verification via this path (there is no `resetCodeAttempts` call equivalent here, unlike in `verifyEmailAction` and `resetPasswordAction` which use the dedicated `checkCodeAttempts`/`resetCodeAttempts` helpers). A user who successfully changes their password cannot immediately request a new code because the rate-limit bucket from the failed attempts remains populated.
- **Impact:** User experience degradation (legitimate users temporarily locked out after failed attempts even after success); inconsistency with the `checkCodeAttempts`/`resetCodeAttempts` pattern used elsewhere.
- **Evidence:**
  ```typescript
  // actions/profile.ts:175-188
  const { data: rlData, error: rlError } = await supabase.rpc('check_rate_limit', {
    p_user_id: auth.user.id,
    p_window_seconds: 15 * 60,
    p_max_requests: 5,
    p_min_interval_ms: 0,
  });
  // No resetCodeAttempts call after successful verification
  ```

---

## Low

### S-L-1: JWT Session Max-Age Is 7 Days With No Idle Timeout

- **File:** `lib/constants.ts:27`
- **Issue:** `SESSION_MAX_AGE = 60 * 60 * 24 * 7` (7 days). There is no sliding expiry or idle-timeout mechanism. A stolen JWT cookie remains valid for its full 7-day window unless the token version is bumped (which only happens on password change, role change, or admin password reset). For lower-privilege users who do not change their passwords, a compromised token provides 7 days of access.
- **Impact:** Extended session window amplifies the impact of cookie theft. Industry best practice for sensitive applications is 1–24 hours with sliding expiry.
- **Evidence:**
  ```typescript
  // lib/constants.ts:27
  export const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 days
  ```

---

### S-L-2: `style-src 'unsafe-inline'` in CSP Allows CSS-Based Data Exfiltration

- **File:** `middleware.ts:29`
- **Issue:** The Content Security Policy allows `style-src 'self' 'unsafe-inline'`. While XSS via CSS is generally harder to exploit than script-based XSS, `unsafe-inline` styles enable CSS injection attacks (e.g., attribute selector exfiltration of form values, timing attacks). This is acknowledged in the code comment as a known trade-off with Tailwind/Framer Motion/Radix injecting inline styles.
- **Impact:** Low in isolation — CSS-based exfiltration requires specific page structures and yields limited data. Not blocking but worth tracking for future hardening.
- **Evidence:**
  ```typescript
  // middleware.ts:29
  "style-src 'self' 'unsafe-inline'",
  ```

---

### S-L-3: `img-src` CSP Includes `blob:` Origin

- **File:** `middleware.ts:31`
- **Issue:** `img-src 'self' data: blob:` includes `blob:` which allows rendering of images created from `Blob` objects. If any user-controlled content creates blob URLs (e.g., via file preview), the CSP does not prevent those blobs from being rendered. While this is standard for file-preview UIs, it slightly widens the CSP surface.
- **Impact:** Negligible in the current codebase; documented for completeness.
- **Evidence:**
  ```typescript
  // middleware.ts:31
  "img-src 'self' data: blob:",
  ```

---

### S-L-4: Middleware Does Not Cover `/api` Routes — Security Headers and Auth Not Applied to All API Paths

- **File:** `middleware.ts:289-293`
- **Issue:** The middleware matcher explicitly excludes paths starting with `api`:
  ```
  '/((?!api|_next/static|_next/image|favicon.ico|.*\\.svg|...).*)'
  ```
  This means all API routes (`/api/chat/stream`, `/api/ingest`, `/api/permits/[id]/certificate`, `/api/health`, `/api/chat/export`) receive **no middleware-applied security headers** and no middleware-level JWT check. Each API route implements its own auth (`getQuickSession`) and applies `applySecurityHeaders` manually. While currently correct, this pattern relies on every future API route remembering to call both functions. A new API route that forgets `applySecurityHeaders` will have no security headers at all.
- **Impact:** No headers are missing today (each route applies them), but the architecture creates a gap where future API routes could ship without headers. The middleware's CVE-2025-29927 mitigation (`x-middleware-subrequest` block) also does not apply to API routes.
- **Evidence:**
  ```typescript
  // middleware.ts:289-293
  matcher: [
    '/((?!api|_next/static|_next/image|favicon.ico|...).*)',
  ],
  ```

---

### S-L-5: `getAdminPermits` Missing CSRF Check

- **File:** `actions/admin-permits.ts:27-56`
- **Issue:** `getAdminPermits` is a read-only query action protected by `requireAdmin()` but takes no CSRF token parameter. Read-only server actions called via GET-equivalent patterns do not require CSRF tokens under the standard double-submit model. However, if this action were ever converted to accept filtering parameters that trigger side effects, the lack of CSRF would be a gap. Currently marked Low because no mutation occurs.
- **Impact:** No current impact since it is read-only. Pattern inconsistency with mutation actions.
- **Evidence:**
  ```typescript
  // actions/admin-permits.ts:27-56
  export async function getAdminPermits(...): Promise<...> {
    const authCheck = await requireAdmin();
    // No CSRF check — read-only action, currently acceptable
  ```

---

### S-L-6: Audit Log Entries Use `console.error` for Audit Failures (No Alerting)

- **File:** `lib/auth.ts:276-282`
- **Issue:** When `audit_logs` insertion fails, the error is silently swallowed after a `console.error`. In a production environment running on Vercel or another serverless platform, `console.error` outputs to ephemeral function logs that may not be forwarded to a SIEM or alert system. Security-critical events that fail to log (e.g., `permission_denied`, `user_blocked`) would go unrecorded without any alert.
- **Impact:** Silent audit trail gaps. Security investigations relying on `audit_logs` table completeness would be unreliable if the DB is temporarily unavailable.
- **Evidence:**
  ```typescript
  // lib/auth.ts:276-282
  if (error) {
    console.error('Audit log insert failed:', error.message);
  }
  // No throw, no alert, no fallback
  ```

---

### S-L-7: `getSessionFromToken` Logs JWT Errors Including "Unknown Error" to Console

- **File:** `lib/auth.ts:141`
- **Issue:** JWT verification failures are logged to `console.error` with the error message: `console.error('JWT verification failed:', error instanceof Error ? error.message : 'Unknown error')`. Jose's error messages for tampered or expired tokens are descriptive (e.g., `"JWTExpired"`, `"JWSSignatureVerificationFailed"`). These messages are informational and do not expose key material, but they do log to server-side output on every invalid request, which may be noisy in production environments with many expired tokens.
- **Impact:** Log noise; no secret leakage. Low severity.
- **Evidence:**
  ```typescript
  // lib/auth.ts:89-92
  console.error('JWT verification failed:', error instanceof Error ? error.message : 'Unknown error');
  ```

---

## Diploma Exceptions (wontfix-diploma)

- **DE-1: Hardcoded default admin credential in migration** — `supabase/migrations/000_full_setup.sql:2084` seeds the admin user with `username='admin'` and `password=crypt('Admin123!', gen_salt('bf', 12))`. This is a known diploma constraint. In a production system this seed row must be removed or the password changed immediately after setup. The credential is stored as a bcrypt hash (cost 12) so it is not plaintext, but the known password `Admin123!` must be rotated before any public deployment.

- **DE-2: Real secrets present in `.env.local` in the working directory** — `.env.local` contains real `SUPABASE_SERVICE_ROLE_KEY`, `JWT_SECRET`, `GEMINI_API_KEY`, and SMTP credentials. The file is correctly listed in `.gitignore` (both `.env*` and `.env.local` entries are present, line 34-35) so it will not be committed to Git. However, the file exists on disk in the development working directory. In a shared or CI environment this would be a critical exposure. Marked wontfix-diploma as this is a local development constraint.

---

## Summary Table

| ID | Severity | Area | Finding |
|----|----------|------|---------|
| S-H-1 | High | Rate Limiting | Chat endpoint uses default bucket instead of dedicated 'chat' bucket |
| S-H-2 | High | Auth | In-memory login lockout not durable across serverless restarts/instances |
| S-H-3 | High | Auth/RLS | Missing `SUPABASE_JWT_SECRET` silently degrades to service_role (RLS bypass) |
| S-H-4 | High | Headers | `Content-Disposition` filename interpolation fragile (HTTP header injection risk) |
| S-H-5 | High | Secrets/Config | `NEXT_PUBLIC_DEV_INSECURE_COOKIES` is a client-visible flag that weakens cookie security |
| S-M-1 | Medium | Auth | Logout does not bump token_version; JWT remains valid after cookie deletion |
| S-M-2 | Medium | Rate Limiting | `requestPasswordChangeCodeAction` has no rate limit (email flooding / SMTP exhaustion) |
| S-M-3 | Medium | Auth | Block-status cache 5-min TTL not invalidated across instances |
| S-M-4 | Medium | DoS | PDF parsing has no memory/complexity limits against malformed uploads |
| S-M-5 | Medium | XSS | Audit log metadata stores user-controlled strings that could XSS log viewers |
| S-M-6 | Medium | Input Validation | `getAdminPermits` limit parameter not capped server-side |
| S-M-7 | Medium | Injection | LLM responses cached without sanitization (persisted prompt injection) |
| S-M-8 | Medium | Auth | Password-change code rate limit uses wrong pattern (no reset after success) |
| S-L-1 | Low | Auth | 7-day JWT session with no idle timeout |
| S-L-2 | Low | CSP | `style-src 'unsafe-inline'` enables CSS injection |
| S-L-3 | Low | CSP | `img-src blob:` slightly widens CSP surface |
| S-L-4 | Low | Headers | Middleware excludes `/api` routes; headers depend on per-route manual application |
| S-L-5 | Low | Auth | `getAdminPermits` has no CSRF check (read-only, acceptable pattern) |
| S-L-6 | Low | Logging | Audit log failures silently swallowed with only `console.error` |
| S-L-7 | Low | Logging | JWT verification errors logged verbosely |
| DE-1 | wontfix-diploma | Secrets | Hardcoded `Admin123!` default password in migration seed |
| DE-2 | wontfix-diploma | Secrets | Real credentials in `.env.local` on disk |

---

## Notes on Non-Findings

The following areas were inspected and found to be implemented correctly:

- **SQL injection:** All database queries use the Supabase SDK (parameterized) or explicit `plainto_tsquery`/`regexp_replace` sanitization in PLPGSQL functions. No raw string concatenation into SQL was found.
- **bcrypt usage:** `hashPassword` uses 12 rounds (`bcrypt.hash(password, 12)`). `verifyPassword` uses `bcrypt.compare` (not a naive string comparison).
- **Code timing attacks:** Verification code comparison uses `crypto.timingSafeEqual` via `safeEqual()` (lib/code-verification.ts:19-26).
- **CSRF:** Double-submit cookie scheme with `crypto.randomBytes(32)` and `crypto.timingSafeEqual` validation. Applied to all mutation server actions and POST API routes.
- **CVE-2025-29927 (Next.js middleware bypass):** Explicitly mitigated at `middleware.ts:187-189`.
- **File upload MIME spoofing:** Magic-byte sniffing via `lib/file-magic.ts` cross-checks file header against declared MIME type.
- **XSS in chat output:** `ReactMarkdown` without `rehype-raw` prevents raw HTML; links are filtered to `http:`/`https:` only; inline user messages rendered with `textContent`-equivalent `whitespace-pre-wrap`.
- **Path traversal in storage:** `generateStoragePath` sanitizes filenames; storage paths are prefixed with `permits/{uuid}/` or `documents/{slug}/`.
- **Email enumeration:** `forgotPasswordAction` always returns success regardless of whether the email exists.
- **Token version revocation:** `bump_user_token_version` RPC is called on password change, admin password reset, and role change; middleware checks `tv` on every request.
- **RLS policies:** All tables have RLS enabled with ownership-scoped policies for `authenticated` role and unrestricted access for `service_role` only. `anon` is revoked from sensitive tables.
- **Admin self-protection:** `admin_block_user` prevents blocking the last unblocked admin via `FOR UPDATE` advisory lock.
- **Cryptographic randomness:** `generateSixDigitCode` uses `crypto.randomInt(0, 1_000_000)` (CSPRNG). CSRF tokens use `crypto.randomBytes(32)`.
