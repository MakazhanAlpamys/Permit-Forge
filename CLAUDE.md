# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Emirate Forge** — AI-Powered Dubai Building Code Compliance Assistant. A full-stack Next.js 15 application with two major subsystems: (1) a hybrid RAG chat pipeline with Tree Reasoning for structure-aware document search across 5 official Dubai Municipality documents, and (2) a permit application system with AI-powered compliance checks and PDF certificate generation. Backend is Supabase (PostgreSQL + pgvector).

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
- **Database:** Supabase (PostgreSQL) with pgvector (IVFFlat) + pg_trgm extensions, 26+ RPC functions
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
| `analytics.ts` | Admin stats and analytics queries |
| `notifications.ts` | In-app + email notifications (Resend) |

### RAG Pipeline (`lib/chat-pipeline.ts` → central orchestrator)

```
User Query
  → Topic Classification (regex + LLM fallback)
    ├─ OFF_TOPIC/GREETING → Short-circuit response
    └─ ON_TOPIC →
        → Query Structure Classifier (regex-based, ~1ms, no LLM)
          ├─ Structural ("in chapter", "summarize section")
          │   → Tree Reasoning: deterministic keyword scoring on document hierarchy
          │     → Filtered search within matched page ranges
          │     → Falls back to standard if confidence < 45%
          └─ Standard
              → Query Expansion (LLM generates 3-5 variations)
              → Hybrid Search (vector 0.7 + keyword FTS 0.3, RRF fusion)
              → AI Re-ranking (threshold ≥ 40)
        → Context Building ([SOURCE N] formatted chunks)
        → LLM Generation (streaming via SSE)
        → Answer Verification (hallucination check)
        → Citation Parsing (9 regex patterns → match_citation RPC → DB lookup)
```

Feature flags in `CHAT_PIPELINE_CONFIG` control each stage (query expansion, reranking, verification, tree reasoning). All can be toggled independently.

### PDF Ingestion Pipeline (`lib/pdf-ingestion.ts`)

```
PDF Upload (admin)
  → PDF.js parsing + TOC extraction (lib/pdf-parser.ts)
  → Document tree building (deterministic, no LLM)
  → Save tree to document_trees table
  → Text chunking: RecursiveCharacterTextSplitter (800 chars, 150 overlap)
  → FOR EACH CHUNK: generateEmbedding() → Gemini embedding API (768-dim vector)
  → Batch insert to dubai_code_chunks (content + vector + metadata)
```

The **only AI call** during ingestion is embedding generation (gemini-embedding-001). No LLM text generation occurs. Free tier limit: 1000 embedding requests/day. Pipeline has resume support (skips already-ingested chunks).

### Multi-Document Support

The system supports 5 documents registered in `lib/document-registry.ts`:
- Dubai Building Code 2021 (DBC)
- Code of Safety
- Al Sa'fat Green Building System (2023)
- Universal Design Code (UDC)
- Sewerage & Stormwater Design Guidelines (2025)

Each document is identified by `document_name` in the database. RAG search operates across all documents; citations include document attribution.

### Permit System

Permit lifecycle: `draft → submitted → under_review → approved/rejected/revision_requested`

- Multi-step form: project info → building details → compliance requirements
- AI compliance check (`lib/permit-compliance.ts`): queries RAG → feeds context to Gemini → returns structured JSON analysis
- File attachments: up to 10 files, 10MB each (PDF, PNG, JPG, DWG, DXF)
- PDF certificate generation (`lib/permit-certificate.ts`): PDFKit, certificate number format `EF-CERT-{YEAR}-{ID}`
- Status timeline tracking with admin review interface

### Key Modules

| Module | Purpose |
|--------|---------|
| `lib/chat-pipeline.ts` | RAG orchestration + feature flags (`CHAT_PIPELINE_CONFIG`) |
| `lib/rag.ts` | Hybrid search (vector + FTS), multi-query fusion, RRF ranking |
| `lib/agents.ts` | AI agents: classifier, expander, reranker, verifier, tree reasoner |
| `lib/gemini.ts` | Gemini model configuration: `chatModel` (temp=0), `streamingModel`, `generateEmbedding()` with retry/quota handling |
| `lib/citation-parser.ts` | 9 citation extraction patterns, confidence scoring (60% match + 40% verify) |
| `lib/pdf-ingestion.ts` | PDF chunking, embedding generation, batch DB insert with resume support |
| `lib/pdf-parser.ts` | PDF.js-based text extraction with TOC/outline parsing |
| `lib/tree-cache.ts` | Two-tier cache: L1 in-memory (5-min TTL) + L2 Supabase |
| `lib/document-registry.ts` | Registry of 5 documents with metadata, path resolution, prompt helpers |
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
- `dubai_code_chunks` — document chunks with VECTOR(768) embeddings + TSVECTOR (GIN index) for FTS
- `document_trees` — hierarchical document structure (JSONB tree_data)
- `chat_sessions` / `chat_messages` — conversation history with citations (JSONB)
- `users` — accounts with role (admin/user), block status, blocked_reason
- `audit_logs` — 12 event types, tracks IP + user agent
- `rate_limits` — per-user per-endpoint request throttling
- `notifications` — in-app notification storage

**Key RPC functions:** `match_dubai_code` (vector search), `match_dubai_code_hybrid` (hybrid search with RRF), `match_dubai_code_hybrid_filtered` (filtered by page range), `search_dubai_code_keywords` (FTS), `match_citation` (citation verification), `check_rate_limit`, `get_document_tree`/`save_document_tree`, `get_admin_stats`, `get_weekly_activity`, `admin_block_user`, `admin_update_user_role`.

**Indexes:** IVFFlat on embedding (lists=100), GIN on tsvector, B-tree on metadata fields (startPage, endPage, section, contentType). Materialized view `analytics_daily` for dashboard stats.

### Components Structure

- `components/ui/` — shadcn/ui primitives (button, card, input, dialog, badge, etc.)
- `components/chat/` — ChatInterface, MessageBubble, SourceCitation
- `components/dashboard/` — Header, Sidebar
- `components/permits/` — Multi-step form (3 steps), permit list/card/detail, compliance panel, file upload, status timeline
- `components/admin/` — User management, audit logs, PDF ingestion, permit management, analytics charts (recharts)
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
