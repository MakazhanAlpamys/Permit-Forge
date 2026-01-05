# Emirate Forge - Dubai Building Code Compliance Assistant

## 📋 Project Overview

**Emirate Forge** is an AI-powered compliance assistant for the Dubai Building Code 2021. The application uses **RAG (Retrieval-Augmented Generation)** technology to provide accurate, citation-backed answers to building code questions in multiple languages.

### Key Features
- 🤖 **AI-Powered Compliance Analysis** - Gemini 2.5 Flash for intelligent responses
- 📚 **RAG System** - Vector search through Dubai Building Code 2021 PDF
- 🌍 **Multilingual Support** - Automatic language detection (English, Russian, Arabic, etc.)
- 💬 **Chat History** - Persistent conversation sessions with Supabase
- 🔐 **Role-Based Authentication** - Admin and User roles with secure session management
- 📊 **Admin Dashboard** - PDF ingestion pipeline with diagnostics
- 🎨 **Modern UI** - Dark/Light mode with responsive design

---

## 🏗️ Architecture

### Tech Stack
- **Framework**: Next.js 15 (App Router)
- **Language**: TypeScript 5
- **Database**: Supabase (PostgreSQL + pgvector)
- **AI/ML**: Google Gemini 2.5 Flash + LangChain
- **Styling**: Tailwind CSS 4 + Radix UI
- **Authentication**: Custom session-based auth
- **Vector Embeddings**: Gemini text-embedding-004 (768 dimensions)

### Project Structure
```
permitai/
├── app/                      # Next.js App Router
│   ├── layout.tsx           # Root layout with theme provider
│   ├── page.tsx             # Main dashboard (user chat)
│   ├── admin/page.tsx       # Admin PDF ingestion panel
│   └── login/page.tsx       # Authentication page
├── actions/                  # Server Actions
│   ├── auth.ts              # Login/logout/create user
│   ├── chat.ts              # RAG + Gemini chat handler
│   ├── chat-history.ts      # Session & message persistence
│   └── ingest-pdf.ts        # PDF chunking + embedding generation
├── components/               # React Components
│   ├── chat/                # Chat UI components
│   ├── dashboard/           # Dashboard components
│   ├── ui/                  # Radix UI primitives
│   ├── theme-provider.tsx   # Dark/light mode context
│   └── theme-toggle.tsx     # Theme switcher
├── lib/                      # Core Libraries
│   ├── auth.ts              # Session management
│   ├── gemini.ts            # Gemini API wrapper (LangChain)
│   ├── rag.ts               # Vector search (LangChain)
│   ├── supabase.ts          # Database client
│   └── utils.ts             # Utility functions
├── supabase/migrations/      # Database schema
│   └── full_setup.sql       # Complete DB setup script
├── scripts/                  # CLI Tools
│   └── create-user.ts       # User creation script
├── types/                    # TypeScript definitions
│   ├── index.ts             # Shared types
│   └── pdf-parse.d.ts       # pdf-parse module declarations
├── middleware.ts             # Auth middleware (route protection)
└── public/                   # Static assets
    ├── white-icon.svg       # Logo (dark mode)
    ├── black-icon.svg       # Logo (light mode)
    └── dubai-code.pdf       # Building code document (ingested)
```

---

## 🔄 Data Flow

### 1. PDF Ingestion Pipeline (Admin)
```
PDF Document → pdf-parse → LangChain TextSplitter → Chunks (1000 chars, 200 overlap)
    ↓
Gemini text-embedding-004 → 768-dim vectors → Supabase dubai_code_chunks table
```

### 2. User Query Flow (Chat)
```
User Message → Rate Limiter → Language Detection
    ↓
Gemini Embeddings → Vector Similarity Search (Supabase RPC: match_dubai_code)
    ↓
Top 5 Chunks (>70% similarity) → TOON Format Context → Gemini 2.5 Flash
    ↓
Compliance Analysis + Citations → Save to chat_messages → Display to User
```

### 3. Authentication Flow
```
Login Form → bcrypt.compare → Supabase users table → Create Session Cookie
    ↓
Middleware → Check Session → Redirect by Role (admin → /admin, user → /)
```
```

---

## 🗄️ Database Schema

### Tables
1. **dubai_code_chunks** - RAG vector store
   - `id`: Primary key
   - `content`: Text chunk
   - `metadata`: JSONB (page, section, chapter)
   - `embedding`: VECTOR(768) - Gemini embeddings
   - Index: IVFFlat for cosine similarity

2. **users** - Authentication
   - `id`: UUID
   - `username`: Unique
   - `password_hash`: bcrypt (12 rounds)
   - `role`: 'admin' | 'user'
   - `last_login`: Timestamp

3. **chat_sessions** - Conversation tracking
   - `id`: UUID
   - `user_id`: Foreign key to users
   - `title`: Session name
   - `updated_at`: Auto-updated on new messages

4. **chat_messages** - Message history
   - `id`: UUID
   - `session_id`: Foreign key to chat_sessions
   - `role`: 'user' | 'assistant'
   - `content`: Message text
   - `citations`: JSONB array
   - `compliance_status`: 'compliant' | 'non-compliant' | 'pending'

### RPC Functions
- **match_dubai_code(query_embedding, match_count, filter)** - Vector similarity search

---

## 🚀 Setup Instructions

### Prerequisites
- Node.js 20+
- Supabase account
- Google Gemini API key

### Environment Variables
Create `.env.local`:
```env
NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
GEMINI_API_KEY=your_gemini_api_key
```

### Installation
```bash
# Install dependencies
npm install

