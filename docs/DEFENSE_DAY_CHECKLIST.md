# Defense-Day Smoke Checklist (v1.10.0 Part B)

> Pre-defense steps that need a real Supabase project + Gemini quota — they
> cannot be exercised from the test harness. Run this list end-to-end ~24 h
> before defense; investigate any red box before the live demo.

---

## 0. Environment preflight

- [ ] `.env.local` populated with all required keys (`NEXT_PUBLIC_SUPABASE_URL`,
      `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY`,
      `JWT_SECRET ≥ 64 chars`). Optional: `SMTP_*` if showing email flows.
- [ ] `npm ci` — clean install matches `package-lock.json`
- [ ] `npm run lint && npx tsc --noEmit && npx vitest run --pool forks` — green
- [ ] `npm run build` — green; no new bundle warnings
- [ ] Confirm Gemini API quota: at least 50 embedding + 20 chat completions
      headroom for the demo session
- [ ] Confirm Supabase project is on the right plan (semantic_cache HNSW index
      build is sub-second on free tier; tree-cache pruning is sub-second too)

## 1. Database reset to known seed

- [ ] Run `supabase/migrations/000_full_setup.sql` against the demo project
      (single idempotent migration — drops & recreates everything)
- [ ] Confirm admin seed (`admin@example.com` / `Admin123!` per DIPLOMA-2) is
      present and reachable
- [ ] Create 3 user accounts via `/register` → verify email if SMTP wired
      (otherwise `UPDATE users SET email_verified = true WHERE email = ...`)
- [ ] Spot-check tables: `users` (1 admin + 3 users), `audit_logs` (>= 4 rows
      from registration), `notifications` empty

## 2. Document ingestion (the slow step — do this first)

- [ ] Login as admin → `/admin` → Documents tab
- [ ] Register + upload 3 PDFs (Dubai building code subset suggested):
      - [ ] **building-code-2021** (medium, ~200 pages)
      - [ ] **fire-safety-code** (~80 pages)
      - [ ] **structural-code** (~120 pages)
- [ ] Trigger ingestion for each, wait for SSE completion (~5-10 min per doc)
- [ ] Spot-check `dubai_code_chunks` row count: should be >= 1500
- [ ] Spot-check `parent_chunks` (no embeddings, larger chunks) populated
- [ ] Spot-check `document_trees`: tree_data JSONB present per document

## 3. Permits seed (5 across statuses)

Login as 3 different users and create one permit each, then advance some
through the state machine:

- [ ] **Permit 1 (draft)** — user1, residential, step 1+2+3 filled, not submitted
- [ ] **Permit 2 (submitted)** — user1, commercial, submitted via `submitPermit`
- [ ] **Permit 3 (under_review)** — user2, industrial, submitted + admin clicks "Start Review"
- [ ] **Permit 4 (approved)** — user2, residential, full flow ending in admin approve
- [ ] **Permit 5 (rejected)** — user3, commercial, full flow ending in admin reject with comments

After Permit 4 approve: download the certificate PDF and confirm it opens.

## 4. Pre-warm semantic_cache (~10 queries)

Login as user1 and send these queries to populate the cache so the demo lands
"cache hit" results without waiting for Gemini:

- [ ] "What are the fire safety requirements for high-rise buildings?"
- [ ] "Maximum building height in residential zones"
- [ ] "Setback requirements for commercial buildings"
- [ ] "Parking space requirements per apartment unit"
- [ ] "Fire exit width minimum"
- [ ] "Elevator requirements for buildings over 4 floors"
- [ ] "Structural load requirements for warehouses"
- [ ] "Building permit application process"
- [ ] "Earthquake resistance requirements"
- [ ] "Plumbing code for multi-storey residential"

After each: confirm citations render in the message bubble + sidebar.
Spot-check `SELECT count(*) FROM semantic_cache` — should be == 10
(the v1.3.0 UNIQUE INDEX prevents duplicate inserts for identical text).

## 5. 11 defense-day click paths

Each must complete without console errors:

- [ ] **Login** — user1, splash screen plays, lands on `/`
- [ ] **Register + verify** — new email, 6-digit code lands, redirected to `/`
- [ ] **Chat with citations** — fresh query, citations render, expand+collapse
- [ ] **Create permit** — step 1 → 2 → 3 → save draft (no errors)
- [ ] **Run compliance check** — on the draft permit; structured result renders
- [ ] **Admin approve** — log in as admin, approve a `submitted` permit
- [ ] **Download certificate** — on the approved permit; PDF opens, year+ID correct
- [ ] **Profile change** — change username; stays logged in (CP-C-1 regression check)
- [ ] **Admin block user** — block, verify next-request redirect within 30 s
- [ ] **Admin add document** — register + ingest a small PDF end-to-end
- [ ] **Admin review queue** — `/admin` permits tab shows all 5 seeded permits, filters work

## 6. Security spot-checks (post-v1.0–v1.5 lockdown)

- [ ] As anon via Supabase REST: `GET /rest/v1/code_attempts?limit=1` → 0 rows
      (DB-C-1 RLS enabled)
- [ ] As anon: `GET /rest/v1/semantic_cache?limit=1` → 0 rows (DB-C-5)
- [ ] Change password as user1 → use old JWT (saved from before) against
      `/api/chat/stream` → 401 within seconds (AUTH-C1 + Part E)
- [ ] Send chat → `SELECT * FROM rate_limits WHERE endpoint = 'chat'` returns
      a row for user1 (S-H-1)
- [ ] Block self via admin → next /permits request → 401 within 30 s (A-M-3)

## 7. Backup snapshot

- [ ] Supabase Dashboard → Project → Database → Backups → take a manual snapshot
- [ ] Note the snapshot ID + timestamp in your defense notes
- [ ] If demo state corrupts during defense, restore in under 2 min

## 8. Final pre-defense gates

- [ ] Vercel build matches local: `git log -1` SHA appears in latest Vercel
      deployment
- [ ] `npx vercel logs <project>.vercel.app --limit 20 --json` returns no
      ERR_REQUIRE_ESM or other structural failures
- [ ] Open a clean Chrome incognito session → run path #1 (Login) → confirm
      no client-side console errors

---

## Rollback plan

If a path fails during defense:

- Browser tab dies: reload — `app/error.tsx` boundaries (v1.6.0 TS-M-9) keep
  the chrome alive
- Chat pipeline wedges: send any new query — `PIPELINE_TIMEOUT_MS = 30 s`
  (v1.3.0 A-C-1) bounds the wait
- Database corruption: restore from Step 7 snapshot
- Gemini quota exhausted: switch to a backup key in `.env.local`, redeploy
  (cache hits keep working without a Gemini call)
