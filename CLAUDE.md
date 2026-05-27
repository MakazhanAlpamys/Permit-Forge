# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**PermitForge** — AI-Powered Building Code Compliance Assistant. A full-stack Next.js 15 application with two major subsystems: (1) a hybrid RAG chat pipeline with Tree Reasoning for structure-aware document search across dynamically managed documents, and (2) a permit application system with AI-powered compliance checks and PDF certificate generation. Backend is Supabase (PostgreSQL + pgvector).

## Commands

```bash
npm run dev              # Dev server at http://localhost:3000
npm run build            # Production build
npm start                # Production server
npm test                 # Run all tests (watch mode)
npm run test:coverage    # v8 coverage report (HTML)
npm run test:ui          # Vitest UI dashboard
npm run lint             # ESLint check
npx tsc --noEmit         # Type check (run by CI; no script in package.json)
```

Single test file: `npx vitest run test/auth.test.ts`
Pattern match: `npx vitest run -t "pattern"`
On Windows: append `--pool forks` to `vitest run` for reliability.

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs `lint` → `tsc --noEmit` → `vitest run --coverage` → `next build` on push/PR to `main` with placeholder env vars.

## Tech Stack

- **Frontend:** Next.js 15 (App Router), React 18, TypeScript, Tailwind CSS 4, shadcn/ui, Framer Motion (splash screen animations). MessageBubble passes assistant markdown directly to ReactMarkdown (no DOMPurify — applying it before parsing mangles valid markdown). Server-side title sanitization in `actions/chat-history.ts` uses a small regex helper, not jsdom-based DOMPurify, because pulling jsdom into a Lambda crashed prod with `ERR_REQUIRE_ESM` (`@exodus/bytes` is ESM-only).
- **i18n:** `react-i18next` + `i18next` + `i18next-browser-languagedetector` (the detector is installed but **not wired into init** — see [Internationalization](#internationalization-i18n) for the hydration-safety reason). Three locales (EN/RU/KK), default EN, user preference persisted in `localStorage['pf-locale']`.
- **AI:** Google Gemini 2.5 Flash via LangChain 0.3 (chat), gemini-embedding-001 via @google/genai SDK (embeddings, 768-dim vectors)
- **Database:** Supabase (PostgreSQL) with pgvector (HNSW) + pg_trgm extensions, 30+ RPC functions
- **Auth:** JWT (HS256, jose), bcrypt (12 rounds), CSRF tokens, HttpOnly cookies
- **Testing:** Vitest 4 (node + jsdom), @testing-library/react, 73 test suites in `test/` (1202 tests, ~72.1% line / ~60.3% branch coverage as of v1.10.0)
- **Email:** Nodemailer + Gmail SMTP (optional, for verification emails, password reset, permit notifications)
- **PDF Generation:** PDFKit (permit certificates)

## Architecture

### Routes

| Route | Access | Purpose |
|-------|--------|---------|
| `/` | User | Main dashboard — chat interface + sidebar with session history |
| `/login` | Public | Login page with splash screen animation (redirects logged-in users by role) |
| `/register` | Public | Self-registration with email verification |
| `/verify-email` | Public | 6-digit code entry to verify email after registration |
| `/forgot-password` | Public | Multi-step password reset (email → code → new password) |
| `/profile` | User | Profile management — edit username/name, email-code-based password change |
| `/permits` | User | Permit application list |
| `/permits/new` | User | Multi-step permit creation (3 steps: project → building → compliance) |
| `/permits/[id]` | User | Permit detail view with status timeline and attachments |
| `/admin` | Admin | Admin dashboard — user management, analytics, PDF ingestion, permit review, audit logs |
| `POST /api/chat/stream` | Auth | SSE streaming chat endpoint → chat-pipeline |
| `GET /api/chat/export` | Auth | Chat session export to Markdown |
| `POST /api/ingest` | Admin | PDF ingestion endpoint → SSE progress events |
| `GET /api/permits/[id]/certificate` | Auth | PDF certificate generation for approved permits |
| `GET /api/health` | Public | Health check (env vars + DB connectivity) |

Admin users are redirected away from user pages (`/`, `/permits`). Non-admins are redirected away from `/admin`.

**Error boundaries (v1.6.0 TS-M-9):** `app/error.tsx` (global App-Router segment), `app/global-error.tsx` (catastrophic root-layout — renders its own `<html>` + `<body>` with inline styles), and per-segment `app/permits/error.tsx` / `app/admin/error.tsx` / `app/profile/error.tsx`. All log `[app/.../error.tsx] route segment crashed:` to `console.error` with `{ message, digest }`.

### Server Actions (`actions/`)

| Action | Purpose |
|--------|---------|
| `auth.ts` | login, logout, registration, email verification, forgot/reset password |
| `profile.ts` | User profile CRUD, email-code-based password change, admin password change (no email code) |
| `admin.ts` | User management: create, block/unblock, role updates |
| `admin-permits.ts` | Permit review and approval workflow |
| `permits.ts` | CRUD operations for permit applications |
| `permit-attachments.ts` | File upload/download for permit documents |
| `chat-history.ts` | Session CRUD, message loading |
| `ingest-pdf.ts` | PDF ingestion trigger with cache invalidation |
| `documents.ts` | Document registry CRUD: add, update, delete, restore + PDF upload to Supabase Storage |
| `analytics.ts` | Admin stats and analytics queries |
| `notifications.ts` | In-app + email notifications (Nodemailer SMTP) |

### RAG Pipeline (`lib/chat-pipeline.ts` → central orchestrator)

```
User Query
  → Topic Classification (regex + LLM fallback)
    ├─ OFF_TOPIC/GREETING → Short-circuit response
    └─ ON_TOPIC →
        [1] Generate Embedding (1 API call, reused for cache + search)
        [2] Semantic Cache Check (pgvector similarity > 0.95)
          ├─ HIT → return cached response + citations (0 more API)
          └─ MISS → continue
        [3] Document Selector (keyword scoring, 0 API, ~1ms)
        [4] Scope Detector (regex for page/section refs, 0 API)
        [5] Hybrid Search (reuses embedding from step 1)
          ├─ Scope-filtered search if page ranges detected
          ├─ Tree Reasoning path for structural queries
          └─ Standard hybrid search with document filter
        [6] CRAG Check (top score < CRAG_THRESHOLD → "info not found", 0 API)
        [7] Heuristic Rerank (0 API, ~1ms, diversity-aware)
        [8] Parent Chunk Expansion (DB lookup, 0 API)
        → Context Building ([SOURCE N] formatted chunks)
        → LLM Generation (1 API call, streaming via SSE)
        → Chunk-Based Citations (0 API, from chunk metadata)
        → Cache Store (fire-and-forget) — only when fullContent
          length ≥ MIN_CACHEABLE_RESPONSE_LENGTH (50) AND the
          client signal didn't abort mid-stream (v1.3.0 A-C-2).
```

**Pipeline reliability (v1.3.0 "Pipeline Resilience"):** `executeRAGPipeline`
wraps every run in `Promise.race` against `CHAT_PIPELINE_CONFIG.PIPELINE_TIMEOUT_MS`
(30 s) with a per-run `AbortController`. The signal is threaded into
`generateEmbedding`, whose retry-backoff loop uses `abortableDelay` so a
wedged per-minute rate limit doesn't hold the pipeline for 60 s after the
timeout already fired. The singleflight map is capped at `INFLIGHT_MAX = 100`;
past that, callers run independently rather than collapsing. The chat-stream
SSE route plumbs `request.signal` into LangChain's `stream({ signal })` so a
client tab close stops Gemini token consumption immediately.

**Pipeline tunables (v1.7.0 Part G / A-M-4):** all configuration lives in
[lib/chat-pipeline-config.ts](lib/chat-pipeline-config.ts) (re-exported from
`lib/chat-pipeline.ts` for backcompat). This includes the reranker weights
(`RERANK_WEIGHT_HYBRID/_KEYWORD/_METADATA/_POSITION`) and the
`CRAG_THRESHOLD` — previously hardcoded inside `lib/heuristic-reranker.ts`
and `lib/rag.ts`, now in one place so an operator can A/B test the
recall/precision trade-off without touching multiple modules. The extraction
also broke the import cycle between `chat-pipeline.ts` ↔ `rag.ts`
↔ `heuristic-reranker.ts`.

**API calls per scenario:**
| Scenario | Embedding | LLM | Total |
|---|---|---|---|
| Cache hit | 1 | 0 | 1 |
| Greeting (regex) | 0 | 0 | 0 |
| Off-topic (LLM) | 0 | 1 | 1 |
| Weak search (CRAG) | 1 | 0 | 1 |
| Full pipeline | 1 | 1 | 2 |
| Average (with cache) | ~0.8 | ~0.7 | ~1.5 |

Feature flags in `CHAT_PIPELINE_CONFIG` control cache, tree reasoning, and parent expansion.

### PDF Ingestion Pipeline (`lib/pdf-ingestion.ts`)

```
PDF Upload (admin) → Supabase Storage (bucket document-pdfs)
  → Download from Storage → PDF.js parsing + TOC extraction (lib/pdf-parser.ts)
  → Document tree building (deterministic, no LLM)
  → Save tree to document_trees table
  → Parent chunking: RecursiveCharacterTextSplitter (2000 chars) → parent_chunks table (no embeddings)
  → Child chunking: RecursiveCharacterTextSplitter (400 chars, 100 overlap)
  → Link child → parent by page overlap
  → FOR EACH CHILD: generateEmbedding() → Gemini embedding API (768-dim vector)
  → Batch insert to dubai_code_chunks (content + vector + metadata + parent_id)
```

The **only AI call** during ingestion is embedding generation on child chunks (gemini-embedding-001). Parent chunks don't get embeddings (saves API). Free tier limit: 1000 embedding requests/day. Pipeline has resume support (skips already-ingested chunks).

### Multi-Document Support

The system is fully DB-driven — all documents come from `document_registry` table (no hardcoded fallback). Migration seeds only a single inactive `unknown` stub (FK target for orphan chunks); real documents are added via the admin Documents tab. `lib/document-registry.ts` uses in-memory cache with 5-min TTL; sync functions (`getDocumentByIdSync`, `getAllDocumentsSync`) read from cache for hot paths, async functions refresh from DB. Keywords are auto-extracted from PDF text via TF-IDF during ingestion (`lib/keyword-extractor.ts`, 0 API calls) and stored in `document_registry.keywords`. Column `keywords_auto_generated` prevents overwriting admin's manual edits.

Admin panel "Documents" tab allows: register new documents, upload PDF files to Supabase Storage, edit metadata/keywords, ingest/re-ingest PDFs, clear chunks, deactivate/restore documents. Each document is identified by `document_name` in the database. RAG search operates across all active documents; citations include document attribution.

### Permit System

Permit lifecycle: `draft → submitted → under_review → approved/rejected/revision_requested`

- Multi-step form: project info → building details → compliance requirements
- AI compliance check (`lib/permit-compliance.ts`): queries RAG → feeds context to Gemini → returns structured JSON analysis
- File attachments: up to 10 files, 10MB each (PDF, PNG, JPG, DWG, DXF)
- PDF certificate generation (`lib/permit-certificate.ts`): PDFKit, certificate number format `PF-CERT-{YEAR}-{ID}`
- Status timeline tracking with admin review interface

### Internationalization (i18n)

Client-side `react-i18next` with three bundled JSON dictionaries (`lib/i18n/locales/{en,ru,kk}.json`). All client components use `useTranslation()` and `t('section.key')`; server actions / API routes are not translated (they're system-of-record).

**Hydration safety (React error #418 was a real prod bug):**
`lib/i18n/client.ts` pins `lng: DEFAULT_LOCALE` on init — no `LanguageDetector` at startup. SSR and the first client render are byte-identical. `components/i18n-provider.tsx` then runs a **post-mount `useEffect`** that reads `localStorage['pf-locale']` (falling back to `navigator.language`, then `'en'`) and calls `i18n.changeLanguage(...)` once hydration has committed. The follow-up re-render is invisible to React's hydration validator. Visitors with a saved non-EN locale see a brief flash of EN before the switch — accepted compromise for diploma scope.

**Adding a translation key:**
1. Add to `lib/i18n/locales/en.json` first (tests assert on EN).
2. Mirror in `ru.json` and `kk.json`. Keep the same key paths and interpolation tokens (`{{name}}`) so callers stay symmetric.
3. Use `t('section.key', { defaultValue: ... })` when adding keys mid-refactor so unmigrated builds don't blank out.

**Test setup ([test/setup.ts](test/setup.ts)) initializes i18next synchronously with the EN bundle** so component tests asserting on English copy (e.g. `getByText('Submit Application')`) see translated strings, not raw `t()` keys. Without this every component test would fail with raw key text.

**LanguageToggle ([components/language-toggle.tsx](components/language-toggle.tsx))** lives next to `ThemeToggle` in every header (dashboard, all auth pages, admin). Same `variant: 'icon' | 'text'` API. The `className` prop is forwarded to the inner `Button` (not the wrapper `div`) so callers can re-style the icon — `app/login/page.tsx` uses this to apply `bg-accent text-accent-foreground` over the animated DitheringBackground.

**Locale-aware formatting:** date/time helpers in `permit-card.tsx`, `permit-status-timeline.tsx`, `notification-bell.tsx`, `top-users-table.tsx`, `audit-logs.tsx` map the active locale to a BCP-47 tag (`en-US` / `ru-RU` / `kk-KZ`) and use `Intl.RelativeTimeFormat` / `Intl.DateTimeFormat`. **One exception:** `permit-card.tsx` hard-codes the terse `Xd ago` form for `locale === 'en'` because existing component tests assert on that pre-i18n format. RU/KK still go through `Intl.RelativeTimeFormat`.

### Key Modules

| Module | Purpose |
|--------|---------|
| `lib/chat-pipeline.ts` | RAG orchestration: cache → select → search → CRAG → rerank → expand |
| `lib/chat-pipeline-config.ts` | Tunables (timeouts, reranker weights, CRAG_THRESHOLD) extracted from chat-pipeline (v1.7.0 Part G / A-M-4) so rag + heuristic-reranker can read them without an import cycle. |
| `lib/rag.ts` | Hybrid search with pre-computed embeddings, document filter, CRAG check, parent expansion. Chunk metadata is Zod-validated at the boundary (v1.7.0 Part C / A-H-9): a malformed JSONB blob falls back to a minimal safe stub + `console.warn` instead of crashing the pipeline. |
| `lib/agents.ts` | Topic classifier, query type detector, tree reasoner (no more expander/reranker/verifier) |
| `lib/gemini.ts` | Gemini model configuration: `chatModel` (temp=0), `streamingModel`, `generateEmbedding()` with retry/quota handling. Model IDs sourced from `lib/llm-config` (v1.7.0 Part F / A-H-8). |
| `lib/llm-config.ts` | Single source of truth for Gemini model names + embedding dimensionality (v1.7.0 Part F / A-H-8). `GEMINI_MODEL_CHAT` / `GEMINI_MODEL_EMBED` overridable via env vars for A/B testing without code changes. |
| `lib/logger.ts` | Structured JSON logger (v1.7.0 Part E / A-H-7). Zero dependency: routes through `console.error/.warn/.info/.debug` so Vercel + log aggregators parse records as JSON. `logger.child({...})` for per-request bindings; `getRequestLogger()` async helper reads `x-request-id` from middleware-forwarded headers. Pino was deliberately NOT added (Edge Runtime + worker_threads compatibility). |
| `lib/citation-parser.ts` | Chunk-based citations from DB metadata (0 API, 100% accurate) |
| `lib/semantic-cache.ts` | Semantic query caching via pgvector (cosine > 0.95, 1hr TTL) |
| `lib/document-selector.ts` | Keyword-based document scoring from DB profiles (0 API) |
| `lib/keyword-extractor.ts` | TF-IDF keyword extraction from PDF text during ingestion (0 API) |
| `lib/scope-detector.ts` | Regex detection of page/section references in queries (0 API) |
| `lib/heuristic-reranker.ts` | Deterministic reranking: hybrid*0.4 + keyword*0.3 + metadata*0.2 + position*0.1 |
| `lib/pdf-ingestion.ts` | PDF chunking, embedding generation, batch DB insert with resume support |
| `lib/pdf-parser.ts` | PDF.js-based text extraction with TOC/outline parsing |
| `lib/tree-cache.ts` | Two-tier cache: L1 in-memory (5-min TTL, LRU-capped at `MAX_CACHED_DOCS = 50`) + L2 Supabase. v1.7.0 Part B / A-H-3 added the cap; A-L-2 prunes dead entries after each `getAllCachedDocumentTrees` SELECT. |
| `lib/document-registry.ts` | Fully DB-driven document registry with in-memory cache (5-min TTL). `getDocumentByIdSync` cold misses now `console.warn` once per id (v1.7.0 Part C / A-H-2) so the generic "Building Code" fallback label is observable in Vercel logs. |
| `lib/document-cache.ts` | `invalidateAllDocumentCaches(documentName?)` (v1.7.0 Part B) — single throat for registry + selector profile + tree cache invalidation. Called by every path that mutates documents (ingestion, register, deactivate, restore, PDF upload). |
| `lib/permit-compliance.ts` | RAG-powered compliance checking → structured JSON from Gemini |
| `lib/permit-certificate.ts` | PDF certificate generation via PDFKit |
| `lib/constants.ts` | All app constants: cookie names, rate limits, file upload limits, status configs. v1.10.0 Part A added `HYBRID_SEARCH_RRF_K = 60` (canonical default that keeps the JS callers in lockstep with the SQL `rrf_k INT DEFAULT 60`) and `PERMIT_ATTACHMENT_SIGNED_URL_TTL_SECONDS = 3600`. |
| `lib/auth.ts` | JWT create/verify, bcrypt, CSRF, audit logging, session management |
| `lib/security.ts` | `requireAuth`/`requireAdmin` middleware guards for server actions |
| `lib/validations.ts` | Zod v4 schemas for all inputs (passwords, chat messages, citations, JWT payloads) |
| `lib/supabase-server.ts` | Three clients: `createServerClient()` (anon), `createAdminClient()` (service_role, singleton), and `createUserContextClient(userId)` (anon key + a Supabase-compatible JWT minted with `SUPABASE_JWT_SECRET` so RLS `auth.uid()` engages). The user-context client is **opt-in via `ENABLE_USER_CONTEXT_RLS=1`** — when the flag is off, the function returns the admin singleton (pre-A2 behavior). When the flag is on AND `SUPABASE_JWT_SECRET` is missing, the function THROWS rather than silently falling back to service_role (v1.5.0 Part B / S-H-3 fail-fast). See `LOCAL_NOTES.md`. |
| `lib/file-upload.ts` | File validation (size, extension, MIME), storage path generation |
| `lib/email.ts` | Email sending via Nodemailer SMTP: verification, password reset, password change codes; `generateSixDigitCode()`. v1.8.0 Part D / SIM-H-7 collapsed the three sendXEmail bodies into a single `sendCodeEmail({to, code, template})` dispatcher driven by `EMAIL_CODE_TEMPLATES`; the three exports stay as thin wrappers for callsite stability. v1.9.0 Part D / SIM-M-11 moved `escapeHtml` out to `lib/html-escape.ts` (was duplicated here + in `lib/notifications.ts`). |
| `lib/html-escape.ts` | `escapeHtml(str)` — single source of truth for HTML entity escaping in email templates. v1.9.0 Part D / SIM-M-11 extracted from byte-identical copies in `lib/email.ts` + `lib/notifications.ts`. |
| `lib/transforms.ts` | Shared data transforms: permit DB row → TypeScript object. Exports `rowToPermit` / `rowsToPermits` boundary helpers (v1.6.0 TS-H-1) that throw on shape mismatch + `transformPermit` itself, plus `firstRpcRow<T extends object>(data)` (v1.8.0 Part D / SIM-H-3) that collapses Supabase's RPC-returns-either-array-or-scalar pattern in one place (6 adopters). `BuildingDetails` / `ComplianceRequirements` are now optional on the `PermitApplication` type (v1.6.0 TS-H-6 — was cast `{}`). |
| `lib/permit-versioning.ts` | `applyOptimisticUpdate({client, permitId, userId, expectedVersion, op, patch})` (v1.8.0 Part D / SIM-H-2) — shared optimistic-locking helper used by `updatePermitBuildingDetails` + `updatePermitComplianceRequirements`. When `expectedVersion` is a number it adds `.eq('version', expectedVersion)` AND bumps `version` to `expectedVersion + 1`; zero rows affected surfaces as `{ok:false, reason:'version_conflict'}` plus an `optimistic_lock_collision` logger event. `expectedVersion=undefined` is the system-write path (idempotent compliance-result clobber) that skips both the WHERE and the bump. |
| `lib/debug-log.ts` | `debugLog(...args)` no-op unless `DEBUG_PERMITFORGE=1`. Gates hot-path `console.log` in `chat-pipeline.ts`, `semantic-cache.ts`, `tree-cache.ts` (v1.6.0 TS-M-6). `lib/email.ts` deliberately uses raw `console.log` (low-volume audit signal). |
| `lib/http-headers.ts` | `contentDispositionAttachment(filename)` (v1.5.0 S-H-4) — RFC 5987 helper used by chat/export + certificate download routes. |
| `lib/user-facing-error.ts` | `userFacingError(err, fallback)` (v1.5.0 SECRET-M1/M3) — drops raw Postgres / driver detail before echoing to clients. Recognises a `UF:` sentinel prefix for caller-controlled pass-through. |
| `lib/notifications.ts` | In-app + email (Nodemailer SMTP) notifications, failure-silent. v1.9.0 Part D / SIM-M-9 collapsed the per-type switch (`getNotificationContent`) and the separate `statusColors` map into a single `NOTIFICATION_TEMPLATES: Record<NotificationType, {title, body, color}>` so the exhaustiveness checker catches missed types when a new notification kind is added. |
| `lib/permit-state-machine.ts` | Pure permit-status transition table (`canPerformOperation(status, op)` + `describeBlocked`). Single source of truth used by every server action that mutates a permit + the admin/user UIs that gate buttons. Client-safe (no DB imports). |
| `lib/block-status-cache.ts` | Edge-runtime in-memory cache for `users.blocked` + `token_version` lookups in `middleware.ts`. 30 s TTL (cut from 5 min in v1.1.0 Part C), fail-closed on Supabase REST errors. `invalidateBlockStatus(userId)` is best-effort cross-runtime — diploma scope acceptable; production needs Redis. |
| `lib/login-lockout.ts` | In-memory per-account lockout (5 failures → 15 min). Diploma wontfix: serverless multi-instance would need a DB-backed lockout. |
| `lib/code-verification.ts` | `verifyAndConsumeCode({email, code, kind})` (v1.8.0 Part D / SIM-H-8) — shared 6-digit code verification used by `verifyEmailAction` + `resetPasswordAction`. Includes `checkCodeAttempts` rate limit + `clearCodeAttempts` on success. |
| `lib/signed-cursor.ts` | HMAC-signed pagination cursors (`createCursor`/`verifyCursor`) backing chat-history pagination. Prevents cursor tampering when cursors travel through query strings. |
| `lib/paginate.ts` | `paginateByCursor` helper that wraps signed-cursor + Supabase `.range()` into a single typed call returning `{rows, nextCursor}`. |
| `lib/cookie-options.ts` | Cookie attribute builder. Reads `DEV_INSECURE_COOKIES=1` to drop `Secure` + relax `SameSite` for plain-HTTP localhost. Legacy `NEXT_PUBLIC_DEV_INSECURE_COOKIES` still honoured with a deprecation warning. |
| `lib/file-magic.ts` | Magic-byte sniffer for PDF/PNG/JPG/DWG/DXF uploads (defense-in-depth on top of extension + MIME check in `lib/file-upload.ts`). |
| `lib/api-security-headers.ts` | Per-route security header builder (`X-Content-Type-Options`, `Cache-Control: no-store` for SSE, etc.). Used by API routes that need stricter headers than the middleware default. |
| `lib/i18n/config.ts` | `SUPPORTED_LOCALES` (en/ru/kk), `DEFAULT_LOCALE`, `LOCALE_STORAGE_KEY = 'pf-locale'`, label / short-name maps, `isSupportedLocale()` type guard. |
| `lib/i18n/client.ts` | i18next init pinned to `DEFAULT_LOCALE` on both SSR and first client render — no `LanguageDetector` at startup (see [Internationalization](#internationalization-i18n) for the hydration-safety rationale). Bundles EN/RU/KK JSON synchronously. |
| `lib/i18n/locales/{en,ru,kk}.json` | Translation dictionaries. EN is the source of truth for tests; RU/KK must mirror its key paths. |

### Middleware (`middleware.ts`)

Edge Runtime auth — runs on every non-static request:
1. JWT verification (no DB call, jose library). JWT payload carries `tv` (token_version).
2. Block status + `token_version` check via Supabase REST API (5-min in-memory cache, invalidated by admin block / role / password-change actions). If `JWT.tv < users.token_version`, session is treated as revoked. See `LOCAL_NOTES.md` for error-path behavior.
3. Role-based redirects: admins → `/admin`, users → `/`, blocked → clear session + redirect
4. Generates a per-request CSP nonce, forwards it via `x-nonce` request header. `app/layout.tsx` reads `headers()` so Next.js auto-stamps the nonce on every framework-injected inline script.
5. Security headers: nonce-based CSP with `'strict-dynamic'` (no `'unsafe-inline'` in prod), `Strict-Transport-Security` (HSTS, prod only), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` (camera/mic/geo disabled). Applied to both app routes and `/api/*`.
6. **Request-id propagation (v1.7.0 Part E / A-H-7):** generates (or accepts inbound) `x-request-id`, forwards to downstream RSC + API routes via request header, and echoes it on the response. Server code calls `getRequestLogger()` from `lib/logger` to bind it to every log line so a slow user-visible action can be traced across cache miss → embedding → hybrid search → LLM stream.

Public paths (no auth required): `/login`, `/register`, `/verify-email`, `/forgot-password`.

Matcher excludes: `api`, `_next/static`, `_next/image`, static assets (svg/png/jpg/gif/webp).

### Database

Schema in `supabase/migrations/000_full_setup.sql` (single idempotent migration — drops and recreates everything, then runs the previously-incremental 001–023 follow-ups in order, all inlined into the same file so a fresh database needs only one script). Re-runnable: every block uses `CREATE OR REPLACE` / `DROP IF EXISTS` / `IF NOT EXISTS`. All tables use Row-Level Security with ownership policies (`user_id = (SELECT auth.uid())` for user-owned tables, parent-permit joins for status_history / attachments / certificates). Service role bypasses RLS — admin server actions keep unrestricted access. See `LOCAL_NOTES.md` (gitignored) for trust-boundary detail kept out of public docs.

**Key tables:**
- `dubai_code_chunks` — child chunks with VECTOR(768) embeddings + TSVECTOR (GIN index) for FTS, `parent_id` FK
- `parent_chunks` — larger chunks (2000 chars) for LLM context (no embeddings)
- `semantic_cache` — cached query embeddings + responses (HNSW index, TTL-based)
- `document_registry` — dynamic document metadata, keywords, categories, `storage_path` (Supabase Storage), soft-delete
- `document_trees` — hierarchical document structure (JSONB tree_data)
- `chat_sessions` / `chat_messages` — conversation history with citations (JSONB)
- `users` — accounts with role (admin/user), block status, blocked_reason, email verification (`email`, `email_verified`, `verification_code`, `code_expires_at`, `reset_code`, `reset_code_expires_at`)
- `audit_logs` — 12 event types, tracks IP + user agent
- `rate_limits` — per-user per-endpoint request throttling
- `notifications` — in-app notification storage

**Key RPC functions:** `match_dubai_code` (vector search), `match_dubai_code_hybrid` (hybrid search with RRF), `match_dubai_code_hybrid_filtered` (filtered by page range), `search_dubai_code_keywords` (FTS), `search_semantic_cache`/`insert_semantic_cache` (cache operations; `insert_semantic_cache` is an upsert keyed by `md5(query_text)` since v1.3.0 — see A-C-3), `get_parent_chunks` (parent expansion), `submit_permit_atomic`/`revise_permit_atomic`/`review_permit_atomic`/`start_review_permit_atomic` (permit status transitions — each does FOR UPDATE row lock + UPDATE + permit_status_history INSERT in one SECURITY DEFINER body; admin guards on review/start_review since v1.0.0/v1.3.0), `create_permit_atomic`, `delete_document_atomic`, `bump_user_token_version`, `get_all_documents`/`upsert_document`/`delete_document` (document registry CRUD), `check_rate_limit`, `get_document_tree`/`save_document_tree`, `get_admin_stats`, `get_weekly_activity`.

**Indexes:** HNSW on embeddings (m=16, ef_construction=64), HNSW on cache embeddings, GIN on tsvector, B-tree on metadata fields, **UNIQUE expression index `semantic_cache_query_hash_idx` on `md5(query_text)`** (v1.3.0 A-C-3 — backs the `insert_semantic_cache` upsert). Materialized view `analytics_daily` for dashboard stats.

### Components Structure

- `components/ui/` — shadcn/ui primitives (button, card, input, dialog, badge, etc.)
- `components/chat/` — ChatInterface, MessageBubble, SourceCitation
- `components/dashboard/` — Header, Sidebar
- `components/splash-screen.tsx` — "Diamond Forge" splash screen for `/login` (SVG stroke draw → fill → clip-path text reveal → seamless fade to login)
- `components/login/` — DitheringBackground (shader-based animated background)
- `components/permits/` — Multi-step form (3 steps), permit list/card/detail, compliance panel, file upload, status timeline
- `components/admin/` — UserManagement, CreateUserDialog, DocumentManagement, PdfIngestionTab, PermitManagement, AuditLogs, EnhancedStatsCards, Charts (message activity, document usage, permit status), TopUsersTable
- `components/notifications/` — NotificationBell
- `components/theme-provider.tsx` + `components/theme-toggle.tsx` — light/dark theme context (defaults to `dark`, persisted in `localStorage['theme']`). Mounted-guarded to avoid SSR/CSR theme mismatch.
- `components/i18n-provider.tsx` + `components/language-toggle.tsx` — i18next Provider + post-mount locale sync + dropdown switcher (EN/RU/KK). The toggle sits next to `ThemeToggle` in every header.

### Types

`types/index.ts` contains all shared TypeScript interfaces: MatchedChunk, RAGQuery, RAGResult, ChatMessage, Citation, EnhancedCitation, VerifiedAnswer, ChatSession, IngestionResult, TOCEntry, Permit types, Building types, ComplianceStatus, Notification types.

## Testing

73 test suites in `test/` (1202 tests, ~72.1% line / ~60.3% branch coverage as of v1.10.0). Run with `--pool forks` on Windows for reliability. v1.4.0 added route-level coverage for `app/api/ingest` (80.8% lines) and `app/api/admin/documents/upload` (95.2% lines), plus component coverage for permit-card / compliance-check-panel / message-bubble / source-citation / permit-management (66.7%). v1.7.0 added coverage for tree-cache LRU eviction + dead-entry pruning, rag.ts Zod metadata validation, document-registry cold-miss warn, document-cache helper, and lib/logger. v1.8.0 Part D added direct unit coverage for `lib/permit-versioning.ts` (`applyOptimisticUpdate`, 5 tests, 100% lines) and `firstRpcRow` in `lib/transforms.ts` (4 tests). v1.9.0 added pagination-guard tests (NaN/Infinity clamping), persisted-prompt-injection sanitizer tests (`javascript:`/`vbscript:`/`data:text/html` stripping), password-change rate-limit attempt-key tests, migration-grant invariants for the new column-level UPDATE on `users`, the `get_all_users_admin` OFFSET cap, the `save_document_tree` 4 MB cap, and HNSW `ef_construction=128`. Coverage config in `vitest.config.ts` includes `app/api/**/*.ts`; global Supabase mock in `test/setup.ts` exposes `upsert/in/order/limit/range/maybeSingle/storage`.

**Suites:** auth, auth-actions (login/register/verify/reset), profile-actions (profile CRUD, password change), validations, validations-new (10 schemas), citation-parser, admin, admin-actions (7 admin functions), admin-permits-actions (review workflow), agents, tree-reasoning, rag, chat-pipeline, api-chat-stream, api-routes (health, export, certificate), permit-compliance, permits-actions, permits-actions-extended (building details, compliance, revise), permit-attachments (file upload/delete), chat-history (session CRUD, search), documents-actions (registry CRUD + PDF upload), analytics-actions (5 stats endpoints), email (Nodemailer SMTP + code generation), notifications-actions (read/mark), lib-modules (security, file-upload, reranker, scope-detector).

Test setup (`test/setup.ts`) mocks:
- `@/lib/supabase-server` — both `createServerClient` and `createAdminClient` with chainable query builder
- `next/headers` — cookies and headers
- 6 environment variables pre-set
- **i18next synchronous init with the EN bundle** (no detector, `lng: 'en'`) so component tests asserting on English UI copy see translated strings instead of raw `t()` keys. If a test fails with raw keys like `permits.status.submitted` rendering, this init is missing or `useSuspense` got re-enabled.

Coverage targets: `lib/**/*.ts`, `actions/**/*.ts`, `components/**/*.tsx`.

## Configuration Notes

- `next.config.ts`: externalize `pdfjs-dist` and `canvas` for webpack; `serverExternalPackages` for Supabase + pdfjs Edge compatibility
- `vitest.config.ts`: node environment, `@/` path alias, v8 coverage
- Path alias `@/*` maps to project root (used consistently across all imports)
- Gemini chat models use `temperature: 0` and `maxRetries: 0` to save quota

## Environment Variables

Required in `.env.local`:
- `NEXT_PUBLIC_SUPABASE_URL` — Supabase project URL
- `SUPABASE_ANON_KEY` — Supabase anonymous key
- `SUPABASE_SERVICE_ROLE_KEY` — Supabase service role key (used by middleware for block checks + all server operations)
- `GEMINI_API_KEY` — Google Gemini API key
- `JWT_SECRET` — Min 32 chars (64+ for production)

Conditionally required:
- `SUPABASE_JWT_SECRET` — **required when `ENABLE_USER_CONTEXT_RLS=1`** (v1.5.0 Part B: `createUserContextClient` now THROWS at runtime if the flag is on but this secret is missing or empty). Must match the project's actual JWT secret in the Supabase dashboard, otherwise every query through this client returns RLS denials. When the flag is off (default), the secret is unused.

Optional:
- `SMTP_HOST` — SMTP server host (default: `smtp.gmail.com`)
- `SMTP_PORT` — SMTP port (default: `587`)
- `SMTP_USER` — Gmail address for sending emails
- `SMTP_PASS` — Gmail App Password (16 chars)
- `ENABLE_USER_CONTEXT_RLS` — set to `1` to route user-context reads through the anon key + minted JWT (engages RLS as defense-in-depth). Off by default: `createUserContextClient` returns the admin singleton.
- `DEV_INSECURE_COOKIES` — set to `1` in local dev to drop the `Secure` flag and relax `SameSite` so cookies survive plain-HTTP `localhost`. v1.5.0 Part D renamed from `NEXT_PUBLIC_DEV_INSECURE_COOKIES` (the `NEXT_PUBLIC_` prefix leaked the flag into the client bundle); legacy name still honored at runtime with a one-time deprecation warning.
- `LOG_LEVEL` — `debug | info | warn | error`. Filters `lib/logger` output. Defaults: `info` in production, `debug` in dev. (v1.7.0 Part E / A-H-7)
- `GEMINI_MODEL_CHAT` — override the default chat model (`gemini-2.5-flash`). Useful for A/B testing without a deploy. (v1.7.0 Part F / A-H-8)
- `GEMINI_MODEL_EMBED` — override the embedding model (`gemini-embedding-001`). NOTE: changing this requires re-ingesting all documents because the new vectors won't match existing rows in `dubai_code_chunks.embedding`. (v1.7.0 Part F / A-H-8)

## Debugging Production

`npx vercel logs permit-forge.vercel.app --limit 20 --json` is the fastest way to surface the real error behind a Server Components 500 (the browser only ever shows the `digest` hash). This is how the `ERR_REQUIRE_ESM` from `isomorphic-dompurify`/`@exodus/bytes` was found.

## Project Docs

- `README.md` — public-facing project description with architecture diagrams and quick-start guide.
- [`LOCAL_NOTES.md`](LOCAL_NOTES.md) — trust-boundary detail intentionally kept out of `README.md` (gitignored upstream; tracked locally for diploma scope).

Earlier working notes (`plan.md` roadmap, `docs/audits/*` phase reports, `docs/CHANGES_SINCE_AUDIT.md`, `docs/DEFENSE_DAY_CHECKLIST.md`) were dropped after defense prep. Release archaeology lives in git: `git log --grep "v1.X.0"` for release commits or `git log --grep "<audit-id>"` for individual findings.