# Run database migration (in Supabase SQL Editor)
# Copy contents of supabase/migrations/full_setup.sql

# Place Dubai Building Code PDF
# Save as: public/dubai-code.pdf

# Run development server
npm run dev
```

### Default Users
Created automatically by migration:
- **Admin**: username=`admin`, password=`admin123` → Redirects to `/admin`
- **User**: username=`user`, password=`user123` → Redirects to `/` (chat)

### Creating Additional Users
Use the user creation script to add new users:

```bash
npx tsx --env-file=.env.local scripts/create-user.ts
```

**Example - Creating a Regular User:**
```
Username: user
Password: user123
Full Name (optional): username
Role (admin/user, default: user): user

✅ User created successfully!
   ID: 26328a63-631f-4172-9d2d-2bbb36654a33
   Username: user
   Role: user
```

**Example - Creating an Admin:**
```
Username: admin
Password: admin123
Full Name (optional): adminname
Role (admin/user, default: user): admin

✅ User created successfully!
   ID: 491d3ef9-b910-488b-a97d-2b98ca7f1950
   Username: admin
   Role: admin
```

### Admin Panel Tasks
1. Navigate to `/admin`
2. Click "Ingest PDF" to process `public/dubai-code.pdf`
3. Wait for completion (shows chunk count)
4. Verify "System Diagnostics" shows green checkmarks

---

## 📊 Technical Decisions

### Why LangChain?
- **SupabaseVectorStore** - Simplified vector search integration
- **RecursiveCharacterTextSplitter** - Intelligent text chunking
- **GoogleGenerativeAIEmbeddings** - Native Gemini support

### Why TOON Format?
- **Token Efficiency** - 40% reduction vs JSON for context
- Converts chunks array to compact tabular notation
- Example: `chunks[3]{id,page,content}: 1,71,"text"...`

### Rate Limiting Strategy
- **Min 2 seconds** between requests (prevent spam)
- **Max 10 requests/minute** per client
- In-memory store (use Redis in production)

### Security Measures
- bcrypt password hashing (12 rounds)
- HTTP-only session cookies
- Service role key for admin operations
- Middleware-based route protection

---

##  API Reference

### Server Actions

#### `actions/chat.ts`
```typescript
sendChatMessage(request: ChatRequest): Promise<ChatResponse>
// Rate-limited chat handler with RAG + Gemini
```

#### `actions/auth.ts`
```typescript
loginAction(formData: FormData): Promise<{error?: string}>
logoutAction(): Promise<void>
createUserAction(data): Promise<{success: boolean; error?: string}>
```

#### `actions/chat-history.ts`
```typescript
createChatSession(title?: string): Promise<{sessionId: string | null}>
saveMessageToSession(params): Promise<{success: boolean}>
getChatSessions(): Promise<{sessions: ChatSession[]}>
getSessionMessages(sessionId): Promise<{messages: ChatMessage[]}>
deleteChatSession(sessionId): Promise<{success: boolean}>
```

#### `actions/ingest-pdf.ts`
```typescript
ingestPDF(): Promise<IngestionResult>
clearChunks(): Promise<{success: boolean}>
getIngestionStatus(): Promise<{hasChunks, chunkCount, dbConnected}>
testRAGQuery(): Promise<{success, chunksFound}>
```

### Core Libraries

#### `lib/gemini.ts`
```typescript
generateEmbedding(text: string): Promise<number[]>
generateChatResponse(options: GeminiChatOptions): Promise<string>
```

#### `lib/rag.ts`
```typescript
queryDubaiCode(params: RAGQuery): Promise<RAGResult>
// Returns chunks + TOON-formatted context
```

#### `lib/auth.ts`
```typescript
hashPassword(password: string): Promise<string>
verifyPassword(password: string, hash: string): Promise<boolean>
createSession(userId: string): Promise<string>
getSession(): Promise<User | null>
destroySession(): Promise<void>
```

---

## 🧪 Testing

### Manual Testing Checklist
- ✅ Login flow (admin/user roles)
- ✅ PDF ingestion pipeline
- ✅ Vector search accuracy
- ✅ Multilingual chat (EN/RU/AR)
- ✅ Chat history persistence
- ✅ Rate limiting (10 req/min)
- ✅ Dark/light mode switching
- ✅ Mobile responsiveness

### Future: Automated Tests
```bash
# To be implemented
npm run test       # Unit tests
npm run test:e2e   # Playwright E2E tests
```

---

## 📄 License

Proprietary - Emirate Forge Team

---

## 🤝 Contributing

Internal project - contact maintainers for access.

---

## 🐛 Known Limitations

1. **In-Memory Rate Limiting** - Use Redis for production
2. **No Email Verification** - Users created manually via script
3. **PDF Path Hardcoded** - `public/dubai-code.pdf` must exist
4. **No Audit Logs** - User actions not tracked

---

## 🚀 Deployment

### Environment Setup
1. Set environment variables in production host
2. Run Supabase migration: `supabase/migrations/full_setup.sql`
3. Upload `dubai-code.pdf` to `/public`
4. Run ingestion via Admin panel

### Build Commands
```bash
npm run build     # Production build
npm run start     # Production server
```

---

**Last Updated**: January 5, 2026  
**Version**: 0.1.0  
**Maintainer**: Emirate Forge Development Team
