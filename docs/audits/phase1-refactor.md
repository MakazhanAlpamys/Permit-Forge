# Phase 1 — Refactor / Dead Code Review (2026-05-21)

Detection tools used: `npx knip --reporter compact`, `npx depcheck`, plus manual
grep-based verification of every flagged item. All paths are relative to the
project root.

---

## Critical

No dead code rises to the security/correctness-risk threshold. One structural
note below in **High** about `app/reset-password/` (empty route directory).

---

## High

### H-1: Empty route directory `app/reset-password/`

`app/reset-password/` exists as an empty folder — no `page.tsx`, no route file,
no files at all. The password-reset flow lives entirely inside
`app/forgot-password/page.tsx` as a multi-step form (`email → code → done`).
Nothing in the codebase navigates to `/reset-password`. The empty directory
confuses anyone reading the file tree and may create unexpected Next.js routing
behavior (Next.js 15 may emit a 404 or a build warning for a route segment with
no page).

**File:** `app/reset-password/` (empty directory, no `page.tsx`)

---

### H-2: `withMutation` is exported but never called in production code

`lib/security.ts` line 227 exports `withMutation`, described as "boilerplate-
elimination wrapper (F1 / Simplify #1)". The wrapper is only imported and
exercised in `test/with-mutation.test.ts`. Zero server actions or app routes
call it — every action uses the manual `requireAuth` / `requireCSRF` / try-catch
pattern instead. The abstraction exists but was never migrated to.

**Files:** `lib/security.ts:227`, `test/with-mutation.test.ts`

---

### H-3: `logAuditWithMeta` wrapper adopted in only one of five affected files

`lib/auth.ts:306` exports `logAuditWithMeta` specifically to eliminate the
repeated two-step `getRequestMetadata + logAuditEvent` dance. The commit message
says "removes ~25 occurrences". However only `actions/admin.ts` actually uses it
(6 calls). The remaining 24 `const metadata = await getRequestMetadata()`
occurrences survive across:

- `actions/admin-permits.ts:126`
- `actions/auth.ts:64,212,244,404,520`
- `actions/documents.ts:141,228,396`
- `actions/ingest-pdf.ts:56,93`
- `actions/permit-attachments.ts:153,234`
- `actions/permits.ts:79,317,576,691,760`
- `actions/profile.ts:90,218,280`
- `app/api/admin/documents/upload/route.ts:53`
- `app/api/permits/[id]/certificate/route.ts:150`
- `lib/security.ts:110`

This is a partially-applied refactor that reduces readability (two patterns for
the same operation) and maintenance burden (adding a new audit field requires
editing both patterns).

---

### H-4: `actions/documents.ts` — `@deprecated uploadDocumentPDF` still exported

`actions/documents.ts:371` marks `uploadDocumentPDF` as `@deprecated` with
the note "prefer POST /api/admin/documents/upload". The UI already uses the API
route (`components/admin/document-management.tsx:219`). Only test code imports
the deprecated function (`test/documents-actions.test.ts:103`). The shim serves
no live production caller but the `@deprecated` tag means the tests are covering
dead code paths.

**File:** `actions/documents.ts:365–410`

---

### H-5: `detectQueryType` is exported but never called outside `lib/agents.ts`

`lib/agents.ts:117` exports `detectQueryType`. The chat pipeline
(`lib/chat-pipeline.ts`) does not import it; it only uses `classifyQueryStructure`
(which internally calls `detectQueryType` as a private helper at line 185). The
only external consumers are test files. If `detectQueryType` is not part of the
intended public API of `lib/agents.ts`, it should not be exported.

**File:** `lib/agents.ts:117`

---

## Medium

### M-1: `lib/cookie-options.ts` — `devInsecureCookiesEnabled()` is exported but not called externally

`lib/cookie-options.ts:18` exports `devInsecureCookiesEnabled()`. Its only
callers are `secureCookieDefaults()` (same file, line 27) and `middleware.ts`
(which re-implements the same `process.env.NEXT_PUBLIC_DEV_INSECURE_COOKIES === '1'`
check inline at line 66 rather than calling the exported helper). The export is
not consumed outside the module in production paths. `middleware.ts` duplicates
the check verbatim instead of importing the function.

**Files:** `lib/cookie-options.ts:18`, `middleware.ts:66`

---

### M-2: `lib/auth.ts` — `getSessionFromToken` is exported but its only caller is the private `getQuickSession` in the same file

`lib/auth.ts:130` exports `getSessionFromToken`. The function is called
internally at line 153 by `getQuickSession`. No external file imports
`getSessionFromToken` — every external caller uses `getQuickSession` directly.
The export is unnecessary unless it is part of a planned public API.

**File:** `lib/auth.ts:130`

---

### M-3: `lib/auth.ts` — `User` interface is exported but never imported externally

`lib/auth.ts:37` exports `interface User`. No file outside `lib/auth.ts` imports
or uses this type (confirmed by grep; the `User` icon from `lucide-react` in
`components/chat/message-bubble.tsx` is unrelated). All callers work with the
inline `TokenUser` shape or the `JWTPayload` type from `lib/validations.ts`.

**File:** `lib/auth.ts:37`

---

### M-4: `lib/transforms.ts` — `snakeToCamel` is exported but never imported

`lib/transforms.ts:32` exports `snakeToCamel<T>`. No file outside
`lib/transforms.ts` imports it. `numOrZero`, `PermitRow`, and `transformPermit`
are all actively used. `snakeToCamel` was the "80% case" generic helper mentioned
in the comment but no caller was ever added.

**File:** `lib/transforms.ts:32`

---

### M-5: `lib/validations.ts` — Ten inferred `Input` types exported but never consumed outside the file

The following `type` aliases exist only in `lib/validations.ts` and are not
imported by any action, component, or test file:

- `ChatMessageInput` (line 70)
- `LoginInput` (line 87)
- `RegisterInput` (line 106)
- `VerifyEmailInput` (line 117)
- `ForgotPasswordInput` (line 127)
- `ResetPasswordInput` (line 139)
- `UpdateProfileInput` (line 155)
- `CreateUserInput` (line 171)
- `PaginationInput` (line 205)
- `ComplianceCheckJsonInput` (line 344)

Actions parse their input with the schema directly and inline the result type;
none of them need the named alias. These types add noise to the module's public
API without being used.

**File:** `lib/validations.ts:70,87,106,117,127,139,155,171,205,344`

---

### M-6: `lib/validations.ts` — `buildingDetailsPartialSchema` exported but only consumed internally

`lib/validations.ts:229` exports `buildingDetailsPartialSchema`. Its only
external use is as an argument to `updateBuildingDetailsSchema` at line 268
(same file). The partial schema is not imported in any action, component, or
test file directly.

**File:** `lib/validations.ts:229`

---

### M-7: `types/index.ts` — Three exported interfaces have zero external consumers

- `SemanticCacheEntry` (line 93): defined and exported; never imported. The
  semantic cache module (`lib/semantic-cache.ts`) works with inline types.
- `ComplianceCheckReference` (line 270): defined and used only internally within
  `types/index.ts` as a field type on `ComplianceCheckItem` (line 280). Not
  imported externally. An equivalent `complianceCheckReferenceObjectSchema` exists
  in `lib/validations.ts`.
- `PermitCertificate` (line 383): defined and exported; never imported anywhere.
  The certificate route and generator do not use this type.

**File:** `types/index.ts:93,270,383`

---

### M-8: Barrel re-export files expose dead exports

`components/chat/index.ts` re-exports `MessageBubble`, `LoadingMessage`,
`StreamingMessage`, and `CitationsList`. The only import site for the barrel
(`app/page.tsx:9`) only destructures `ChatInterface`, making the other four
re-exports dead at the module boundary. Same pattern in
`components/permits/index.ts`: `PermitCard` and `PermitStatusBadge` are re-
exported from the barrel but every consumer that needs them imports directly from
the component file, not from the barrel.

Knip confirms these as unused exports at the barrel level. The components
themselves are used (via direct file imports), so the components are not dead —
only the barrel exports are excess.

**Files:** `components/chat/index.ts:3–4`, `components/permits/index.ts:2,7`

---

### M-9: `components/ui/button.tsx` — `buttonVariants` exported but not used outside the file

`components/ui/button.tsx:7` defines and exports `buttonVariants`. The exported
name is not imported in any component or page — all callers use the `<Button>`
component. `buttonVariants` would be useful for composing button-like links
(e.g. `<Link className={buttonVariants({...})}>`) but no such usage exists.

**File:** `components/ui/button.tsx:62`

---

### M-10: `components/ui/card.tsx` — `CardFooter` and `CardAction` exported but not used

`CardFooter` (line 74) and `CardAction` (line 51) are exported from
`components/ui/card.tsx` but no component or page imports either of them.
`CardHeader`, `CardTitle`, `CardDescription`, and `CardContent` are all
actively used.

**File:** `components/ui/card.tsx:51,74`

---

### M-11: `hooks/use-ingestion-stream.ts` — `IngestionStatus` and `IngestionProgressInfo` are exported types with no external consumer

`hooks/use-ingestion-stream.ts` exports `IngestionStatus` (line 15) and
`IngestionProgressInfo` (line 17). Neither type is imported outside the hook
file — `document-management.tsx` calls `setIngestionStatus()` and works with the
return value structurally, never referencing the named types.

**File:** `hooks/use-ingestion-stream.ts:15,17`

---

### M-12: `hooks/use-chat-stream.ts` — `ChatStreamCallbacks` is exported but not imported externally

`hooks/use-chat-stream.ts:14` exports `ChatStreamCallbacks`. The interface is
used internally by the hook. No component or test imports the type by name.

**File:** `hooks/use-chat-stream.ts:14`

---

### M-13: `lib/pdf-ingestion.ts` — `ProgressCallback` is exported but unused externally

`lib/pdf-ingestion.ts:53` exports `type ProgressCallback`. The type is used
extensively within the file for internal function signatures but is never
imported by any action or test. The ingest action creates a `sendProgress`
function inline with the type inferred; no caller needs to name the type.

**File:** `lib/pdf-ingestion.ts:53`

---

### M-14: `components/ui/input.tsx` — `InputProps` exported but never imported

`components/ui/input.tsx:10` exports `type InputProps`. No component or action
imports this type. The `Input` component itself is consumed via JSX, not via the
type alias.

**File:** `components/ui/input.tsx:10`

---

### M-15: Deleted migration files (001–023) are still referenced by inline comments in `000_full_setup.sql`

The git status at the start of the session showed 001–023 migration files staged
for deletion (they were consolidated into `000_full_setup.sql` in commit
`f579e25`). Those files no longer exist on disk. However, `000_full_setup.sql`
contains block comments of the form `-- ---- 001_add_pdf_hash.sql ----` (line
2183), `-- ---- 002_add_ingestion_state.sql ----` (line 2206), etc., through
`023`. These comments reference files that no longer exist, which is confusing
for anyone reading the consolidated migration.

**File:** `supabase/migrations/000_full_setup.sql:2183+` (23 section-header
comments referencing deleted files)

---

## Low

### L-1: `lib/chat-pipeline.ts` — `classifyUserTopic` is a re-export added for "backward compatibility" with no evidence of a previous API

`lib/chat-pipeline.ts:18–19` re-exports `classifyTopic` from `lib/agents` under
the alias `classifyUserTopic` with a comment "Re-export classifyTopic for
backward compatibility". The git history shows the rename originated in the same
PR as the pipeline refactor; there is no prior stable API to be compatible with.
The alias causes two different names (`classifyTopic` in tests, `classifyUserTopic`
in the stream route) for the same function with no benefit.

**File:** `lib/chat-pipeline.ts:18–19`

---

### L-2: `app/api/chat/stream/route.ts` imports from `lib/chat-pipeline` instead of `lib/agents` for `classifyUserTopic`

Related to L-1. The stream route imports `classifyUserTopic` from the pipeline
module, not from `lib/agents` where the function actually lives. This
indirection through the re-export makes the dependency graph harder to follow.

**File:** `app/api/chat/stream/route.ts:9`

---

### L-3: `NEXT_PUBLIC_DEV_INSECURE_COOKIES` env var has an inconsistent usage pattern

`lib/cookie-options.ts:18` exports a `devInsecureCookiesEnabled()` function to
centralize reading this env var. `middleware.ts:66` re-reads the same variable
inline as `process.env.NEXT_PUBLIC_DEV_INSECURE_COOKIES === '1'` rather than
calling the exported helper. If the flag ever changes name or logic, both call
sites must be updated.

**Files:** `lib/cookie-options.ts:18`, `middleware.ts:66`

(Note: the `NEXT_PUBLIC_` prefix security concern is already documented in
`docs/audits/phase1-security.md:S-H-5`; this is purely a duplication
observation.)

---

### L-4: `actions/documents.ts` — `@deprecated uploadDocumentPDF` still has full test coverage in `test/documents-actions.test.ts`

Eight test cases (lines 343–428) cover the deprecated `uploadDocumentPDF` action.
When the shim is eventually removed, these tests will need to be deleted or
migrated to the API route test in `test/api-routes.test.ts`.

**File:** `test/documents-actions.test.ts:340–428`

---

### L-5: `components/ui/card.tsx` also exports `CardDescription` — used in only two places via the forgot-password and chat forms

Not dead, but worth noting: `CardDescription` is used in only
`app/forgot-password/page.tsx` and `components/admin/create-user-dialog.tsx`.
This is low risk but indicates the `Card` primitive set has very narrow adoption.

*Not flagged as dead code — just low usage.*

---

### L-6: `lib/agents.ts` comment says "Removed: expandQuery, rerankChunks, verifyAnswer" but does not reflect `detectQueryType` is now effectively internal-only

The file-level comment at line 3 lists `detectQueryType` under "Kept" alongside
the functions that are actively part of the external API. Since `detectQueryType`
is called only from within `agents.ts` (at line 185 inside
`classifyQueryStructure`) and from test files, the comment overstates its
external relevance.

**File:** `lib/agents.ts:4`

---

### L-7: `test/migration-grants.test.ts` reads the migration file by filesystem path — tightly coupled to the single-file structure

`test/migration-grants.test.ts:9` hardcodes the path
`'../supabase/migrations/000_full_setup.sql'`. If the migration is ever split
back into individual files or renamed, all 222 lines of grant-verification tests
will silently pass on a stale read (they test a cached string). This is a test
fragility concern, not dead code, but it emerged from the migration consolidation.

**File:** `test/migration-grants.test.ts:9`

---

## Unused Dependencies

### npm `dependencies`

| Package | Verdict |
|---------|---------|
| `@paper-design/shaders` | **Unused.** Only `@paper-design/shaders-react` is imported (`components/login/dithering-background.tsx:4`). The base `@paper-design/shaders` package is never directly imported. Both `knip` and `depcheck` independently flag it. |

### npm `devDependencies`

| Package | Verdict |
|---------|---------|
| `@types/bcryptjs` | **Redundant.** `bcryptjs` v3 ships its own `index.d.ts` and `types.d.ts` (confirmed by inspecting `node_modules/bcryptjs/`). The `@types/bcryptjs` package duplicates these type definitions. Knip flags it. |
| `eslint-config-next` | **False positive — actually used.** `eslint.config.mjs:13` extends `"next/core-web-vitals"` and `"next/typescript"` via `FlatCompat`. These are provided by `eslint-config-next`. Both `knip` and `depcheck` flag it because they don't trace the string-based `compat.extends()` call, but removing it would break linting. **Do not remove.** |
| `@tailwindcss/postcss` | **False positive — actually used.** `postcss.config.mjs:3` registers it as a PostCSS plugin. `depcheck` flags it because it only scans JS/TS imports, not PostCSS config files. **Do not remove.** |
| `tailwindcss` | **False positive — actually used.** Required by `@tailwindcss/postcss`. **Do not remove.** |
| `tw-animate-css` | **False positive — actually used.** `app/globals.css:2` imports it as `@import "tw-animate-css"`. `depcheck` cannot trace CSS imports. **Do not remove.** |
| `typescript` | **False positive.** Required by the TypeScript compiler and all type-checking. **Do not remove.** |
| `@vitest/coverage-v8` | **False positive.** Used by `npm run test:coverage` via `vitest run --coverage`. `depcheck` flags it because it is a vitest plugin, not a direct import. **Do not remove.** |

---

## Duplicated Logic

### D-1: Cookie security flag read in two places with different patterns

`lib/cookie-options.ts:18–19` provides `devInsecureCookiesEnabled()` as the
canonical way to check `NEXT_PUBLIC_DEV_INSECURE_COOKIES`. `middleware.ts:66`
duplicates the raw `process.env.NEXT_PUBLIC_DEV_INSECURE_COOKIES === '1'` check
instead of importing the helper. One source of truth exists; the middleware
ignores it.

**Files:** `lib/cookie-options.ts:18`, `middleware.ts:66`

---

### D-2: `getRequestMetadata + logAuditEvent` two-step duplicated 24 times vs. `logAuditWithMeta` wrapper

See H-3. This is the most impactful duplication — 24 instances of
```ts
const metadata = await getRequestMetadata();
await logAuditEvent({ userId, action, ..., ...metadata });
```
vs. the `logAuditWithMeta(userId, action, extras)` wrapper that already exists.

---

### D-3: `canPerformOperation` vs `isOperationAllowed` — two wrappers for the same state-machine check

`lib/permit-state-machine.ts` exports both `canPerformOperation` (line 59,
returns `{ allowed: boolean; reason?: string }`) and `isOperationAllowed`
(line 71, returns `boolean`). Server actions import `canPerformOperation`;
`app/permits/[id]/page.tsx:210` uses `isOperationAllowed`. Both functions check
the same `ALLOWED_FROM` table. The two names serve different return-type needs
but both are called in production and both must be maintained if the state machine
changes.

This is a design choice, not strictly dead code — but callers should be
consistent, and `isOperationAllowed` duplicates the predicate of
`canPerformOperation.allowed`.

**File:** `lib/permit-state-machine.ts:59,71`

---

### D-4: `ComplianceCheckReference` defined twice (type alias and Zod schema)

`types/index.ts:270` defines `ComplianceCheckReference` as a TypeScript
interface. `lib/validations.ts:317` defines `complianceCheckReferenceObjectSchema`
as a Zod object with identical fields (`page`, `section`, `excerpt`). These two
definitions must be kept in sync manually. The `ComplianceCheckReference` type
is never externally imported (see M-7), so it could be replaced by
`z.infer<typeof complianceCheckReferenceObjectSchema>`.

**Files:** `types/index.ts:270`, `lib/validations.ts:317`

---

## Stale / Orphan Files

### O-1: `app/reset-password/` — orphan empty directory

No files. No route. No navigation target. (See H-1.)

**Path:** `app/reset-password/`

---

## Unused Environment Variables

The following environment variables appear in `process.env` reads found across
the codebase but are supplied exclusively by third-party library internals (LangChain, Google Auth Library, etc.) bundled via `node_modules`. They are not defined by the application and require no `.env.local` entry:

- `AZURE_OPENAI_*` — LangChain's Azure OpenAI adapter reads these
- `OPENAI_API_KEY` — LangChain internals
- `LANGSMITH_API_KEY` — LangSmith tracing (optional LangChain feature)
- `UPSTASH_REDIS_*` — mentioned in LangChain adapter; not used by app code
- `BOOK_LANG`, `ICEBERG_TOKEN`, `MY_TRACER_ENABLED`, `METADATA_SERVER_DETECTION` — internal to google-auth-library or LangChain

These are noise from `node_modules` scanning and do not need to be added to `.env.local` or documented.

`SUPABASE_JWT_SECRET` — referenced in `lib/supabase-server.ts:108` for the
optional `createUserContextClient` path (RLS via user JWT). This feature is
wired up in the code but the env var is documented as a prerequisite that is
not yet configured in any environment, making `createUserContextClient` a
dead code path until it is set.

**File:** `lib/supabase-server.ts:96–135`
