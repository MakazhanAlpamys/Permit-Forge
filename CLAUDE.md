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
```

Single test file: `npx vitest run test/auth.test.ts`
Pattern match: `npx vitest run -t "pattern"`

## Tech Stack

- **Frontend:** Next.js 15 (App Router), React 18, TypeScript, Tailwind CSS 4, shadcn/ui
- **AI:** Google Gemini 2.5 Flash via LangChain 0.3 (chat), gemini-embedding-001 via @google/genai SDK (embeddings, 768-dim vectors)
- **Database:** Supabase (PostgreSQL) with pgvector (HNSW) + pg_trgm extensions, 30+ RPC functions
- **Auth:** JWT (HS256, jose), bcrypt (12 rounds), CSRF tokens, HttpOnly cookies
- **Testing:** Vitest 4 (node environment), @testing-library/react, 11 test suites in `test/`
- **Email:** Resend API (optional, for permit notifications)
- **PDF Generation:** PDFKit (permit certificates)

## Architecture

### Routes

| Route | Access | Purpose |
|-------|--------|---------|
| `/` | User | Main dashboard — chat interface + sidebar with session history |
| `/login` | Public | Login page (redirects logged-in users by role) |
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

### Server Actions (`actions/`)

| Action | Purpose |
|--------|---------|
| `auth.ts` | login, logout with audit logging |
| `admin.ts` | User management: create, block/unblock, role updates |
| `admin-permits.ts` | Permit review and approval workflow |
| `permits.ts` | CRUD operations for permit applications |
| `permit-attachments.ts` | File upload/download for permit documents |
| `chat-history.ts` | Session CRUD, message loading |
| `ingest-pdf.ts` | PDF ingestion trigger with cache invalidation |
| `documents.ts` | Document registry CRUD: add, update, delete, restore + PDF upload to Supabase Storage |
| `analytics.ts` | Admin stats and analytics queries |
| `notifications.ts` | In-app + email notifications (Resend) |

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
        [6] CRAG Check (top score < 0.3 → "info not found", 0 API)
        [7] Heuristic Rerank (0 API, ~1ms, diversity-aware)
        [8] Parent Chunk Expansion (DB lookup, 0 API)
        → Context Building ([SOURCE N] formatted chunks)
        → LLM Generation (1 API call, streaming via SSE)
        → Chunk-Based Citations (0 API, from chunk metadata)
        → Cache Store (fire-and-forget)
```

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

The system is fully DB-driven — all documents come from `document_registry` table (no hardcoded fallback). Migration seeds 5 default documents which admin can delete. `lib/document-registry.ts` uses in-memory cache with 5-min TTL; sync functions (`getDocumentByIdSync`, `getAllDocumentsSync`) read from cache for hot paths, async functions refresh from DB. Keywords are auto-extracted from PDF text via TF-IDF during ingestion (`lib/keyword-extractor.ts`, 0 API calls) and stored in `document_registry.keywords`. Column `keywords_auto_generated` prevents overwriting admin's manual edits.

Admin panel "Documents" tab allows: register new documents, upload PDF files to Supabase Storage, edit metadata/keywords, ingest/re-ingest PDFs, clear chunks, deactivate/restore documents. Each document is identified by `document_name` in the database. RAG search operates across all active documents; citations include document attribution.

### Permit System

Permit lifecycle: `draft → submitted → under_review → approved/rejected/revision_requested`

- Multi-step form: project info → building details → compliance requirements
- AI compliance check (`lib/permit-compliance.ts`): queries RAG → feeds context to Gemini → returns structured JSON analysis
- File attachments: up to 10 files, 10MB each (PDF, PNG, JPG, DWG, DXF)
- PDF certificate generation (`lib/permit-certificate.ts`): PDFKit, certificate number format `PF-CERT-{YEAR}-{ID}`
- Status timeline tracking with admin review interface

### Key Modules

