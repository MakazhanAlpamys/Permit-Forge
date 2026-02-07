# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Emirate Forge** — AI-Powered Dubai Building Code 2021 Compliance Assistant. A full-stack Next.js 15 application using a hybrid RAG (Retrieval-Augmented Generation) pipeline with Tree Reasoning for structure-aware document search. Backend is Supabase (PostgreSQL + pgvector).

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

## Tech Stack

- **Frontend:** Next.js 15 (App Router), React 18, TypeScript, Tailwind CSS 4, shadcn/ui
- **AI:** Google Gemini 2.5 Flash via LangChain 0.3, text-embedding-004 (768-dim vectors)
- **Database:** Supabase (PostgreSQL) with pgvector + pg_trgm extensions
- **Auth:** JWT (HS256, jose), bcrypt (12 rounds), CSRF tokens, HttpOnly cookies
- **Testing:** Vitest 4, @testing-library/react, jsdom

## Architecture

### RAG Pipeline (lib/chat-pipeline.ts → central orchestrator)

```
User Query
  → Topic Classification (regex patterns + LLM fallback)
    ├─ OFF_TOPIC/GREETING → Short-circuit response
    └─ ON_TOPIC →
        → Query Structure Classifier (regex-based, ~1ms, no LLM)
          ├─ Structural ("in chapter", "summarize section")
          │   → Tree Reasoning: deterministic keyword scoring on document hierarchy
          │     → Filtered search within matched page ranges
          │     → Falls back to standard if confidence < 60%
          └─ Standard
              → Query Expansion (LLM generates 3-5 variations)
              → Hybrid Search (vector 0.7 + keyword FTS 0.3, RRF fusion)
              → AI Re-ranking (threshold ≥ 40)
        → Context Building ([SOURCE N] formatted chunks)
        → LLM Generation (streaming via SSE)
        → Answer Verification (hallucination check)
        → Citation Parsing (9 regex patterns → DB lookup via match_citation RPC)
```

### Key Modules

| Module | Purpose |
|--------|---------|
| `lib/chat-pipeline.ts` | RAG orchestration + feature flags (CHAT_PIPELINE_CONFIG) |
| `lib/rag.ts` | Hybrid search, multi-query fusion, RRF ranking |
| `lib/agents.ts` | AI agents: classifier, expander, reranker, verifier, tree reasoner |
| `lib/citation-parser.ts` | 9 citation extraction patterns, confidence scoring (60% match + 40% verify) |
| `lib/pdf-ingestion.ts` | PDF parsing (PDF.js), smart chunking (800 chars, 150 overlap), embedding, tree building |
| `lib/tree-cache.ts` | Two-tier cache: L1 in-memory (5-min TTL) + L2 Supabase |
| `lib/auth.ts` | JWT create/verify, bcrypt hashing, CSRF generation |
| `lib/security.ts` | requireAuth/requireAdmin middleware guards |
| `lib/validations.ts` | Zod v4 schemas for all inputs (passwords, chat messages, citations) |
| `middleware.ts` | Edge auth (JWT verify without DB), block enforcement, security headers |

### Request Flow

- **Chat:** Client → `POST /api/chat/stream` (SSE) → chat-pipeline → streaming response with citations
- **PDF Ingestion:** Admin → `POST /api/ingest` (SSE) → pdf-ingestion → progress events
- **Mutations:** Server Actions in `actions/` (auth, admin, chat-history, ingest-pdf)
- **Auth:** Edge middleware verifies JWT on every request; blocked-user check cached 5 min

### Database

Schema defined in `supabase/migrations/001_complete_setup.sql`. Key tables:
- `dubai_code_chunks` — document chunks with VECTOR embeddings and TSVECTOR for FTS
- `document_trees` — hierarchical document structure (JSONB tree_data)
- `chat_sessions` / `chat_messages` — conversation history with citations (JSONB)
- `users` — accounts with role (admin/user) and block status
- `audit_logs` — 12 event types, tracks IP + user agent
- `rate_limits` — per-user per-endpoint request throttling

All tables use Row-Level Security (RLS). Service role bypasses RLS for server operations.

## Testing

Tests are in `test/` (7 suites, ~118 tests). Test setup (`test/setup.ts`) mocks Supabase client, Next.js cookies/headers, and LangChain models.

Run a single test file:
```bash
npx vitest run test/auth.test.ts
```

Run tests matching a pattern:
```bash
npx vitest run -t "pattern"
```

## Environment Variables

Required in `.env.local`:
- `NEXT_PUBLIC_SUPABASE_URL` — Supabase project URL
- `SUPABASE_ANON_KEY` — Supabase anonymous key
- `SUPABASE_SERVICE_ROLE_KEY` — Supabase service role key
- `GEMINI_API_KEY` — Google Gemini API key
- `JWT_SECRET` — Min 32 chars (64+ for production)
