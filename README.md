<div align="center">

<img src="https://img.shields.io/badge/🏗️-Emirate_Forge-0D1117?style=for-the-badge&labelColor=0D1117" alt="logo" height="40" />

# Emirate Forge

### AI-Powered Dubai Building Code 2021 Compliance Assistant

<br />

[![Next.js](https://img.shields.io/badge/Next.js-15.5-black?style=flat-square&logo=next.js&logoColor=white)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Gemini](https://img.shields.io/badge/Gemini-2.5_Flash-4285F4?style=flat-square&logo=google&logoColor=white)](https://ai.google.dev/)
[![Supabase](https://img.shields.io/badge/Supabase-pgvector-3ECF8E?style=flat-square&logo=supabase&logoColor=white)](https://supabase.com/)
[![React](https://img.shields.io/badge/React-18.3-61DAFB?style=flat-square&logo=react&logoColor=black)](https://react.dev/)
[![Tailwind](https://img.shields.io/badge/Tailwind-4-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white)](https://tailwindcss.com/)
[![Zod](https://img.shields.io/badge/Zod-4-3E67B1?style=flat-square&logo=zod&logoColor=white)](https://zod.dev/)
[![Tests](https://img.shields.io/badge/Tests-118_passing-22c55e?style=flat-square)](./test)
[![License](https://img.shields.io/badge/License-MIT-eab308?style=flat-square)](./LICENSE)

<br />

[**Features**](#-features) · [**Quick Start**](#-quick-start) · [**Architecture**](#-architecture) · [**API**](#-api-reference) · [**Testing**](#-testing) · [**Tech Stack**](#-tech-stack)

<br />

</div>

---

## 📋 Overview

**Emirate Forge** is an enterprise-grade AI assistant that delivers accurate, citation-backed answers to Dubai Building Code 2021 queries. It combines a **Hybrid RAG pipeline** (vector + keyword search with Reciprocal Rank Fusion), **deterministic Tree Reasoning** for structure-aware document navigation, and **Gemini 2.5 Flash** for real-time streaming responses — all wrapped in a secure, admin-managed platform.

> **Who is it for?** — Architects, engineers, construction professionals, and regulatory consultants working with Dubai Municipality building codes.

<br />

## ✨ Features

<table>
<tr>
<td width="50%">

### 🤖 Streaming AI Chat
- **Gemini 2.5 Flash** via LangChain streaming
- Context-aware via conversation memory (last 6 messages)
- Multilingual — English, Russian, Arabic
- Real-time token-by-token responses

</td>
<td width="50%">

### 📚 Hybrid RAG Pipeline
- **Vector similarity** (0.7) + **keyword FTS** (0.3) via RRF
- Multi-query search for complex questions
- AI-powered re-ranking (score ≥ 40 threshold)
- Exact section/table lookup via regex detection

</td>
</tr>
<tr>
<td>

### 🌳 Tree Reasoning
- **Deterministic** keyword-scoring algorithm (no LLM call)
- Structure-aware search using document hierarchy & TOC
- Regex-based query classifier (~1 ms)
- Automatic fallback to standard RAG on low confidence
- Two-tier cache (in-memory L1 + Supabase L2)

</td>
<td>

### 📍 Smart Citations
- 9 regex patterns for citation extraction from AI responses
- Database-backed matching via `match_citation` RPC
- Confidence scoring: match score (60%) + verification (40%)
- Dynamic 1–10 citation count — only what the AI actually used
- Supplemental high-relevance chunks appended (max 2)

</td>
</tr>
<tr>
<td>

### 🛡️ Enterprise Security
- **JWT** (HS256, 7-day expiry) with HttpOnly cookies
- **bcrypt** (12 rounds) password hashing
- **Timing-safe CSRF** token validation
- **Rate limiting** — database-backed (10 req/min)
- **Zod v4** schema validation on all inputs
- **XSS protection** via isomorphic-dompurify
- **RLS** — PostgreSQL Row-Level Security policies
- **Real-time block check** in Edge middleware
- Security headers on every response

</td>
<td>

### 🛠️ Admin Dashboard
- **4-tab panel:** Overview · Users · PDF Ingestion · Audit Logs
- User CRUD with block/unblock & role management
- Real-time stats: active users, total queries, document chunks
- Weekly activity charts
- PDF ingestion with SSE progress streaming
- Full audit log history (12 event types tracked)

</td>
</tr>
<tr>
<td>

### 📄 PDF Ingestion
- **PDF.js**-based parsing with TOC/bookmark extraction
- Smart chunking (800 chars, 150 overlap) with page tracking
- Section hierarchy mapping & content type detection
- Automatic document tree generation for Tree Reasoning
- Batch embedding with rate-limit-aware delays

</td>
<td>

### 🎨 Modern UI
- Dark / Light theme with system preference detection
- **shadcn/ui** + **Radix UI** component library
- Markdown rendering with formatted tables & lists
- Interactive citation badges with page links
- Responsive sidebar with chat history management

</td>
</tr>
</table>

<br />

---

## 🚀 Quick Start

### Prerequisites

| Tool | Version | Link |
|------|---------|------|
| Node.js | ≥ 20.x | [nodejs.org](https://nodejs.org/) |
| npm | ≥ 10.x | Included with Node.js |
| Supabase Account | — | [supabase.com](https://supabase.com/) |
| Google AI API Key | — | [ai.google.dev](https://ai.google.dev/) |

### 1. Clone & Install

```bash
git clone https://github.com/MakazhanAlpamys/Emirate-Forge.git
cd Emirate-Forge
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
```

> ⚠️ Never commit `.env.local` to version control.

### 3. Set Up Database

1. Create a project in [Supabase Dashboard](https://supabase.com/dashboard)
2. Open **SQL Editor** and run the contents of `supabase/migrations/001_complete_setup.sql`

This will automatically:
- Enable **pgvector**, **pg_trgm**, and **pgcrypto** extensions
- Create all tables (`users`, `chat_sessions`, `chat_messages`, `dubai_code_chunks`, `document_trees`, `audit_logs`, `rate_limits`)
- Set up **IVFFlat** vector index, **GIN** full-text search, and JSONB indexes
- Create RPC functions for hybrid search, filtered search, citations, rate limiting, and analytics
- Configure complete **RLS** policies
- Seed default admin user: `admin` / `Admin123!`

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
3. **Ingest PDF** — Admin Panel → PDF Ingestion → Upload your Dubai Building Code document
4. **Start chatting** — return to dashboard and ask questions

<br />

---

## 🏛️ Architecture

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
│  actions/auth.ts ─── Login · Logout                              │
│  actions/admin.ts ── User CRUD · Stats · Audit Logs              │
│  actions/chat-history.ts ── Sessions · Messages                  │
│  actions/ingest-pdf.ts ── PDF Ingestion · Status                 │
│                                                                  │
│  /api/chat/stream ── SSE streaming chat (main chat endpoint)     │
│  /api/ingest ─────── SSE PDF ingestion with progress             │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
          ┌──────────────────────┴──────────────────────┐
          ▼                                             ▼
┌───────────────────────────┐              ┌────────────────────────┐
│     CORE LIBRARY          │              │   EXTERNAL SERVICES    │
│                           │              │                        │
│  chat-pipeline.ts         │              │  Supabase              │
│  ├─ Topic Classifier      │◄────────────►│  ├─ PostgreSQL + RLS   │
│  ├─ Tree / Standard route │              │  ├─ pgvector           │
│  └─ Feature flags         │              │  └─ Full-Text Search   │
│                           │              │                        │
│  rag.ts                   │              │  Google Gemini         │
│  ├─ Hybrid Search (RRF)   │◄────────────►│  ├─ 2.5 Flash (chat)   │
│  ├─ Filtered Search       │              │  └─ text-embedding-004 │
│  └─ Multi-Query Search    │              │                        │
│                           │              └────────────────────────┘
│  agents.ts                │
│  ├─ Topic Classifier      │
│  ├─ Query Expander        │
│  ├─ Chunk Re-ranker       │
│  ├─ Answer Verifier       │
│  └─ Tree Reasoner (det.)  │
│                           │
│  citation-parser.ts       │
│  auth.ts · security.ts    │
│  pdf-parser.ts            │
│  pdf-ingestion.ts         │
│  tree-cache.ts            │
│  gemini.ts · validations  │
└───────────────────────────┘
```

### RAG Pipeline Flow

```
User Query
    │
    ▼
┌──────────────────────┐
│  Topic Classifier    │ ──► Off-topic → Generic response
└──────────────────────┘
    │ On-topic
    ▼
┌──────────────────────┐
│  Query Type Detector │ ──► Greeting → Welcome message
└──────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────────────────────┐
│  QUERY STRUCTURE CLASSIFIER  (regex-based, ~1 ms, no LLM)    │
│                                                              │
│  "in chapter/section X" ───────► Structural                  │
│  "summarize chapter" ──────────► Structural                  │
│  "parking for residential" ────► Structural (topic+context)  │
│  "compare fire and parking" ───► Structural (comparison)     │
│  "What are requirements?" ─────► Standard                    │
└──────────────────────────────────────────────────────────────┘
         │                              │
    Structural                     Standard
         │                              │
         ▼                              ▼
┌───────────────────────┐    ┌─────────────────────────┐
│  🌳 TREE REASONING    │    │  STANDARD PATH          │
│                       │    │                         │
│  1. Load cached tree  │    │  Query Expansion (LLM)  │
│  2. Deterministic     │    │         ↓               │
│     keyword scoring   │    │  Hybrid Search (RRF)    │
│  3. Select top nodes  │    │  ─ vector similarity    │
│  4. Filtered search   │    │  ─ keyword FTS          │
│     (within pages)    │    │         ↓               │
│                       │    │  AI Re-ranking          │
│  [conf < 60%] ───────────► │                         │
└───────────────────────┘    └─────────────────────────┘
         │                              │
         └──────────┬───────────────────┘
                    ▼
         Context Building (formatted [SOURCE N] chunks)
                    │
                    ▼
         LLM Generation (Gemini 2.5 Flash, streaming)
                    │
                    ▼
         Answer Verification (hallucination check)
                    │
                    ▼
         Citation Parsing & Matching (9 regex patterns → DB lookup)
                    │
                    ▼
              Response to User
```

### Database Schema

```
┌─────────────────────┐          ┌──────────────────────┐
│      users          │          │  dubai_code_chunks   │
│ ─────────────────── │          │ ──────────────────── │
│  id (UUID, PK)      │          │  id (BIGINT, PK)     │
│  username (UNIQUE)  │          │  content (TEXT)      │
│  password_hash      │          │  metadata (JSONB)    │
│  role (admin/user)  │          │  embedding (VECTOR)  │ ◄── pgvector
│  blocked (BOOL)     │          │  fts (TSVECTOR)      │ ◄── GIN index
│  blocked_reason     │          └──────────────────────┘
│  created_at         │
└──────────┬──────────┘          ┌──────────────────────┐
           │ 1:N                 │  document_trees      │
           ▼                     │ ──────────────────── │
┌─────────────────────┐          │  id (UUID, PK)       │
│   chat_sessions     │          │  tree_data (JSONB)   │
│ ─────────────────── │          │  metadata (JSONB)    │
│  id (UUID, PK)      │          │  updated_at          │
│  user_id (FK)       │          └──────────────────────┘
│  title              │
│  created_at         │          ┌──────────────────────┐
│  updated_at         │          │   rate_limits        │
└──────────┬──────────┘          │ ──────────────────── │
           │ 1:N                 │  user_id (FK)        │
           ▼                     │  endpoint            │
┌─────────────────────┐          │  request_count       │
│   chat_messages     │          │  window_start        │
│ ─────────────────── │          └──────────────────────┘
│  id (UUID, PK)      │
│  session_id (FK)    │          ┌──────────────────────┐
│  role               │          │   audit_logs         │
│  content (TEXT)     │          │ ──────────────────── │
│  citations (JSONB)  │          │  id (UUID, PK)       │
│  created_at         │          │  user_id (FK)        │
└─────────────────────┘          │  action              │
                                 │  details (JSONB)     │
                                 │  ip_address          │
                                 │  user_agent          │
                                 │  created_at          │
                                 └──────────────────────┘
```

<br />

---

## 📡 API Reference

### Streaming Chat — `POST /api/chat/stream`

The primary chat endpoint. Returns an SSE stream of tokens, followed by citations.

```http
POST /api/chat/stream
Content-Type: application/json
Cookie: ef_token=<jwt>

{
  "message": "What are parking requirements for residential buildings?",
  "sessionId": "optional-uuid"
}
```

**Response** (`text/event-stream`):

```
data: {"type":"token","content":"According to "}
data: {"type":"token","content":"Section 5.2..."}
data: {"type":"citations","citations":[...]}
data: {"type":"done"}
```

### PDF Ingestion — `POST /api/ingest`

Admin-only. Processes and stores PDF documents with progress streaming.

```http
POST /api/ingest
Content-Type: multipart/form-data
Cookie: ef_token=<admin-jwt>
```

**Response** (`text/event-stream`):

```
data: {"type":"progress","message":"Parsing PDF...","percent":10}
data: {"type":"progress","message":"Generating embeddings...","percent":50}
data: {"type":"complete","chunksProcessed":1250}
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
| `getDashboardStats()` | `actions/admin.ts` | Overview statistics |
| `getAllUsers()` | `actions/admin.ts` | List all users (admin) |
| `adminCreateUser()` | `actions/admin.ts` | Create user (admin) |
| `blockUser()` | `actions/admin.ts` | Block/unblock user (admin) |
| `adminDeleteUser()` | `actions/admin.ts` | Delete user (admin) |
| `adminResetPassword()` | `actions/admin.ts` | Reset password (admin) |
| `getAuditLogs()` | `actions/admin.ts` | View audit trail (admin) |
| `ingestPDF()` | `actions/ingest-pdf.ts` | Trigger PDF ingestion (admin) |
| `getIngestionStatus()` | `actions/ingest-pdf.ts` | Check chunk count & status |

<br />

---

## 🧪 Testing

**118 tests** across 7 test suites covering all critical modules.

```bash
npm test              # Run all tests
npm test -- --watch   # Watch mode
npm run test:ui       # Vitest UI
npm run test:coverage # Coverage report (v8)
```

| Suite | File | Tests | Covers |
|-------|------|:-----:|--------|
| **Auth** | `test/auth.test.ts` | ~8 | JWT create/verify, CSRF tokens, password hashing |
| **RAG** | `test/rag.test.ts` | ~7 | Hybrid search, multi-query, RRF fusion |
| **Agents** | `test/agents.test.ts` | ~18 | Topic classification, query expansion, re-ranking, verification |
| **Tree Reasoning** | `test/tree-reasoning.test.ts` | ~25 | Query structure classification, keyword scoring, page ranges |
| **Citations** | `test/citation-parser.test.ts` | ~17 | 9 extraction patterns, matching, confidence, stats |
| **Validations** | `test/validations.test.ts` | ~12 | Zod schemas, sanitization, edge cases |
| **Admin** | `test/admin.test.ts` | ~21 | User creation, password rules, admin operations |

<br />

---

## 📁 Project Structure

```
Emirate-Forge/
├── actions/                    # Server Actions
│   ├── auth.ts                 #   Login / Logout
│   ├── admin.ts                #   User CRUD, stats, audit logs
│   ├── chat-history.ts         #   Session & message management
│   └── ingest-pdf.ts           #   PDF ingestion + status
│
├── app/                        # Next.js App Router
│   ├── layout.tsx              #   Root layout + theme provider
│   ├── page.tsx                #   Main chat dashboard
│   ├── globals.css             #   Global styles
│   ├── login/page.tsx          #   Login page
│   ├── admin/page.tsx          #   Admin panel (4 tabs)
│   └── api/
│       ├── chat/stream/route.ts  # SSE streaming chat
│       └── ingest/route.ts       # SSE PDF ingestion
│
├── components/
│   ├── theme-provider.tsx      #   Dark/light theme context
│   ├── theme-toggle.tsx        #   Theme switcher
│   ├── chat/                   #   Chat UI (interface, bubble, citations)
│   ├── admin/                  #   Admin UI (users, stats, ingestion, logs)
│   ├── dashboard/              #   Layout (header, sidebar)
│   └── ui/                     #   shadcn/ui primitives
│
├── lib/                        # Core Business Logic
│   ├── chat-pipeline.ts        #   Centralized RAG orchestration
│   ├── rag.ts                  #   Hybrid search, multi-query, RRF
│   ├── agents.ts               #   AI agents + Tree Reasoner
│   ├── citation-parser.ts      #   Citation extraction & matching
│   ├── auth.ts                 #   JWT, sessions, passwords, CSRF
│   ├── security.ts             #   requireAuth / requireAdmin guards
│   ├── gemini.ts               #   LangChain Gemini config
│   ├── pdf-parser.ts           #   PDF.js text & TOC extraction
│   ├── pdf-ingestion.ts        #   Chunking, embedding, tree building
│   ├── tree-cache.ts           #   Two-tier document tree cache
│   ├── supabase-server.ts      #   Supabase client factory
│   ├── validations.ts          #   Zod v4 schemas
│   ├── constants.ts            #   App-wide constants
│   └── utils.ts                #   Utilities (cn, etc.)
│
├── types/index.ts              # Shared TypeScript definitions
├── test/                       # Vitest test suites (7 files)
├── supabase/migrations/        # Database schema (001_complete_setup.sql)
├── middleware.ts                # Edge auth + block check + security headers
└── public/                     # Static assets
```

<br />

---

## ⚙️ Environment Variables

| Variable | Required | Description |
|----------|:--------:|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | ✅ | Supabase project URL |
| `SUPABASE_ANON_KEY` | ✅ | Supabase anonymous key (public, RLS-bound) |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | Supabase service role key (private, bypasses RLS) |
| `GEMINI_API_KEY` | ✅ | Google Gemini API key |
| `JWT_SECRET` | ✅ | JWT signing secret (min 32 chars) |
| `NODE_ENV` | — | `development` / `production` |

<br />

---

## 🔧 Tech Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| **Framework** | [Next.js](https://nextjs.org/) (App Router) | 15.5 |
| **UI** | [React](https://react.dev/) + [shadcn/ui](https://ui.shadcn.com/) + [Radix UI](https://www.radix-ui.com/) | 18.3 |
| **Styling** | [Tailwind CSS](https://tailwindcss.com/) | 4 |
| **Language** | [TypeScript](https://www.typescriptlang.org/) | 5 |
| **AI / LLM** | [Google Gemini 2.5 Flash](https://ai.google.dev/) via [LangChain](https://js.langchain.com/) | — |
| **Embeddings** | Google `text-embedding-004` (768 dim) | — |
| **Database** | [Supabase](https://supabase.com/) (PostgreSQL + [pgvector](https://github.com/pgvector/pgvector)) | — |
| **Auth** | [jose](https://github.com/panva/jose) (JWT) + [bcryptjs](https://github.com/dcodeIO/bcrypt.js) | — |
| **Validation** | [Zod](https://zod.dev/) | 4 |
| **XSS** | [isomorphic-dompurify](https://github.com/kkomelin/isomorphic-dompurify) | — |
| **PDF** | [PDF.js](https://mozilla.github.io/pdf.js/) (pdfjs-dist) | — |
| **Icons** | [Lucide React](https://lucide.dev/) | — |
| **Markdown** | [react-markdown](https://github.com/remarkjs/react-markdown) | 10 |
| **Testing** | [Vitest](https://vitest.dev/) + [@testing-library/react](https://testing-library.com/react) + [jsdom](https://github.com/jsdom/jsdom) | 4 |

<br />

---

## 🤝 Contributing

1. Fork the repo
2. Create a branch — `git checkout -b feature/my-feature`
3. Write tests for new functionality
4. Ensure `npm test` passes
5. Submit a Pull Request

<br />

---

## 📄 License

MIT © 2026 Makazhan Alpamys — see [LICENSE](./LICENSE)

## 👤 Author

**Makazhan Alpamys** — [@MakazhanAlpamys](https://github.com/MakazhanAlpamys) · makazanalpamys@gmail.com

---

<div align="center">
<br />

Built with ❤️ for the construction industry

<br />
</div>