| Module | Purpose |
|--------|---------|
| `lib/chat-pipeline.ts` | RAG orchestration: cache → select → search → CRAG → rerank → expand |
| `lib/rag.ts` | Hybrid search with pre-computed embeddings, document filter, CRAG check, parent expansion |
| `lib/agents.ts` | Topic classifier, query type detector, tree reasoner (no more expander/reranker/verifier) |
| `lib/gemini.ts` | Gemini model configuration: `chatModel` (temp=0), `streamingModel`, `generateEmbedding()` with retry/quota handling |
| `lib/citation-parser.ts` | Chunk-based citations from DB metadata (0 API, 100% accurate) |
| `lib/semantic-cache.ts` | Semantic query caching via pgvector (cosine > 0.95, 1hr TTL) |
| `lib/document-selector.ts` | Keyword-based document scoring from DB profiles (0 API) |
| `lib/keyword-extractor.ts` | TF-IDF keyword extraction from PDF text during ingestion (0 API) |
| `lib/scope-detector.ts` | Regex detection of page/section references in queries (0 API) |
| `lib/heuristic-reranker.ts` | Deterministic reranking: hybrid*0.4 + keyword*0.3 + metadata*0.2 + position*0.1 |
| `lib/pdf-ingestion.ts` | PDF chunking, embedding generation, batch DB insert with resume support |
| `lib/pdf-parser.ts` | PDF.js-based text extraction with TOC/outline parsing |
| `lib/tree-cache.ts` | Two-tier cache: L1 in-memory (5-min TTL) + L2 Supabase |
| `lib/document-registry.ts` | Fully DB-driven document registry with in-memory cache (5-min TTL) |
| `lib/permit-compliance.ts` | RAG-powered compliance checking → structured JSON from Gemini |
| `lib/permit-certificate.ts` | PDF certificate generation via PDFKit |
| `lib/constants.ts` | All app constants: cookie names, rate limits, file upload limits, status configs |
| `lib/auth.ts` | JWT create/verify, bcrypt, CSRF, audit logging, session management |
| `lib/security.ts` | `requireAuth`/`requireAdmin` middleware guards for server actions |
| `lib/validations.ts` | Zod v4 schemas for all inputs (passwords, chat messages, citations, JWT payloads) |
| `lib/supabase-server.ts` | Two clients: `createServerClient()` (anon) and `createAdminClient()` (service_role, bypasses RLS) |
| `lib/logger.ts` | Centralized logging with `LOG_LEVEL` env var support |
| `lib/file-upload.ts` | File validation (size, extension, MIME), storage path generation |
| `lib/notifications.ts` | In-app + email (Resend API) notifications, failure-silent |

### Middleware (`middleware.ts`)

Edge Runtime auth — runs on every non-static request:
1. JWT verification (no DB call, jose library)
2. Block status check via Supabase REST API (5-min in-memory cache, fail-safe: allows if check fails)
3. Role-based redirects: admins → `/admin`, users → `/`, blocked → clear session + redirect
4. Injects `x-user-id` and `x-user-role` headers for downstream use
5. Security headers: `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Permissions-Policy` (camera/mic/geo disabled)

Matcher excludes: `api`, `_next/static`, `_next/image`, static assets (svg/png/jpg/gif/webp).

### Database

Schema in `supabase/migrations/000_full_setup.sql` (single merged migration — drops and recreates everything). All tables use Row-Level Security (RLS). Service role bypasses RLS.

**Key tables:**
- `dubai_code_chunks` — child chunks with VECTOR(768) embeddings + TSVECTOR (GIN index) for FTS, `parent_id` FK
- `parent_chunks` — larger chunks (2000 chars) for LLM context (no embeddings)
- `semantic_cache` — cached query embeddings + responses (HNSW index, TTL-based)
- `document_registry` — dynamic document metadata, keywords, categories, `storage_path` (Supabase Storage), soft-delete
- `document_trees` — hierarchical document structure (JSONB tree_data)
- `chat_sessions` / `chat_messages` — conversation history with citations (JSONB)
- `users` — accounts with role (admin/user), block status, blocked_reason
- `audit_logs` — 12 event types, tracks IP + user agent
- `rate_limits` — per-user per-endpoint request throttling
- `notifications` — in-app notification storage

**Key RPC functions:** `match_dubai_code` (vector search), `match_dubai_code_hybrid` (hybrid search with RRF), `match_dubai_code_hybrid_filtered` (filtered by page range), `search_dubai_code_keywords` (FTS), `search_semantic_cache`/`insert_semantic_cache` (cache operations), `get_parent_chunks` (parent expansion), `get_all_documents`/`upsert_document`/`delete_document` (document registry CRUD), `check_rate_limit`, `get_document_tree`/`save_document_tree`, `get_admin_stats`, `get_weekly_activity`.

**Indexes:** HNSW on embeddings (m=16, ef_construction=64), HNSW on cache embeddings, GIN on tsvector, B-tree on metadata fields. Materialized view `analytics_daily` for dashboard stats.

### Components Structure

- `components/ui/` — shadcn/ui primitives (button, card, input, dialog, badge, etc.)
- `components/chat/` — ChatInterface, MessageBubble, SourceCitation
- `components/dashboard/` — Header, Sidebar
- `components/permits/` — Multi-step form (3 steps), permit list/card/detail, compliance panel, file upload, status timeline
- `components/admin/` — User management, audit logs, document management (CRUD + ingestion), permit management, analytics charts (recharts)
- `components/notifications/` — NotificationBell

### Types

`types/index.ts` contains all shared TypeScript interfaces: MatchedChunk, RAGQuery, RAGResult, ChatMessage, Citation, EnhancedCitation, VerifiedAnswer, ChatSession, IngestionResult, TOCEntry, Permit types, Building types, ComplianceStatus, Notification types.

## Testing

11 test suites in `test/`: auth, validations, citation-parser, admin, agents, tree-reasoning, rag, chat-pipeline, api-chat-stream, permit-compliance, permits-actions.

Test setup (`test/setup.ts`) mocks:
- `@/lib/supabase-server` — both `createServerClient` and `createAdminClient` with chainable query builder
- `next/headers` — cookies and headers
- 11 environment variables pre-set

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

Optional:
- `RESEND_API_KEY` — For email notifications (permit status updates)
- `LOG_LEVEL` — Logging verbosity (`debug`/`info`/`warn`/`error`)
