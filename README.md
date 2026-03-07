<div align="center">

<img src="https://img.shields.io/badge/🏗️-PermitForge-0D1117?style=for-the-badge&labelColor=0D1117" alt="logo" height="40" />

# PermitForge

### AI-Powered Building Code Compliance Assistant

<br />

[![Next.js](https://img.shields.io/badge/Next.js-15.5-black?style=flat-square&logo=next.js&logoColor=white)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Gemini](https://img.shields.io/badge/Gemini-2.5_Flash-4285F4?style=flat-square&logo=google&logoColor=white)](https://ai.google.dev/)
[![Supabase](https://img.shields.io/badge/Supabase-pgvector-3ECF8E?style=flat-square&logo=supabase&logoColor=white)](https://supabase.com/)
[![React](https://img.shields.io/badge/React-18.3-61DAFB?style=flat-square&logo=react&logoColor=black)](https://react.dev/)
[![Tailwind](https://img.shields.io/badge/Tailwind-4-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white)](https://tailwindcss.com/)
[![Zod](https://img.shields.io/badge/Zod-4-3E67B1?style=flat-square&logo=zod&logoColor=white)](https://zod.dev/)
[![Tests](https://img.shields.io/badge/Tests-156_passing-22c55e?style=flat-square)](./test)
[![License](https://img.shields.io/badge/License-MIT-eab308?style=flat-square)](./LICENSE)

<br />

[**Features**](#-features) · [**Quick Start**](#-quick-start) · [**Architecture**](#-architecture) · [**API**](#-api-reference) · [**Permits**](#-permit-system) · [**Testing**](#-testing) · [**Tech Stack**](#-tech-stack)

<br />

</div>

---

## Overview

**PermitForge** is an enterprise-grade AI assistant for building code compliance. It combines two major subsystems:

1. **Hybrid RAG Chat Pipeline (v2)** — optimized to **1-2 API calls per question** (~1.5 average with semantic caching). Uses vector + keyword hybrid search with RRF, deterministic Tree Reasoning, heuristic reranking, parent-child chunking, and chunk-based citations across **dynamically managed documents**.
2. **Permit Application System** — full lifecycle permit management with AI-powered compliance checks, multi-step forms, file attachments, admin review workflow, and PDF certificate generation.

> **Who is it for?** — Architects, engineers, construction professionals, and regulatory consultants working with building codes.

<br />

## Features

<table>
<tr>
<td width="50%">

### Streaming AI Chat
- **Gemini 2.5 Flash** via LangChain streaming
- Context-aware conversation memory (last 10 messages)
- Multilingual — English, Russian, Arabic
- Real-time token-by-token SSE responses
- Chat session management with history sidebar
- Chat export to Markdown

</td>
<td width="50%">

### Hybrid RAG Pipeline (v2)
- **1-2 API calls** per question (down from 3-9 in v1)
- **Semantic cache** — cosine similarity > 0.95, 1hr TTL, 30-40% hit rate
- **Vector similarity** (0.7) + **keyword FTS** (0.3) via RRF
- **CRAG check** — pre-generation quality gate (threshold 0.3)
- **Heuristic reranker** — deterministic scoring, 0 API, ~1ms
- **Parent-child chunking** — 400-char search precision, 2000-char LLM context
- **Document selector** — keyword-based routing to 1-3 documents (0 API)

</td>
</tr>
<tr>
<td>

### Tree Reasoning
- **Deterministic** keyword-scoring algorithm (no LLM call)
- Structure-aware search using document hierarchy & TOC
- Regex-based query classifier (~1 ms)
- Automatic fallback to standard RAG if confidence < 45%
- Two-tier cache (in-memory L1 5-min TTL + Supabase L2)

</td>
<td>

### Chunk-Based Citations (v2)
- Citations from **DB metadata** — 100% accurate, 0 API calls
- No LLM parsing needed — each chunk has exact page, section, document info
- Top 5-7 chunks after reranking become the sources
- Confidence scoring from search relevance scores
- Document attribution across all registered documents
- System prompt instructs LLM: "Sources are displayed separately"

</td>
</tr>
<tr>
<td>

### Permit Application System
- **6-status lifecycle:** draft → submitted → under_review → approved / rejected / revision_requested
- **3-step multi-step form:** project info → building details → compliance requirements
- **AI compliance check** — queries RAG → feeds context to Gemini → returns structured JSON analysis
- **File attachments** — up to 10 files, 10 MB each (PDF, PNG, JPG, DWG, DXF)
- **PDF certificate generation** — `PF-CERT-{YEAR}-{ID}` format via PDFKit
- **Status timeline** tracking with full admin review interface
- **Revision workflow** — admins can request revisions; users resubmit with incremented count
- **In-app + email notifications** via Resend API on every status change

</td>
<td>

### Enterprise Security
- **JWT** (HS256, 7-day expiry) with HttpOnly cookies
- **bcrypt** (12 rounds) password hashing
- **Timing-safe CSRF** token validation
- **Rate limiting** — in-memory (login) + database-backed (API, 10 req/min)
- **Zod v4** schema validation on all inputs
- **XSS protection** via isomorphic-dompurify
- **RLS** — PostgreSQL Row-Level Security on all 15 tables
- **Real-time block check** in Edge middleware (5-min cache)
- Security headers: `X-Frame-Options`, `X-Content-Type-Options`, `X-XSS-Protection`, `Referrer-Policy`, `Permissions-Policy`

</td>
</tr>
<tr>
<td>

### Admin Dashboard
- **5-tab panel:** Overview · Users · Permits · Documents · Audit Logs
- User CRUD with block/unblock & role management
- Permit review with approve / reject / request revision workflow
- **Dynamic document management** — register, edit, ingest, delete documents
- Real-time analytics: active users, total queries, permit stats
- Weekly activity charts, document usage, top users, permit status breakdown (Recharts)
- Full audit log history (12 event types tracked)
- Health check endpoint for monitoring

</td>
<td>

### PDF Ingestion & Dynamic Documents
- **PDF.js**-based parsing with TOC/bookmark extraction
- **Parent-child chunking** — child (400 chars) for search, parent (2000 chars) for LLM context
- Section hierarchy mapping & content type detection
- Automatic document tree generation for Tree Reasoning
- Batch embedding via `gemini-embedding-001` (768-dim, rate-limit-aware)
- Resume support — skips already-ingested chunks
- **Dynamic document registry** — add any PDF via admin panel
- Fully dynamic — admin can add/remove any documents
- **Auto-keyword extraction** from PDF text via TF-IDF during ingestion (0 API calls)
- Per-document stats, re-ingestion, deactivation/restore

</td>
</tr>
<tr>
<td>

### Notification System
- In-app notifications with unread badges
- Email notifications via Resend API (optional)
- 5 notification types: permit submitted, under review, approved, rejected, revision requested
- Branded HTML email templates with status indicators
- Silent failure handling — never breaks calling action

</td>
<td>

### Modern UI
- Dark / Light theme with system preference detection
- **shadcn/ui** + **Radix UI** component library
- Markdown rendering with formatted tables & lists
- Interactive citation badges with page links
- Responsive sidebar with chat history management
- Multi-step permit form with stepper navigation
- Real-time compliance check results panel

</td>
</tr>
</table>

<br />

---

## Quick Start

### Prerequisites

| Tool | Version | Link |
|------|---------|------|
| Node.js | >= 20.x | [nodejs.org](https://nodejs.org/) |
| npm | >= 10.x | Included with Node.js |
| Supabase Account | — | [supabase.com](https://supabase.com/) |
| Google AI API Key | — | [ai.google.dev](https://ai.google.dev/) |

### 1. Clone & Install

```bash
git clone https://github.com/MakazhanAlpamys/Permit-Forge.git
cd Permit-Forge
npm install
```

### 2. Configure Environment

Create `.env.local` in the project root:

```env
# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key

# Google Gemini
GEMINI_API_KEY=your_gemini_api_key

# JWT (min 32 chars, 64+ recommended)
JWT_SECRET=your_secure_random_jwt_secret

# Optional
RESEND_API_KEY=your_resend_api_key       # Email notifications for permit updates
LOG_LEVEL=info                           # debug | info | warn | error
```

> Never commit `.env.local` to version control.

### 3. Set Up Database

1. Create a project in [Supabase Dashboard](https://supabase.com/dashboard)
2. Open **SQL Editor** and run `supabase/migrations/000_full_setup.sql`

This single idempotent script drops and recreates the entire schema: **15 tables**, **29+ RPC functions**, HNSW vector indexes, GIN full-text search, and RLS policies. Seeds an admin user.

Default admin credentials: `admin` / `Admin123!`

### 4. Run

```bash
# Development
npm run dev

# Production
npm run build && npm start
```

Open [http://localhost:3000](http://localhost:3000)

### 5. First-Time Setup

1. **Login** at `/login` — `admin` / `Admin123!`
2. **Change the default password** immediately (Admin Panel → Users)
3. **Ingest PDFs** — Admin Panel → Documents → place PDFs in `public/` → click Ingest
4. **Create users** — Admin Panel → Users → Create User
5. **Start chatting** — return to dashboard and ask questions about building codes

<br />

---

## Architecture

### System Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                         FRONTEND                                 │
│         Next.js 15 App Router  ·  React 18  ·  Tailwind 4        │
│         Server Components  ·  Streaming UI  ·  shadcn/ui         │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼
┌──────────────────────────────────────────────────────────────────┐
│                   SERVER ACTIONS & API ROUTES                    │
│                                                                  │
│  actions/auth.ts ──────── Login · Logout · Audit Logging         │
│  actions/admin.ts ─────── User CRUD · Stats · Audit Logs         │
│  actions/admin-permits.ts  Permit Review · Approve · Reject      │
│  actions/permits.ts ────── CRUD · Submit · Compliance Check      │
│  actions/permit-attachments.ts  Upload · Download · Delete       │
│  actions/chat-history.ts ─ Sessions · Messages                   │
│  actions/documents.ts ──── Document Registry CRUD                │
│  actions/notifications.ts  Read · Mark Read                      │
│  actions/analytics.ts ──── Dashboard Stats · Charts              │
│  actions/ingest-pdf.ts ─── PDF Ingestion · Status                │
│                                                                  │
│  /api/chat/stream ── SSE streaming chat (main chat endpoint)     │
│  /api/chat/export ── Chat session export to Markdown             │
│  /api/ingest ─────── SSE PDF ingestion with progress             │
│  /api/permits/[id]/certificate ── PDF certificate generation     │
│  /api/health ─────── Health check (env + DB connectivity)        │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
          ┌──────────────────────┴──────────────────────┐
          ▼                                             ▼
┌───────────────────────────┐              ┌────────────────────────┐
│     CORE LIBRARY          │              │   EXTERNAL SERVICES    │
│                           │              │                        │
│  chat-pipeline.ts         │              │  Supabase              │
│  ├─ Semantic Cache        │◄────────────►│  ├─ PostgreSQL + RLS   │
│  ├─ Document Selector     │              │  ├─ pgvector (HNSW)    │
│  ├─ Scope Detector        │              │  ├─ Full-Text Search   │
│  ├─ CRAG Check            │              │  └─ Storage (files)    │
│  ├─ Heuristic Reranker    │              │                        │
│  └─ Parent Expansion      │◄────────────►│  Google Gemini         │
│                           │              │  ├─ 2.5 Flash (chat)   │
│  rag.ts                   │              │  └─ embedding-001      │
│  ├─ Hybrid Search (RRF)   │              │                        │
│  └─ Filtered Search       │              │  Resend (optional)     │
│                           │              │  └─ Email notifications │
│  agents.ts                │              │                        │
│  ├─ Topic Classifier      │              └────────────────────────┘
│  └─ Tree Reasoner (det.)  │
│                           │
│  semantic-cache.ts        │
│  document-selector.ts     │
│  scope-detector.ts        │
│  heuristic-reranker.ts    │
│  citation-parser.ts       │
│  document-registry.ts     │
│                           │
│  permit-compliance.ts     │
│  permit-certificate.ts    │
│  pdf-ingestion.ts         │
│  pdf-parser.ts            │
│  tree-cache.ts            │
│  auth.ts · security.ts    │
│  gemini.ts · validations  │
└───────────────────────────┘
```

### RAG Pipeline v2 Flow

```
User Query
    │
    ▼
┌──────────────────────┐
│  Topic Classifier    │ ──► Off-topic / Greeting → Short-circuit response (0 API)
└──────────────────────┘
    │ On-topic
    ▼
┌─────────────────────────────────────────────────────────────────┐
│  [1] GENERATE EMBEDDING (1 API call — reused for cache + search) │
└─────────────────────────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────┐
│  [2] Semantic Cache  │ ──► HIT → cached response + citations (0 more API, done)
│  cosine > 0.95, 1hr  │
└──────────────────────┘
    │ MISS
    ▼
┌──────────────────────┐      ┌──────────────────────────────┐
│  [3] Document Selector│      │  [4] Scope Detector          │
│  keyword scoring     │      │  regex: chapter/section/page  │
│  narrows to 1-3 docs │      │  adds page range filters     │
│  (0 API, ~1ms)       │      │  (0 API, ~1ms)               │
└──────────────────────┘      └──────────────────────────────┘
    │                                   │
    └──────────────┬────────────────────┘
                   ▼
┌──────────────────────────────────────────────────────────────┐
│  [5] SEARCH (reuses embedding from step 1)                    │
│                                                              │
│  ┌─────────────────────┐     ┌──────────────────────────┐    │
│  │  Tree Reasoning     │     │  Standard Hybrid Search  │    │
│  │  (structural query) │     │  (vector + keyword RRF)  │    │
│  │  keyword scoring    │     │                          │    │
│  │  → filtered search  │     │                          │    │
│  │  [conf < 45%] ──────────► │                          │    │
│  └─────────────────────┘     └──────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────┐
│  [6] CRAG Check      │ ──► top chunk score < 0.3 → "info not found" (0 API)
│  (0 API)             │
└──────────────────────┘
    │ passes
    ▼
┌──────────────────────┐
│  [7] Heuristic       │      score = hybrid*0.4 + keyword*0.3
│  Reranker            │              + metadata*0.2 + position*0.1
│  (0 API, ~1ms)       │      max 3/doc, max 2/page range
└──────────────────────┘
    │
    ▼
┌──────────────────────┐
│  [8] Parent Expansion│      child (400 chars) → parent (2000 chars)
│  (DB lookup, 0 API)  │      richer context for LLM
└──────────────────────┘
    │
    ▼
Context Building → LLM Generation (1 API call, streaming SSE)
    │
    ▼
Chunk-Based Citations (from DB metadata, 0 API) → Cache Store (fire-and-forget)
    │
    ▼
Response to User (tokens + citations)
```

**API calls per scenario:**

| Scenario | Embedding | LLM | Total |
|----------|:---------:|:---:|:-----:|
| Cache hit | 1 | 0 | **1** |
| Greeting (regex) | 0 | 0 | **0** |
| Greeting (LLM fallback) | 0 | 1 | **1** |
| Weak search (CRAG fails) | 1 | 0 | **1** |
| Full pipeline | 1 | 1 | **2** |
| **Average (with cache)** | ~0.8 | ~0.7 | **~1.5** |

### Permit Lifecycle

```
   User                                Admin
    │                                    │
    ├── /permits/new ───────────────►    │
    │   Step 1: Project Info             │
    │   Step 2: Building Details         │
    │   Step 3: Compliance Reqs          │
    │   [Run AI Compliance Check]        │
    │                                    │
    ├── Submit ─────────────────────►    │
    │   (draft → submitted)              ├── Review (submitted → under_review)
    │   [notification sent]              │   [notification sent]
    │                                    │
    │                                    ├── Approve (→ approved)
    │                                    │   [notification + certificate]
    │                                    │
    │                                    ├── Reject (→ rejected)
    │                                    │   [notification with reason]
    │                                    │
    │   ◄── Request Revision ───────────┤   (→ revision_requested)
    │       [notification with notes]    │
    │                                    │
    ├── Revise & Resubmit ─────────►    │
    │   (revision_count incremented)     │
    │                                    │
    └── Download Certificate ◄──────────┘   (if approved)
        GET /api/permits/[id]/certificate
```

### Database Schema

```
┌─────────────────────┐          ┌──────────────────────┐
│      users          │          │  dubai_code_chunks   │
│ ─────────────────── │          │ ──────────────────── │
│  id (UUID, PK)      │          │  id (BIGINT, PK)     │
│  username (UNIQUE)  │          │  content (TEXT)       │
│  email              │          │  metadata (JSONB)     │
│  password_hash      │          │  embedding (VECTOR)   │ ◄── HNSW index
│  full_name          │          │  fts (TSVECTOR)       │ ◄── GIN index
│  role (admin/user)  │          │  document_name        │
│  blocked (BOOL)     │          │  parent_id (FK)       │ ──► parent_chunks
│  blocked_reason     │          └──────────────────────┘
│  last_login         │
│  created_at         │          ┌──────────────────────┐
└──────────┬──────────┘          │  parent_chunks       │
           │ 1:N                 │ ──────────────────── │
           ▼                     │  id (BIGINT, PK)     │
┌─────────────────────┐          │  content (TEXT)       │ ◄── 2000 chars
│   chat_sessions     │          │  metadata (JSONB)     │
│ ─────────────────── │          │  document_name        │
│  id (UUID, PK)      │          └──────────────────────┘
│  user_id (FK)       │
│  title              │          ┌──────────────────────┐
│  created_at         │          │  semantic_cache      │
│  updated_at         │          │ ──────────────────── │
└──────────┬──────────┘          │  id (UUID, PK)       │
           │ 1:N                 │  query_text          │
           ▼                     │  query_embedding     │ ◄── HNSW index
┌─────────────────────┐          │  response (TEXT)     │
│   chat_messages     │          │  citations (JSONB)   │
│ ─────────────────── │          │  ttl_seconds         │
│  id (UUID, PK)      │          │  created_at          │
│  session_id (FK)    │          └──────────────────────┘
│  role               │
│  content (TEXT)     │          ┌──────────────────────┐
│  citations (JSONB)  │          │  document_registry   │
│  created_at         │          │ ──────────────────── │
└─────────────────────┘          │  id (TEXT, PK)       │
                                 │  display_name        │
┌─────────────────────┐          │  short_name          │
│  document_trees     │          │  file_name           │
│ ─────────────────── │          │  keywords (TEXT[])   │
│  id (UUID, PK)       │          │  categories (TEXT[]) │
│  document_name       │          │  badge_color         │
│  total_pages (INT)   │          │  is_active (BOOL)   │
│  tree_data (JSONB)   │          └──────────────────────┘
│  updated_at          │
└──────────────────────┘          ┌──────────────────────┐
                                 │  permit_applications │
┌─────────────────────┐          │ ──────────────────── │
│   audit_logs        │          │  id (UUID, PK)       │
│ ─────────────────── │          │  user_id (FK)        │
│  id (UUID, PK)      │          │  project_name        │
│  user_id (FK)       │          │  project_type        │
│  action (12 types)  │          │  building_details    │ ◄── JSONB
│  target_user_id(FK) │          │  compliance_reqs     │ ◄── JSONB
│  metadata (JSONB)   │          │  status (6 states)   │
│  ip_address         │          │  reviewed_by (FK)    │
│  user_agent         │          │  revision_count      │
│  created_at         │          └──────────┬───────────┘
└─────────────────────┘                     │ 1:N
                                 ┌──────────▼───────────┐
┌─────────────────────┐          │ permit_status_history │
│  permit_attachments │          │ ──────────────────── │
│ ─────────────────── │          │  id, permit_id (FK)  │
│  id (UUID, PK)      │          │  from_status         │
│  permit_id (FK)     │          │  to_status           │
│  file_name          │          │  changed_by (FK)     │
│  file_size          │          │  comment             │
│  storage_path       │          │  created_at          │
│  uploaded_by (FK)   │          └──────────────────────┘
└─────────────────────┘
                                 ┌──────────────────────┐
┌─────────────────────┐          │  permit_certificates │
│   notifications     │          │ ──────────────────── │
│ ─────────────────── │          │  id (UUID, PK)       │
│  id (UUID, PK)      │          │  permit_id (FK)      │
│  user_id (FK)       │          │  certificate_number  │ ◄── UNIQUE
│  type (5 types)     │          │  generated_by (FK)   │
│  title, body        │          │  generated_at        │
│  read (BOOL)        │          └──────────────────────┘
│  created_at         │
└─────────────────────┘          ┌──────────────────────┐
                                 │   rate_limits        │
                                 │ ─────────────────── │
                                 │  id (BIGINT, PK)    │
                                 │  user_id (FK)       │
                                 │  request_timestamp  │
                                 └──────────────────────┘
```

**15 tables** · 29+ RPC functions · Row-Level Security on all tables · HNSW vector indexes (m=16, ef_construction=64) · GIN full-text search · B-tree indexes on metadata fields

<br />

---

## API Reference

### API Routes

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/chat/stream` | User | SSE streaming chat — tokens + citations |
| `GET` | `/api/chat/export?sessionId=uuid` | User | Export chat session as Markdown file |
| `POST` | `/api/ingest` | Admin | PDF ingestion with SSE progress streaming |
| `GET` | `/api/permits/[id]/certificate` | User | Download approved permit PDF certificate |
| `GET` | `/api/health` | Public | Health check — env vars + DB connectivity |

### Streaming Chat — `POST /api/chat/stream`

```http
POST /api/chat/stream
Content-Type: application/json
Cookie: ef_token=<jwt>
X-CSRF-Token: <csrf_token>

{
  "message": "What are parking requirements for residential buildings?",
  "sessionId": "optional-uuid"
}
```

**Response** (`text/plain`, streamed):

```
According to Section 5.2 of the Building Code...

[tokens stream in real-time]

__CITATIONS__[{"chunkId":123,"page":45,"section":"5.2","documentName":"dubai-building-code-2021",...}]
```

### PDF Ingestion — `POST /api/ingest`

```http
POST /api/ingest
Content-Type: application/json
Cookie: ef_token=<admin-jwt>

{ "documentId": "dubai-building-code-2021" }
```

**Response** (`text/event-stream`):

```
data: {"stage":"parsing","progress":5,"total":100,"message":"Parsing PDF..."}
data: {"stage":"embedding","progress":50,"total":100,"message":"Generating embeddings...","chunksProcessed":250}
data: {"stage":"complete","progress":100,"total":100,"done":true,"chunksProcessed":1250}
```

### Server Actions

| Action | File | Description |
|--------|------|-------------|
| `loginAction()` | `actions/auth.ts` | Authenticate user, set JWT + CSRF cookies |
| `logoutAction()` | `actions/auth.ts` | Destroy session cookies, audit log |
| `createChatSession()` | `actions/chat-history.ts` | Create a new chat session |
| `getChatSessions()` | `actions/chat-history.ts` | List user's sessions |
| `getSessionMessages()` | `actions/chat-history.ts` | Fetch messages with citations |
| `deleteChatSession()` | `actions/chat-history.ts` | Delete with ownership check |
| `createPermit()` | `actions/permits.ts` | Create draft permit (step 1) |
| `updatePermitBuildingDetails()` | `actions/permits.ts` | Update building details (step 2) |
| `updatePermitComplianceRequirements()` | `actions/permits.ts` | Set compliance requirements (step 3) |
| `submitPermit()` | `actions/permits.ts` | Submit permit for review |
| `runComplianceCheck()` | `actions/permits.ts` | Trigger AI compliance analysis |
| `revisePermit()` | `actions/permits.ts` | Reset permit to draft for revision |
| `getMyPermits()` | `actions/permits.ts` | List user's permits |
| `getPermitById()` | `actions/permits.ts` | Fetch single permit (role-aware) |
| `getPermitHistory()` | `actions/permits.ts` | Status change timeline |
| `deletePermit()` | `actions/permits.ts` | Delete draft permit + attachments |
| `uploadPermitAttachment()` | `actions/permit-attachments.ts` | Upload file (max 10/permit, 10MB) |
| `deletePermitAttachment()` | `actions/permit-attachments.ts` | Remove attachment from storage |
| `getPermitAttachments()` | `actions/permit-attachments.ts` | List attachments with signed URLs |
| `getAdminPermits()` | `actions/admin-permits.ts` | All permits (filterable, paginated) |
| `reviewPermit()` | `actions/admin-permits.ts` | Approve / reject / request revision |
| `setPermitUnderReview()` | `actions/admin-permits.ts` | Start review (submitted → under_review) |
| `getPermitStats()` | `actions/admin-permits.ts` | Permit counts by status |
| `getAllRegisteredDocuments()` | `actions/documents.ts` | List all documents from registry |
| `upsertDocument()` | `actions/documents.ts` | Add or update document metadata |
| `deleteDocument()` | `actions/documents.ts` | Soft-delete document (optional chunk purge) |
| `restoreDocument()` | `actions/documents.ts` | Re-activate deleted document |
| `getNotifications()` | `actions/notifications.ts` | User's notifications + unread count |
| `markNotificationRead()` | `actions/notifications.ts` | Mark single notification as read |
| `markAllNotificationsRead()` | `actions/notifications.ts` | Mark all notifications as read |
| `getAnalyticsDashboardStats()` | `actions/analytics.ts` | Admin dashboard statistics |
| `getMessageActivity30d()` | `actions/analytics.ts` | 30-day message activity chart data |
| `getDocumentUsageStats()` | `actions/analytics.ts` | Document chunk usage breakdown |
| `getPermitStatusBreakdown()` | `actions/analytics.ts` | Permit status distribution |
| `getTopActiveUsers()` | `actions/analytics.ts` | Most active users leaderboard |
| `getAllUsers()` | `actions/admin.ts` | List all users (admin) |
| `adminCreateUser()` | `actions/admin.ts` | Create user (admin) |
| `blockUser()` | `actions/admin.ts` | Block/unblock user (admin) |
| `adminDeleteUser()` | `actions/admin.ts` | Delete user (admin) |
| `adminResetPassword()` | `actions/admin.ts` | Reset user password (admin) |
| `getAuditLogs()` | `actions/admin.ts` | View audit trail (admin) |
| `ingestPDF()` | `actions/ingest-pdf.ts` | Trigger PDF ingestion (admin) |
| `getIngestionStatus()` | `actions/ingest-pdf.ts` | Check chunk count & status |

<br />

---

## Permit System

### Lifecycle

| Status | Description | Set by |
|--------|-------------|--------|
| `draft` | Initial creation, editable | User |
| `submitted` | Sent for review | User |
| `under_review` | Admin actively reviewing | Admin |
| `approved` | Permit granted, certificate available | Admin |
| `rejected` | Permit denied with reason | Admin |
| `revision_requested` | Changes needed, user can revise and resubmit | Admin |

### Multi-Step Application Form

1. **Project Info** — name, description, location, project type (residential / commercial / industrial / mixed_use / institutional)
2. **Building Details** — floors, built-up area, plot area, height, units, parking spaces, occupancy type, construction type
3. **Compliance Requirements** — fire safety, accessibility, parking compliance, structural safety, MEP systems, energy efficiency, additional notes

### AI Compliance Check

When triggered by the user (`runComplianceCheck`):
1. Generates targeted RAG search queries from building details
2. Runs parallel hybrid searches (up to 15 unique chunks)
3. Sends context + permit summary to Gemini for structured JSON analysis
4. Returns `overallStatus` (compliant / non_compliant / requires_review) with individual checks and code references
5. Graceful fallback to `requires_review` on AI failure

### File Attachments

- Max 10 files per permit, 10 MB each
- Allowed types: `.pdf`, `.png`, `.jpg`, `.jpeg`, `.dwg`, `.dxf`
- Stored in Supabase Storage bucket `permit-attachments`
- 1-hour signed URLs for downloads

### PDF Certificates

Generated for approved permits via `GET /api/permits/[id]/certificate`:
- A4 PDF via `PDFKit`
- Certificate number: `PF-CERT-{YEAR}-{8-char-ID}`
- Includes project info, building details, approval status, review comments

### Pages

| Route | Access | Purpose |
|-------|--------|---------|
| `/permits` | User | Permit list with status badges |
| `/permits/new` | User | Multi-step creation form |
| `/permits/[id]` | User | Permit detail — timeline, attachments, compliance results |

<br />

---

## Testing

**156 tests** across **11 test suites** with comprehensive coverage of all critical systems.

```bash
npm test              # Run all tests (watch mode)
npm run test:coverage # v8 coverage report (HTML)
npm run test:ui       # Vitest UI dashboard
```

Single file: `npx vitest run test/auth.test.ts`
Pattern match: `npx vitest run -t "pattern"`

| Suite | File | Tests | Covers |
|-------|------|:-----:|--------|
| **Auth** | `test/auth.test.ts` | 8 | JWT create/verify, CSRF tokens, password hashing |
| **Agents** | `test/agents.test.ts` | 20 | Topic classification, query structure, tree reasoning |
| **API Chat Stream** | `test/api-chat-stream.test.ts` | 9 | Auth (401), rate limit (429), validation (400), CSRF, streaming (200) |
| **Chat Pipeline** | `test/chat-pipeline.test.ts` | 7 | RAG pipeline v2, semantic cache, CRAG, citation generation |
| **Citations** | `test/citation-parser.test.ts` | 19 | Chunk-based citations, confidence scoring, stats |
| **Permit Compliance** | `test/permit-compliance.test.ts` | 6 | AI compliance check, error fallback, malformed JSON handling |
| **Permit Actions** | `test/permits-actions.test.ts` | 18 | Create, submit, list, get, delete permits |
| **RAG** | `test/rag.test.ts` | 7 | Hybrid search with pre-computed embeddings, document filter |
| **Tree Reasoning** | `test/tree-reasoning.test.ts` | 28 | Query structure classification, keyword scoring, page ranges |
| **Validations** | `test/validations.test.ts` | 17 | Zod schemas, sanitization, edge cases |
| **Admin** | `test/admin.test.ts` | 20 | User creation, password rules, admin operations |

Test setup (`test/setup.ts`) mocks Supabase clients, Next.js headers/cookies, and 11 environment variables.

<br />

---

## Project Structure

```
PermitForge/
├── actions/                           # Server Actions (10 files)
│   ├── auth.ts                        #   Login / Logout with audit logging
│   ├── admin.ts                       #   User CRUD, stats, audit logs
│   ├── admin-permits.ts               #   Permit review & approval workflow
│   ├── permits.ts                     #   Permit CRUD, submit, compliance check
│   ├── permit-attachments.ts          #   File upload, download, delete
│   ├── chat-history.ts                #   Session & message management
│   ├── documents.ts                   #   Document registry CRUD (add, edit, delete, restore)
│   ├── notifications.ts               #   Notification read/unread management
│   ├── analytics.ts                   #   Dashboard charts & statistics
│   └── ingest-pdf.ts                  #   PDF ingestion trigger + status
│
├── app/                               # Next.js App Router
│   ├── layout.tsx                     #   Root layout + theme + metadata
│   ├── page.tsx                       #   Main chat dashboard
│   ├── globals.css                    #   Global styles
│   ├── login/page.tsx                 #   Login page
│   ├── admin/page.tsx                 #   Admin panel (5 tabs)
│   ├── not-found.tsx                  #   Custom 404 page
│   ├── permits/
│   │   ├── page.tsx                   #   Permit list
│   │   ├── new/page.tsx               #   Multi-step permit form (3 steps)
│   │   └── [id]/page.tsx              #   Permit detail view
│   └── api/
│       ├── chat/stream/route.ts       #   SSE streaming chat
│       ├── chat/export/route.ts       #   Chat export to Markdown
│       ├── ingest/route.ts            #   SSE PDF ingestion
│       ├── permits/[id]/certificate/  #   PDF certificate generation
│       └── health/route.ts            #   Health check endpoint
│
├── components/
│   ├── theme-provider.tsx             #   Dark/light theme context
│   ├── theme-toggle.tsx               #   Theme switcher
│   ├── chat/                          #   ChatInterface, MessageBubble, SourceCitation
│   ├── admin/                         #   UserManagement, DocumentManagement, PermitManagement,
│   │                                  #   AuditLogs, StatsCards, Charts (6 chart components)
│   ├── dashboard/                     #   Header, Sidebar
│   ├── notifications/                 #   NotificationBell
│   ├── permits/                       #   FormStep1-3, Stepper, PermitCard, PermitList,
│   │                                  #   PermitDetail, CompliancePanel, FileUpload,
│   │                                  #   StatusBadge, StatusTimeline, AttachmentList
│   └── ui/                            #   shadcn/ui primitives (20+ components)
│
├── lib/                               # Core Business Logic (22 modules)
│   ├── chat-pipeline.ts               #   v2 RAG orchestration + feature flags
│   ├── rag.ts                         #   Hybrid search, CRAG check, parent expansion
│   ├── agents.ts                      #   Topic classifier + Tree Reasoner
│   ├── semantic-cache.ts              #   Semantic query caching via pgvector
│   ├── document-selector.ts           #   Keyword-based document scoring (0 API)
│   ├── scope-detector.ts              #   Regex page/section/chapter detection (0 API)
│   ├── heuristic-reranker.ts          #   Deterministic reranking (0 API, ~1ms)
│   ├── citation-parser.ts             #   Chunk-based citations (0 API, 100% accurate)
│   ├── keyword-extractor.ts           #   TF-IDF keyword extraction from PDF (0 API)
│   ├── document-registry.ts           #   Document registry (fully DB-driven, cached)
│   ├── auth.ts                        #   JWT, sessions, passwords, CSRF
│   ├── security.ts                    #   requireAuth / requireAdmin guards
│   ├── gemini.ts                      #   Gemini + LangChain configuration
│   ├── pdf-parser.ts                  #   PDF.js text & TOC extraction
│   ├── pdf-ingestion.ts               #   Parent-child chunking, embedding, tree building
│   ├── tree-cache.ts                  #   Two-tier document tree cache
│   ├── permit-compliance.ts           #   RAG-powered compliance analysis
│   ├── permit-certificate.ts          #   PDF certificate via PDFKit
│   ├── notifications.ts               #   In-app + email (Resend) notifications
│   ├── file-upload.ts                 #   File validation, storage path generation
│   ├── supabase-server.ts             #   Supabase client factory (anon + admin)
│   ├── validations.ts                 #   Zod v4 schemas for all inputs
│   ├── constants.ts                   #   App-wide constants & configuration
│   ├── logger.ts                      #   Centralized logging (LOG_LEVEL support)
│   └── utils.ts                       #   Utilities (cn, etc.)
│
├── types/index.ts                     # Shared TypeScript definitions
├── test/                              # Vitest test suites (11 files, 156 tests)
├── supabase/migrations/               # Database schema (single 000_full_setup.sql)
├── middleware.ts                       # Edge auth + block check + security headers
└── public/                            # Static assets + PDF documents for ingestion
```

<br />

---

## Routes

| Route | Access | Purpose |
|-------|--------|---------|
| `/` | User | Main dashboard — chat interface + sidebar with session history |
| `/login` | Public | Login page (redirects logged-in users by role) |
| `/permits` | User | Permit application list |
| `/permits/new` | User | Multi-step permit creation (3 steps: project → building → compliance) |
| `/permits/[id]` | User | Permit detail view with status timeline, attachments, compliance results |
| `/admin` | Admin | Admin dashboard — 5 tabs: overview, users, permits, documents, audit logs |

Admin users are redirected away from user pages (`/`, `/permits`). Non-admins are redirected away from `/admin`. Blocked users are cleared and redirected to `/login`.

<br />

---

## Environment Variables

| Variable | Required | Description |
|----------|:--------:|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_ANON_KEY` | Yes | Supabase anonymous key (public, RLS-bound) |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase service role key (private, bypasses RLS) |
| `GEMINI_API_KEY` | Yes | Google Gemini API key |
| `JWT_SECRET` | Yes | JWT signing secret (min 32 chars, 64+ for production) |
| `RESEND_API_KEY` | — | Resend API key for email notifications |
| `LOG_LEVEL` | — | Logging verbosity: `debug` / `info` / `warn` / `error` |
| `NODE_ENV` | — | `development` / `production` |

<br />

---

## Tech Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| **Framework** | [Next.js](https://nextjs.org/) (App Router) | 15.5 |
| **UI** | [React](https://react.dev/) + [shadcn/ui](https://ui.shadcn.com/) + [Radix UI](https://www.radix-ui.com/) | 18.3 |
| **Styling** | [Tailwind CSS](https://tailwindcss.com/) | 4 |
| **Language** | [TypeScript](https://www.typescriptlang.org/) | 5 |
| **AI / LLM** | [Google Gemini 2.5 Flash](https://ai.google.dev/) via [LangChain](https://js.langchain.com/) 0.3 | — |
| **Embeddings** | Google `gemini-embedding-001` (768 dim) via [@google/genai](https://www.npmjs.com/package/@google/genai) SDK | — |
| **Database** | [Supabase](https://supabase.com/) (PostgreSQL + [pgvector](https://github.com/pgvector/pgvector) HNSW + pg_trgm) | — |
| **Auth** | [jose](https://github.com/panva/jose) (JWT HS256) + [bcryptjs](https://github.com/dcodeIO/bcrypt.js) (12 rounds) | — |
| **Validation** | [Zod](https://zod.dev/) | 4 |
| **XSS** | [isomorphic-dompurify](https://github.com/kkomelin/isomorphic-dompurify) | — |
| **PDF Parse** | [PDF.js](https://mozilla.github.io/pdf.js/) (pdfjs-dist) | — |
| **PDF Generate** | [PDFKit](https://pdfkit.org/) (permit certificates) | 0.17 |
| **Email** | [Resend](https://resend.com/) (optional, permit notifications) | — |
| **Charts** | [Recharts](https://recharts.org/) (admin analytics) | — |
| **Icons** | [Lucide React](https://lucide.dev/) | — |
| **Markdown** | [react-markdown](https://github.com/remarkjs/react-markdown) | 10 |
| **Testing** | [Vitest](https://vitest.dev/) + [@testing-library/react](https://testing-library.com/react) + [jsdom](https://github.com/jsdom/jsdom) | 4 |

<br />

---

## Available Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Development server at http://localhost:3000 |
| `npm run build` | Production build |
| `npm start` | Production server |
| `npm test` | Run all tests (watch mode) |
| `npm run test:coverage` | v8 coverage report (HTML) |
| `npm run test:ui` | Vitest UI dashboard |
| `npm run lint` | ESLint check |

<br />

---

## Contributing

1. Fork the repo
2. Create a branch — `git checkout -b feature/my-feature`
3. Write tests for new functionality
4. Ensure `npm test` passes
5. Submit a Pull Request

<br />

---

## License

MIT © 2026 Makazhan Alpamys — see [LICENSE](./LICENSE)

## Author

**Makazhan Alpamys** — [@MakazhanAlpamys](https://github.com/MakazhanAlpamys) · makazanalpamys@gmail.com

---

<div align="center">
<br />

Built with care for the construction industry

<br />
</div>
