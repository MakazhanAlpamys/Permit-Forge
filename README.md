# 🏗️ Emirate Forge - Dubai Building Code AI Assistant

<div align="center">

**Enterprise-grade AI Assistant for Dubai Building Code 2021 Compliance**

[![Next.js](https://img.shields.io/badge/Next.js-15.5-black?logo=next.js)](https://nextjs.org/)
[![Gemini](https://img.shields.io/badge/Gemini-2.5_Flash-blue?logo=google)](https://ai.google.dev/)
[![Supabase](https://img.shields.io/badge/Supabase-PostgreSQL-green?logo=supabase)](https://supabase.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/Tests-82%20passing-brightgreen)](./test)
[![License](https://img.shields.io/badge/License-MIT-yellow)](./LICENSE)

</div>

---

## 📋 Overview

**Emirate Forge** is an AI assistant for navigating the **Dubai Building Code 2021**. It uses an Advanced RAG (Retrieval-Augmented Generation) pipeline to provide accurate, citation-backed answers to compliance queries.

### Features

| Feature | Description |
|---------|-------------|
| 🤖 **AI Chat** | Powered by **Gemini 2.5 Flash** with streaming responses |
| 📚 **Hybrid RAG** | Vector + Keyword search with RRF fusion and AI re-ranking |
| 📍 **Smart Citations** | Auto-parsed citations with page/section references |
| 📊 **Confidence Scoring** | Verification confidence for each answer |
| 📄 **Rich Excerpts** | Tables and lists rendered directly in chat |
| 🔗 **PDF Deep Links** | Direct links to source pages |
| 🔐 **Enterprise Security** | JWT auth, RBAC, audit logging |
| 🛠️ **Admin Panel** | User management, PDF ingestion, analytics |

---

## 🏛️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Frontend                             │
│     Next.js 15 (App Router) + React 18 + Tailwind CSS 4     │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Server Actions / API                     │
│   actions/chat.ts  │  actions/admin.ts  │  actions/auth.ts  │
└─────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
┌─────────────────────────┐     ┌─────────────────────────────┐
│      Core Libraries     │     │       External APIs         │
│  lib/rag.ts             │     │  Supabase (PostgreSQL +     │
│  lib/agents.ts          │     │  pgvector + FTS)            │
│  lib/auth.ts            │     │                             │
│  lib/chat-pipeline.ts   │     │  Google Gemini 2.5 Flash    │
│  lib/citation-parser.ts │     │  text-embedding-004         │
└─────────────────────────┘     └─────────────────────────────┘
```

---

## 🚀 Getting Started

### Prerequisites
- Node.js 20+
- Supabase Project (with pgvector extension)
- Google Gemini API Key

### Installation

```bash
# Clone and install
git clone https://github.com/MakazhanAlpamys/Emirate-Forge.git
cd Emirate-Forge
npm install
```

### Environment Variables

Create `.env.local`:

```env
# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key

# Google Gemini
GEMINI_API_KEY=your_gemini_api_key

# JWT (minimum 32 characters, recommended 64+ for production)
JWT_SECRET=your_secure_random_jwt_secret_at_least_32_chars
```

### Database Setup

1. Open **Supabase Dashboard** → **SQL Editor**
2. Run the migration: `supabase/migrations/001_complete_setup.sql`
3. This creates all tables, functions, and the default admin user

### Run

```bash
npm run dev
```

### First Login

1. Go to `http://localhost:3000/login`
2. Login: `admin` / `Admin123!`
3. **Change your password immediately** in Admin Panel → Users
4. Go to **PDF Ingestion** tab and ingest `dubai-code.pdf`

---

## 📁 Project Structure

```
permitai/
├── actions/           # Server Actions
│   ├── auth.ts        # Login, logout, password change
│   ├── admin.ts       # User management, stats
│   ├── chat.ts        # Main chat with RAG
│   ├── chat-history.ts # Session management
│   └── ingest-pdf.ts  # PDF ingestion (admin only)
├── app/
│   ├── page.tsx       # Main chat interface
│   ├── login/         # Login page
│   ├── admin/         # Admin dashboard
│   └── api/
│       ├── chat/stream/ # Streaming chat API
│       └── ingest/     # PDF ingestion with progress
├── components/
│   ├── chat/          # Chat UI components
│   ├── admin/         # Admin panel components
│   ├── dashboard/     # Main layout components
│   └── ui/            # shadcn/ui components
├── lib/
│   ├── auth.ts        # JWT, sessions, password hashing
│   ├── rag.ts         # Hybrid search, multi-query
│   ├── agents.ts      # AI agents (classifier, reranker, verifier)
│   ├── chat-pipeline.ts # Centralized RAG pipeline
│   ├── citation-parser.ts # Citation extraction & matching
│   ├── pdf-parser.ts  # PDF.js text extraction with TOC
│   ├── pdf-ingestion.ts # Chunking & embedding
│   ├── gemini.ts      # LangChain Gemini client
│   └── supabase-server.ts # Supabase clients
├── supabase/
│   └── migrations/    # SQL schema & functions
├── test/              # Vitest tests (82 tests)
└── types/             # TypeScript definitions
```

---

## 🔒 Security

| Feature | Implementation |
|---------|----------------|
| **Authentication** | JWT tokens in HttpOnly cookies |
| **Password Hashing** | bcrypt with 12 rounds |
| **Rate Limiting** | Database-backed (10 req/min) |
| **Input Validation** | Zod schemas on all endpoints |
| **XSS Protection** | DOMPurify for user content |
| **CSRF Protection** | Token-based validation |
| **Audit Logging** | All security events tracked |
| **RLS** | Row Level Security on all tables |

---

## 🧪 Testing

```bash
npm test              # Run all tests
npm run test:ui       # Interactive UI
npm run test:coverage # Coverage report
```

**82 tests** covering:
- Authentication & JWT
- RAG pipeline & search
- Citation parsing
- Admin functions
- Input validation

---

## 📝 API Reference

### Chat (Streaming)
```
POST /api/chat/stream
Body: { message: string, sessionId?: string }
Response: text/event-stream with citations
```

### PDF Ingestion (Admin)
```
POST /api/ingest
Response: Server-Sent Events with progress
```

### Server Actions
- `loginAction(formData)` - Authenticate user
- `sendChatMessage(request)` - Non-streaming chat
- `createChatSession(title)` - New chat session
- `adminCreateUser(data)` - Create user (admin)
- `ingestPDF()` - Start PDF ingestion (admin)

---

## 🛣️ Roadmap

- [x] Hybrid RAG with RRF fusion
- [x] AI-powered re-ranking
- [x] Smart citation system
- [x] Admin dashboard
- [x] PDF ingestion pipeline
- [x] Streaming responses
- [ ] Redis caching for rate limiting
- [ ] Multiple document support
- [ ] OCR for scanned PDFs
- [ ] Email verification

---

## 📄 License

MIT License © 2026 Makazhan Alpamys