# 🏗️ Emirate Forge

<div align="center">

**Enterprise AI Assistant for Dubai Building Code 2021 Compliance**

[![Next.js](https://img.shields.io/badge/Next.js-15.5-black?logo=next.js&logoColor=white)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Gemini](https://img.shields.io/badge/Gemini-2.5_Flash-4285F4?logo=google&logoColor=white)](https://ai.google.dev/)
[![Supabase](https://img.shields.io/badge/Supabase-PostgreSQL-3ECF8E?logo=supabase&logoColor=white)](https://supabase.com/)
[![React](https://img.shields.io/badge/React-18.3-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![Tailwind](https://img.shields.io/badge/Tailwind-4.0-06B6D4?logo=tailwindcss&logoColor=white)](https://tailwindcss.com/)
[![Tests](https://img.shields.io/badge/Tests-110_passing-success)](./test)
[![License](https://img.shields.io/badge/License-MIT-yellow)](./LICENSE)

[Features](#-key-features) • [Quick Start](#-quick-start) • [Architecture](#-architecture) • [Documentation](#-documentation) • [Testing](#-testing)

</div>

---

## 📋 Overview

**Emirate Forge** is an enterprise-grade AI assistant that provides accurate, citation-backed answers to Dubai Building Code 2021 compliance queries. Built with cutting-edge RAG (Retrieval-Augmented Generation) technology, it combines advanced AI with comprehensive regulatory knowledge to assist architects, engineers, and construction professionals.

### 🎯 Why Emirate Forge?

- **Instant Expert Knowledge**: Get immediate answers to complex building code questions
- **Verified Accuracy**: Every answer backed by specific code sections with citations
- **Save Time**: No more manual PDF searching through hundreds of pages
- **Stay Compliant**: Ensure your projects meet Dubai regulatory requirements
- **Always Up-to-Date**: Structured knowledge base from Dubai Building Code 2021

---

## ✨ Key Features

### 🤖 AI-Powered Chat
- **Gemini 2.5 Flash** LLM for fast, accurate responses
- **Real-time streaming** for instant feedback
- **Context-aware** conversations with chat history
- **Multi-language** support capabilities

### 📚 Advanced RAG Pipeline
- **Hybrid Search**: Combines vector similarity + keyword matching with Reciprocal Rank Fusion (RRF)
- **🌳 Tree Reasoning**: Structure-aware search using document hierarchy (NEW!)
- **Query Expansion**: Automatically generates related queries for comprehensive results
- **AI Re-ranking**: Gemini-powered relevance scoring for top results
- **Multi-Query Search**: Parallel searches for complex questions
- **Topic Classification**: Smart routing for on/off-topic queries

### 📍 Smart Citation System
- **Automatic Citation Parsing**: Extracts section numbers, pages, and chapters
- **Confidence Scoring**: Each citation includes a verification confidence score
- **Deep Linking**: Direct links to specific PDF pages
- **Citation Validation**: AI verification against source chunks
- **Metadata Enrichment**: Chapter, section, and page information

### 🔐 Enterprise Security
| Security Layer | Implementation |
|---------------|----------------|
| **Authentication** | JWT tokens with HttpOnly cookies |
| **Password Security** | bcrypt hashing with 12 rounds |
| **Rate Limiting** | Database-backed (10 requests/minute) |
| **Input Validation** | Zod schemas on all endpoints |
| **XSS Protection** | isomorphic-dompurify sanitization |
| **CSRF Protection** | Token-based validation |
| **Audit Logging** | Comprehensive activity tracking |
| **Row-Level Security** | PostgreSQL RLS policies |

### 🛠️ Admin Dashboard
- **User Management**: Create, edit, block/unblock users
- **Role-Based Access Control**: Admin and regular user roles
- **Analytics Dashboard**: Usage statistics and activity charts
- **PDF Ingestion Pipeline**: Upload and process building code documents
- **Audit Logs**: Complete security event history
- **Real-time Stats**: Active users, total queries, document chunks

### 📊 Rich Content Display
- **Markdown Rendering**: Formatted responses with tables and lists
- **Code Blocks**: Syntax-highlighted technical specifications
- **Interactive Citations**: Clickable source references
- **Progress Indicators**: Real-time upload and processing status

---

## 🏛️ Architecture

### System Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                         Frontend Layer                           │
│    Next.js 15 (App Router) + React 18 + Tailwind CSS 4           │
│    • Server Components      • Client Components                  │
│    • Streaming UI           • Real-time Updates                  │
└──────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌──────────────────────────────────────────────────────────────────┐
│                      Server Actions & API Routes                 │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────┐              │
│  │ auth.ts     │  │ chat.ts     │  │ admin.ts     │              │
│  │ • Login     │  │ • RAG Query │  │ • User Mgmt  │              │
│  │ • Logout    │  │ • Streaming │  │ • Analytics  │              │
│  └─────────────┘  └─────────────┘  └──────────────┘              │
└──────────────────────────────────────────────────────────────────┘
                                 │
          ┌──────────────────────┴──────────────────────┐
          ▼                                             ▼
┌───────────────────────────┐              ┌────────────────────────┐
│   Core Library Layer      │              │   External Services    │
│                           │              │                        │
│  📚 rag.ts                │              │  🗄️ Supabase           │
│  • Hybrid Search          │◄────────────►│   • PostgreSQL         │
│  • Multi-Query            │              │   • pgvector           │
│  • RRF Fusion             │              │   • Full-Text Search   │
│                           │              │                        │
│  🤖 agents.ts             │              │  🧠 Google Gemini      │
│  • Topic Classifier       │◄────────────►│   • 2.5 Flash (LLM)    │
│  • Query Expander         │              │   • text-embedding-004 │
│  • Chunk Re-ranker        │              │                        │
│  • Answer Verifier        │              │                        │
│                           │              │                        │
│  📍 citation-parser.ts    │              └────────────────────────┘
│  • Citation Extraction    │
│  • Smart Matching         │
│  • Confidence Scoring     │
│                           │
│  🔐 auth.ts               │
│  • JWT Management         │
│  • Session Handling       │
│  • Password Security      │
│                           │
│  📄 pdf-parser.ts         │
│  • PDF.js Integration     │
│  • TOC Extraction         │
│  • Text Processing        │
└───────────────────────────┘
```

### RAG Pipeline Flow

```
User Query
    │
    ▼
┌─────────────────────┐
│ Topic Classifier    │ ──► Off-topic? → Generic Response
└─────────────────────┘
    │ On-topic
    ▼
┌─────────────────────┐
│ Query Type Detector │ ──► Greeting? → Welcome Message
└─────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│ 🌳 QUERY STRUCTURE CLASSIFIER (Fast, No LLM)           │
│                                                         │
│  Structural Query?                                      │
│  • "in chapter/section X" ────────► YES                │
│  • "summarize chapter" ───────────► YES                │
│  • "compare X and Y" ─────────────► YES                │
│  • "parking for residential" ─────► YES                │
│  • "What are requirements?" ──────► NO (standard path) │
└─────────────────────────────────────────────────────────┘
         │                              │
    YES (structural)              NO (standard)
         │                              │
         ▼                              ▼
┌───────────────────────┐    ┌─────────────────────┐
│ 🌳 TREE REASONING     │    │ STANDARD PATH       │
│                       │    │                     │
│ 1. Load document tree │    │ Query Expansion     │
│ 2. LLM selects        │    │        ↓            │
│    relevant sections  │    │ Hybrid Search       │
│ 3. Filtered search    │    │ (full document)     │
│    (within sections)  │    │        ↓            │
│                       │    │ AI Re-ranking       │
│ [FALLBACK ──────────────►] │                     │
└───────────────────────┘    └─────────────────────┘
         │                              │
         └──────────┬───────────────────┘
                    ▼
┌─────────────────────┐
│ Context Building    │ ──► Format chunks with metadata
└─────────────────────┘
    │
    ▼
┌─────────────────────┐
│ LLM Generation      │ ──► Gemini 2.5 Flash with streaming
└─────────────────────┘
    │
    ▼
┌─────────────────────┐
│ Answer Verification │ ──► AI checks accuracy vs sources
└─────────────────────┘
    │
    ▼
┌─────────────────────┐
│ Citation Parsing    │ ──► Extract & match citations
└─────────────────────┘
    │
    ▼
Response to User
```

### 🌳 Tree Reasoning (Structure-Aware RAG)

Tree Reasoning is an advanced feature that uses document structure for more precise search:

| Feature | Description |
|---------|-------------|
| **Fast Detector** | Regex-based classification (no LLM call, ~1ms) |
| **Tree Reasoner** | LLM analyzes TOC to select relevant sections |
| **Filtered Search** | Hybrid search within specific page ranges |
| **Fallback** | Automatic fallback to standard search on failure |

**Example Query Routing:**

| Query | Path | Why |
|-------|------|-----|
| "What are parking requirements?" | Standard | No structural context |
| "parking for residential buildings" | Tree Reasoning | Contextual query |
| "summarize chapter 4" | Tree Reasoning | Section reference |
| "compare fire safety and parking" | Tree Reasoning | Comparison query |

**Benefits:**
- 🎯 **20-40% better precision** on structural queries
- ⚡ **Faster search** (smaller scope)
- 🔄 **No regression** (fallback to standard path)

### Database Schema

```sql
┌─────────────────────┐
│      users          │
│ ─────────────────── │
│ • id (UUID)         │
│ • username          │
│ • password_hash     │
│ • role              │
│ • is_blocked        │
└─────────────────────┘
         │
         │ 1:N
         ▼
┌─────────────────────┐
│  chat_sessions      │
│ ─────────────────── │
│ • id (UUID)         │
│ • user_id (FK)      │
│ • title             │
│ • created_at        │
└─────────────────────┘
         │
         │ 1:N
         ▼
┌─────────────────────┐
│  chat_messages      │
│ ─────────────────── │
│ • id (UUID)         │
│ • session_id (FK)   │
│ • role              │
│ • content           │
│ • citations (JSONB) │
└─────────────────────┘

┌──────────────────────┐
│ dubai_code_chunks    │
│ ──────────────────── │
│ • id (BIGINT)        │
│ • content (TEXT)     │
│ • metadata (JSONB)   │
│ • embedding (VECTOR) │ ◄─── pgvector for similarity search
│ • fts (tsvector)     │ ◄─── Full-text search index
└──────────────────────┘

┌─────────────────────┐      ┌─────────────────────┐
│   rate_limits       │      │   audit_logs        │
│ ─────────────────── │      │ ─────────────────── │
│ • user_id (FK)      │      │ • id (UUID)         │
│ • endpoint          │      │ • user_id (FK)      │
│ • request_count     │      │ • action            │
│ • window_start      │      │ • details (JSONB)   │
└─────────────────────┘      └─────────────────────┘
```

---

## 🚀 Quick Start

### Prerequisites

Before you begin, ensure you have:

- **Node.js** 20.x or higher ([Download](https://nodejs.org/))
- **npm** 10.x or higher (comes with Node.js)
- **Supabase Account** ([Sign up](https://supabase.com/))
- **Google AI API Key** ([Get one](https://ai.google.dev/))

### Installation

1. **Clone the repository**

```bash
git clone https://github.com/MakazhanAlpamys/Emirate-Forge.git
cd Emirate-Forge
```

2. **Install dependencies**

```bash
npm install
```

3. **Set up environment variables**

Create a `.env.local` file in the root directory:

```env
# Supabase Configuration
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your_anon_key_here
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key_here

# Google Gemini API
GEMINI_API_KEY=your_gemini_api_key_here

# JWT Secret (generate a secure random string, 64+ characters recommended)
JWT_SECRET=your_secure_random_jwt_secret_minimum_32_characters_recommended_64_plus_for_production
```

> **Security Note**: Never commit `.env.local` to version control. Use strong, randomly generated secrets in production.

### Database Setup

1. **Create a Supabase project**
   - Go to [Supabase Dashboard](https://supabase.com/dashboard)
   - Create a new project
   - Wait for the database to be provisioned

2. **Enable required extensions**
   - Go to **SQL Editor** in your Supabase dashboard
   - Run the migration script:

```bash
# Copy the contents of supabase/migrations/001_complete_setup.sql
# Paste into Supabase SQL Editor and run
```

This migration will:
- ✅ Enable pgvector, pg_trgm, and pgcrypto extensions
- ✅ Create all necessary tables (users, chat_sessions, dubai_code_chunks, etc.)
- ✅ Set up indexes for optimal performance
- ✅ Create RPC functions for hybrid search and analytics
- ✅ Insert default admin user (`admin` / `Admin123!`)

### Running the Application

1. **Development mode**

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

2. **Production build**

```bash
npm run build
npm start
```

### First-Time Setup

1. **Login as admin**
   - Navigate to `http://localhost:3000/login`
   - Username: `admin`
   - Password: `Admin123!`

2. **Change default password** ⚠️
   - Go to Admin Panel → Users
   - Click on admin user → Change Password
   - Use a strong password (min 8 chars, uppercase, lowercase, number, symbol)

3. **Ingest Dubai Building Code PDF**
   - Go to Admin Panel → PDF Ingestion tab
   - Upload `dubai-code.pdf` (or your building code document)
   - Wait for processing (this may take several minutes)
   - Monitor progress via the real-time status updates

4. **Start chatting!**
   - Return to the main dashboard
   - Ask questions about Dubai Building Code
   - View citations and source references

---

## 📁 Project Structure

```
emirate-forge/
│
├── 📂 actions/                 # Next.js Server Actions
│   ├── auth.ts                # Authentication (login, logout, password management)
│   ├── admin.ts               # Admin operations (user management, stats)
│   ├── chat.ts                # Main chat functionality with RAG
│   ├── chat-history.ts        # Session management (create, list, delete)
│   └── ingest-pdf.ts          # PDF ingestion pipeline (admin only)
│
├── 📂 app/                     # Next.js App Router
│   ├── layout.tsx             # Root layout with theme provider
│   ├── page.tsx               # Main chat interface (home page)
│   ├── globals.css            # Global styles and Tailwind imports
│   │
│   ├── 📂 login/              # Authentication
│   │   └── page.tsx           # Login page
│   │
│   ├── 📂 admin/              # Admin dashboard
│   │   └── page.tsx           # Admin panel (users, analytics, PDF ingestion)
│   │
│   └── 📂 api/                # API Routes
│       ├── 📂 chat/stream/    
│       │   └── route.ts       # Streaming chat endpoint (SSE)
│       └── 📂 ingest/
│           └── route.ts       # PDF ingestion with progress (SSE)
│
├── 📂 components/              # React Components
│   ├── theme-provider.tsx     # Dark/light theme context
│   ├── theme-toggle.tsx       # Theme switcher button
│   │
│   ├── 📂 chat/               # Chat UI components
│   │   ├── chat-interface.tsx # Main chat component with message list
│   │   ├── message-bubble.tsx # Individual message with citations
│   │   ├── source-citation.tsx# Citation badge/link component
│   │   └── index.ts           # Barrel export
│   │
│   ├── 📂 admin/              # Admin panel components
│   │   ├── user-management.tsx    # User CRUD table
│   │   ├── stats-cards.tsx        # Analytics cards
│   │   ├── activity-chart.tsx     # Activity visualization
│   │   ├── pdf-ingestion-tab.tsx  # PDF upload interface
│   │   ├── audit-logs.tsx         # Security event logs
│   │   ├── create-user-dialog.tsx # User creation modal
│   │   └── index.ts               # Barrel export
│   │
│   ├── 📂 dashboard/          # Main layout components
│   │   ├── header.tsx         # Top navigation bar
│   │   ├── sidebar.tsx        # Chat history sidebar
│   │   └── index.ts           # Barrel export
│   │
│   └── 📂 ui/                 # shadcn/ui components
│       ├── button.tsx         # Button variants
│       ├── input.tsx          # Form input
│       ├── card.tsx           # Card container
│       ├── dialog.tsx         # Modal dialog
│       ├── avatar.tsx         # User avatar
│       ├── badge.tsx          # Badge/tag
│       ├── textarea.tsx       # Multiline input
│       ├── scroll-area.tsx    # Custom scrollbar
│       └── separator.tsx      # Divider line
│
├── 📂 lib/                     # Core Business Logic
│   ├── auth.ts                # JWT generation, session management, password hashing
│   ├── rag.ts                 # Hybrid search, multi-query, RRF fusion
│   ├── agents.ts              # AI agents (classifier, expander, reranker, verifier, tree-reasoner)
│   ├── chat-pipeline.ts       # Centralized RAG orchestration
│   ├── citation-parser.ts     # Citation extraction and matching logic
│   ├── pdf-parser.ts          # PDF.js integration for text extraction
│   ├── pdf-ingestion.ts       # Chunking strategy and embedding generation
│   ├── gemini.ts              # LangChain Gemini client configuration
│   ├── supabase-server.ts     # Supabase client factory (service/anon)
│   ├── security.ts            # Input sanitization, rate limiting
│   ├── utils.ts               # Utility functions (cn, etc.)
│   ├── validations.ts         # Zod schemas for input validation
│   └── constants.ts           # Application constants
│
├── 📂 supabase/                # Database
│   ├── config.toml            # Supabase CLI configuration
│   └── 📂 migrations/
│       └── 001_complete_setup.sql # Complete database schema
│
├── 📂 test/                    # Vitest Tests
│   ├── setup.ts               # Test environment setup
│   ├── auth.test.ts           # Authentication tests (JWT, CSRF)
│   ├── rag.test.ts            # RAG pipeline tests
│   ├── agents.test.ts         # AI agents tests
│   ├── citation-parser.test.ts# Citation parsing tests
│   ├── validations.test.ts    # Input validation tests
│   └── admin.test.ts          # Admin functionality tests
│
├── 📂 types/                   # TypeScript Definitions
│   ├── index.ts               # Shared types (User, Session, Citation, etc.)
│   └── pdf-parse.d.ts         # PDF parsing library types
│
├── 📂 public/                  # Static Assets
│   └── (images, fonts, etc.)
│
├── 📄 Configuration Files
│   ├── package.json           # Dependencies and scripts
│   ├── tsconfig.json          # TypeScript configuration
│   ├── next.config.ts         # Next.js configuration
│   ├── tailwind.config.ts     # Tailwind CSS configuration
│   ├── postcss.config.mjs     # PostCSS configuration
│   ├── eslint.config.mjs      # ESLint rules
│   ├── vitest.config.ts       # Vitest test configuration
│   ├── components.json        # shadcn/ui configuration
│   ├── middleware.ts          # Next.js middleware (future use)
│   └── .env.local             # Environment variables (not in git)
│
└── 📄 README.md               # This file
```

---

## 🧪 Testing

Emirate Forge includes a comprehensive test suite with **110 passing tests** covering all critical functionality.

### Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm test -- --watch

# Run tests with UI
npm run test:ui

# Generate coverage report
npm run test:coverage
```

### Test Coverage

| Module | Tests | Coverage |
|--------|-------|----------|
| **Authentication** | 8 | JWT tokens, CSRF, password hashing, sessions |
| **RAG Pipeline** | 7 | Hybrid search, multi-query, query expansion |
| **AI Agents** | 18 | Topic classification, re-ranking, verification |
| **Tree Reasoning** | 20 | Query classification, tree reasoner, page ranges |
| **Citation Parser** | 19 | Extraction, matching, confidence scoring |
| **Input Validation** | 17 | Zod schemas, sanitization, edge cases |
| **Admin Functions** | 21 | User management, statistics |

### Test Files

```
test/
├── setup.ts               # Vitest configuration and global setup
├── auth.test.ts           # 8 tests - JWT, CSRF, password security
├── rag.test.ts            # 7 tests - Search, RRF, multi-query
├── agents.test.ts         # 18 tests - AI agent functionality
├── tree-reasoning.test.ts # 20 tests - Tree Reasoning, query classification
├── citation-parser.test.ts# 19 tests - Citation extraction/matching
├── validations.test.ts    # 17 tests - Zod schema validation
└── admin.test.ts          # 21 tests - Admin operations
```

---

## 📚 Documentation

### Tech Stack

#### Frontend
- **[Next.js 15.5](https://nextjs.org/)** - React framework with App Router and Server Actions
- **[React 18.3](https://react.dev/)** - UI library with Server Components
- **[Tailwind CSS 4.0](https://tailwindcss.com/)** - Utility-first CSS framework
- **[shadcn/ui](https://ui.shadcn.com/)** - Re-usable component library
- **[Lucide React](https://lucide.dev/)** - Icon library
- **[React Markdown](https://github.com/remarkjs/react-markdown)** - Markdown renderer

#### Backend
- **[TypeScript 5.0](https://www.typescriptlang.org/)** - Type-safe JavaScript
- **[Supabase](https://supabase.com/)** - PostgreSQL database and auth
- **[pgvector](https://github.com/pgvector/pgvector)** - Vector similarity search
- **[LangChain](https://js.langchain.com/)** - LLM orchestration framework
- **[Google Gemini 2.5 Flash](https://ai.google.dev/)** - LLM for chat and embeddings

#### Security & Validation
- **[jose](https://github.com/panva/jose)** - JWT implementation
- **[bcryptjs](https://github.com/dcodeIO/bcrypt.js)** - Password hashing
- **[Zod](https://zod.dev/)** - TypeScript-first schema validation
- **[isomorphic-dompurify](https://github.com/kkomelin/isomorphic-dompurify)** - XSS protection

#### PDF Processing
- **[PDF.js](https://mozilla.github.io/pdf.js/)** - PDF parsing and text extraction

#### Testing
- **[Vitest](https://vitest.dev/)** - Unit testing framework
- **[@testing-library/react](https://testing-library.com/react)** - React component testing
- **[jsdom](https://github.com/jsdom/jsdom)** - DOM implementation for Node.js

### API Reference

#### Server Actions

##### Authentication (`actions/auth.ts`)

```typescript
// Login user
async function loginAction(formData: FormData): Promise<ActionResponse>

// Logout user
async function logoutAction(): Promise<ActionResponse>

// Change password
async function changePasswordAction(data: {
  currentPassword: string;
  newPassword: string;
}): Promise<ActionResponse>
```

##### Chat (`actions/chat.ts`)

```typescript
// Send chat message (non-streaming)
async function sendChatMessage(request: {
  message: string;
  sessionId?: string;
}): Promise<{
  success: boolean;
  response?: string;
  citations?: Citation[];
  sessionId?: string;
}>
```

##### Chat History (`actions/chat-history.ts`)

```typescript
// Create new chat session
async function createChatSession(title?: string): Promise<string>

// Get user's chat sessions
async function getChatSessions(): Promise<ChatSession[]>

// Get messages from a session
async function getChatMessages(sessionId: string): Promise<ChatMessage[]>

// Delete a session
async function deleteChatSession(sessionId: string): Promise<void>
```

##### Admin (`actions/admin.ts`)

```typescript
// Get admin statistics
async function getAdminStats(): Promise<{
  totalUsers: number;
  activeUsers: number;
  totalQueries: number;
  totalChunks: number;
}>

// Create new user
async function adminCreateUser(data: {
  username: string;
  password: string;
  role: 'admin' | 'user';
}): Promise<ActionResponse>

// Block/unblock user
async function adminToggleUserBlock(userId: string): Promise<ActionResponse>
```

#### API Routes

##### Streaming Chat (`/api/chat/stream`)

```http
POST /api/chat/stream
Content-Type: application/json

{
  "message": "What are parking requirements for residential buildings?",
  "sessionId": "optional-session-uuid"
}

Response: text/event-stream
data: {"type":"token","content":"According to "}
data: {"type":"token","content":"Section "}
data: {"type":"citations","citations":[...]}
data: {"type":"done"}
```

##### PDF Ingestion (`/api/ingest`)

```http
POST /api/ingest

Response: text/event-stream
data: {"type":"progress","message":"Parsing PDF...","percent":10}
data: {"type":"progress","message":"Generating embeddings...","percent":50}
data: {"type":"complete","message":"Ingestion complete","chunksProcessed":1250}
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | ✅ | Your Supabase project URL |
| `SUPABASE_ANON_KEY` | ✅ | Supabase anonymous key (public) |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | Supabase service role key (private) |
| `GEMINI_API_KEY` | ✅ | Google Gemini API key |
| `JWT_SECRET` | ✅ | JWT signing secret (min 32 chars) |
| `NODE_ENV` | ❌ | Environment (development/production) |

---

## 🛣️ Roadmap

### ✅ Completed Features
- [x] Hybrid RAG with RRF fusion
- [x] **🌳 Tree Reasoning** - Structure-aware search (NEW!)
- [x] AI-powered re-ranking and query expansion
- [x] Smart citation system with confidence scoring
- [x] Real-time streaming responses
- [x] Admin dashboard with analytics
- [x] PDF ingestion pipeline
- [x] Comprehensive test suite (110 tests)
- [x] Enterprise security (JWT, RBAC, audit logs)
- [x] Dark/light theme support
- [x] Chat history and session management

### 🚧 In Progress
- [ ] Multi-document support (multiple building codes)
- [ ] Advanced analytics dashboard
- [ ] Email verification for new users
- [ ] API rate limiting with Redis

### 🔮 Planned Features
- [ ] OCR support for scanned PDFs
- [ ] Export chat history to PDF/Word
- [ ] Mobile app (React Native)
- [ ] Integration with BIM tools
- [ ] Collaborative features (shared sessions)
- [ ] Custom knowledge base upload
- [ ] Webhook notifications
- [ ] API for third-party integrations
- [ ] Multi-language support (Arabic, Hindi)
- [ ] Voice input/output capabilities

---

## 🤝 Contributing

Contributions are welcome! Please follow these steps:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Development Guidelines

- Write tests for new features
- Follow existing code style (ESLint + TypeScript)
- Update documentation as needed
- Ensure all tests pass before submitting PR

---

## 📄 License

MIT License © 2026 Makazhan Alpamys

See [LICENSE](./LICENSE) for more information.

---

## 👤 Author

**Makazhan Alpamys**

- GitHub: [@MakazhanAlpamys](https://github.com/MakazhanAlpamys)
- Email: makazanalpamys@gmail.com

---

## 🙏 Acknowledgments

- **Dubai Municipality** for the Building Code 2021 documentation
- **Google** for Gemini API
- **Supabase** for the amazing database platform
- **Vercel** for Next.js and hosting
- **shadcn** for the beautiful UI components

---

<div align="center">

**Built with ❤️ for the construction industry**

</div>