# Rebranding Plan: Emirate Forge -> PermitForge

## Summary

Rename "Emirate Forge" to "PermitForge" everywhere. Remove all Dubai/Emirate-specific references from code, prompts, and UI. Make the system generic -- not tied to any city or country. Update certificate prefix from `EF-CERT` to `PF-CERT`. Replace sidebar Resources with "Coming soon". Update README.

---

## Phase 1: Core Identity (package + metadata)

| File | Change |
|------|--------|
| `package.json` | `"name": "emirate-forge"` -> `"permitforge"` |
| `package-lock.json` | Regenerate after package.json change (`npm install`) |
| `app/layout.tsx` | Title: "PermitForge - Building Code Compliance Assistant", author: "PermitForge", remove "Dubai" from description/keywords |

## Phase 2: Frontend Branding (UI text)

| File | Line(s) | Change |
|------|---------|--------|
| `app/login/page.tsx` | 53, 63 | alt="PermitForge", "Sign in to PermitForge" |
| `app/admin/page.tsx` | 159 | "Emirate Forge" -> "PermitForge" |
| `components/dashboard/header.tsx` | 43 | alt="PermitForge" |
| `components/dashboard/sidebar.tsx` | 341-420 | Replace Resources section (5 hardcoded links) with single "Coming soon" message |
| `components/dashboard/sidebar.tsx` | 427 | "Dubai Building Codes" -> "Building Codes" |
| `components/chat/chat-interface.tsx` | 507 | placeholder: remove "Dubai" -> "Ask about building code compliance..." |
| `components/chat/chat-interface.tsx` | 537 | "Emirate Forge provides guidance based on Dubai Building Code 2021" -> "PermitForge provides guidance based on your ingested building codes." |
| `components/chat/chat-interface.tsx` | 568 | Remove Dubai-specific sample question, use generic |
| `components/chat/chat-interface.tsx` | 591 | "Dubai Building Code Assistant" -> "Building Code Assistant" |
| `components/chat/chat-interface.tsx` | 594 | Remove "Dubai" from description text |
| `components/chat/message-bubble.tsx` | 220 | "Analyzing Dubai Building Code..." -> "Analyzing building codes..." |
| `components/chat/source-citation.tsx` | 218-219 | Remove hardcoded Dubai PDF filename mappings |
| `components/admin/pdf-ingestion-tab.tsx` | 209 | "across multiple Dubai building codes" -> "across multiple building codes" |
| `components/admin/document-management.tsx` | 81, 447, 474 | Remove "Dubai Municipality" defaults and placeholders |
| `components/permits/permit-form-step1.tsx` | 73 | placeholder: remove "Dubai" -> "e.g., Plot 123, District 1" |
| `components/permits/permit-form-step3.tsx` | 53, 107 | "Dubai Building Code 2021" -> "the building code" |
| `app/permits/page.tsx` | 78 | "Dubai Building Code permit applications" -> "building code permit applications" |

## Phase 3: AI Prompts & Pipeline (make generic)

| File | Line(s) | Change |
|------|---------|--------|
| `lib/gemini.ts` | 203-219 | `COMPLIANCE_SYSTEM_PROMPT`: "You are Emirate Forge, a Dubai construction compliance assistant" -> "You are PermitForge, a building code compliance assistant". Remove hardcoded document list (lines 206-209). Remove "Dubai" from rule #7. Make prompt generic. |
| `lib/chat-pipeline.ts` | 68, 74, 77, 84, 87 | All responses: "Emirate Forge" -> "PermitForge", "Dubai construction" -> "building code", remove "in Dubai" |
| `lib/agents.ts` | 12, 15, 21, 47 | Topic classifier: "Dubai Building Code 2021 assistant" -> "building code compliance assistant", remove "Dubai/UAE" |
| `lib/permit-compliance.ts` | 3, 87, 164 | Remove all "Dubai Building Code" -> "building code" |

## Phase 4: Backend & Utilities

| File | Line(s) | Change |
|------|---------|--------|
| `lib/permit-certificate.ts` | 31, 79, 199 | `EF-CERT` -> `PF-CERT`, "EMIRATE FORGE" -> "PERMITFORGE" |
| `lib/notifications.ts` | 59, 152, 153, 160, 164 | "Emirate Forge" -> "PermitForge", email from address, "Dubai Building Code Compliance" -> "Building Code Compliance" |
| `lib/constants.ts` | 2 | Comment: "Emirate Forge" -> "PermitForge" |
| `lib/rag.ts` | 131, 137, 218, 232, 323 | Rename `queryDubaiCode` -> `queryBuildingCode`, `queryDubaiCodeFiltered` -> `queryBuildingCodeFiltered`. Fallback label: "Building Code" |
| `app/api/chat/export/route.ts` | 61, 80 | "Emirate Forge" -> "PermitForge", remove "Dubai" |
| `actions/documents.ts` | 121, 138 | Default authority: "Dubai Municipality" -> "" |
| `types/index.ts` | 2 | Comment update |

## Phase 5: Tests

| File | Change |
|------|--------|
| `test/rag.test.ts` | Update mock data and function names to match Phase 4 renames |
| `test/chat-pipeline.test.ts` | Update mock names: `mockQueryDubaiCode` -> `mockQueryBuildingCode`, mock data |
| `test/api-chat-stream.test.ts` | Update any Dubai/Emirate references |
| `test/validations.test.ts` | "Dubai Building Code" -> "Building Code" in test message |
| `test/permits-actions.test.ts` | "Dubai Street, Dubai" -> "123 Main Street" |

## Phase 6: Documentation

| File | Change |
|------|--------|
| `README.md` | Full rewrite: "Emirate Forge" -> "PermitForge", remove all "Dubai" references, Resources section -> "Coming soon", update clone URL, generic project description |
| `CLAUDE.md` | Update project description, all Dubai references, EF-CERT -> PF-CERT, function names |
| `supabase/migrations/000_full_setup.sql` | Comment: "Emirate Forge" -> "PermitForge" |

## Phase 7: Verify

1. `npm run lint` -- no errors
2. `npm test` -- all tests pass
3. `npm run build` -- successful build
4. Grep for remaining "Dubai", "Emirate", "EF-CERT" references

---

## NOT Changed (intentional)

- **Database table/column names** (`dubai_code_chunks`, etc.) -- renaming would break production DB
- **RPC function names** (`match_dubai_code`, `match_dubai_code_hybrid`, etc.) -- would require DB migration
- **Logo SVGs** -- already updated by user
- **Git repo folder name** -- user's local choice
