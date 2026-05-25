# Phase 1 — Database Review (2026-05-21)

> Scope: `supabase/migrations/000_full_setup.sql` (the single merged migration,
> lines 1-4027), `lib/supabase-server.ts`, `lib/rag.ts`, `lib/semantic-cache.ts`,
> `lib/chat-pipeline.ts`, and all files under `actions/`.

---

## Critical

### DB-C-1: `code_attempts` table has no Row Level Security enabled

- **File:** `supabase/migrations/000_full_setup.sql:2792-2801`
- **Issue:** `CREATE TABLE IF NOT EXISTS code_attempts` is created but never receives `ALTER TABLE code_attempts ENABLE ROW LEVEL SECURITY`. Every other table in the migration (including `ip_rate_limits` at line 2133) gets an explicit `ENABLE ROW LEVEL SECURITY` statement. The table holds brute-force counters keyed by `'verify:<email>'` and `'reset:<email>'`. Without RLS, any Supabase client bearing the anon key can read the table directly and enumerate which emails have active verification attempts or reset codes in progress.
- **Impact:** Information disclosure. An attacker with the anon key can poll `code_attempts` to confirm whether an email address is registered (active `verify:` key) or has a pending reset (`reset:` key), bypassing the intent of the 6-digit code system. The `incr_code_attempt` and `clear_code_attempt` functions are correctly gated to `service_role` only via GRANT, but direct table access is unrestricted.

---

### DB-C-2: `review_permit_atomic` is callable by `authenticated` role — any logged-in user can approve permits

- **File:** `supabase/migrations/000_full_setup.sql:2986`
- **Issue:** Migration 009 grants `EXECUTE ON FUNCTION review_permit_atomic(UUID, UUID, TEXT, TEXT) TO authenticated, service_role`. This grant is never revoked for the `authenticated` role. The function accepts an arbitrary `p_admin_id` UUID and a `p_new_status` from `('approved', 'rejected', 'revision_requested')`. The only admin guard inside the function is that `p_new_status NOT IN (...)` (line 2951) — there is no check that the caller actually holds an admin role. The final re-creation at line 3972 re-issues `GRANT EXECUTE ... TO service_role` only, but does not REVOKE from `authenticated`, so the earlier grant from line 2986 persists.
- **Impact:** Any authenticated user can call `review_permit_atomic` via the Supabase client with their own `user_id` as `p_admin_id` and approve or reject any permit in the system. The application layer enforces the `requireAdmin()` check in `actions/admin-permits.ts`, but this is not enforced at the database layer. An attacker bypassing the Next.js layer (e.g. direct PostgREST call) can approve their own permit.

---

### DB-C-3: `delete_document_atomic` is callable by `authenticated` — any user can hard-delete documents and all chunks

- **File:** `supabase/migrations/000_full_setup.sql:3020`
- **Issue:** `GRANT EXECUTE ON FUNCTION delete_document_atomic(TEXT, BOOLEAN) TO authenticated, service_role` is issued at line 3020. The function at line 2997 has no caller-role guard. With `p_clear_chunks=TRUE`, it executes `DELETE FROM dubai_code_chunks`, `DELETE FROM parent_chunks`, `DELETE FROM document_trees`, and `DELETE FROM document_registry` — wiping all RAG data for a document. There is no REVOKE to authenticated for this function anywhere in the migration.
- **Impact:** A logged-in user with the anon key + their JWT can call this function via PostgREST and permanently destroy all chunks and registry entries for any document. The application layer guard in `actions/documents.ts` uses `requireAdmin()` but this is bypassed by direct DB API access.

---

### DB-C-4: `submit_permit_atomic` / `revise_permit_atomic` grant to `authenticated` is superseded but not explicitly revoked

- **File:** `supabase/migrations/000_full_setup.sql:2334, 2384, 4018-4019`
- **Issue:** Migration 003 grants these functions to `authenticated` (lines 2334, 2384). Migration 023 drops and recreates both functions but re-grants only to `service_role` (lines 4018-4019). In PostgreSQL, `DROP FUNCTION` does not remove existing ACL entries on the replaced function signature. The grants from lines 2334/2384 survive the DROP+CREATE in migration 023 because the signature is identical and the ACL is effectively re-attached to the new function object. The application calls these via `createAdminClient()` (service_role), so the exposed vector is a direct PostgREST call from an authenticated user.
- **Impact:** Any logged-in user can call `submit_permit_atomic(permit_id, any_uuid)` directly, which will submit any permit they own (the function checks `pa.user_id = p_user_id` via FOR UPDATE). More critically, a user can call `revise_permit_atomic` on a permit they own to forcibly move it back to `draft` from `rejected` or `revision_requested`, bypassing application-layer workflow controls.

---

### DB-C-5: Semantic cache is readable by all `authenticated` users with no row-level isolation

- **File:** `supabase/migrations/000_full_setup.sql:1706-1710`
- **Issue:** `CREATE POLICY "Allow read semantic_cache" ON semantic_cache FOR SELECT TO authenticated USING (true)` at line 1707 gives every authenticated user read access to the full semantic cache. The cache stores `query_text`, `response`, and `citations` from all users' queries.
- **Impact:** Any authenticated user can read the cache table directly and retrieve the full text of other users' queries and the AI responses generated from them. This is a privacy violation — the query text may contain sensitive business or personal information about permit projects.

---

## High

### DB-H-1: `check_rate_limit` advisory lock uses two separate `hashtextextended` calls as two `INT8` arguments — correct, but `pg_advisory_xact_lock(int8, int8)` is not guaranteed available in all Supabase tiers

- **File:** `supabase/migrations/000_full_setup.sql:2607-2610, 3095-3098`
- **Issue:** The two-argument form `pg_advisory_xact_lock(bigint, bigint)` is called with `hashtextextended(p_user_id::text, 0)` and `hashtextextended(v_endpoint, 0)`. `hashtextextended` returns `BIGINT` — the first argument is implicitly cast to `INT4` by the two-argument form. In Postgres the two-argument form of `pg_advisory_xact_lock` takes `(int4, int4)`, not `(int8, int8)`. If `hashtextextended` returns a value outside INT4 range, the implicit cast truncates silently, increasing hash collision probability between different users/endpoints and potentially causing false serialization (two different users locking each other out).
- **Impact:** Under hash collision, two different users or endpoints could serialize against each other's rate limit check, causing artificial latency. Additionally, bit-truncation reduces the effective lock namespace from 64 bits to 32 bits per dimension.

### DB-H-2: Hybrid search functions weight parameters are caller-controlled on `authenticated` grant — `match_dubai_code_hybrid` accepts arbitrary `keyword_weight` / `vector_weight`

- **File:** `supabase/migrations/000_full_setup.sql:1502-1505`
- **Issue:** `match_dubai_code`, `match_dubai_code_hybrid`, `match_dubai_code_hybrid_filtered`, `search_dubai_code_keywords`, `search_dubai_code_exact`, `find_chunks_by_page`, `find_chunks_by_section`, and `match_citation` are all granted to `anon` and `authenticated`. The hybrid functions accept `keyword_weight`, `vector_weight`, `rrf_k`, and `match_count` as parameters. A caller via PostgREST can set `match_count=10000`, causing the function to attempt to return 10,000 rows from an HNSW scan, which is computationally expensive. `search_dubai_code_keywords` caps at `LEAST(match_count, 100)` (line 545) but `match_dubai_code_hybrid` only caps at the inner CTEs' LIMIT 50 (line 594/605), not the outer `match_count` parameter.
- **Impact:** A logged-in user can issue a direct PostgREST call with `match_count=99999` and abuse the hybrid search RPC to perform expensive vector scans, causing CPU/memory pressure on the database. The `anon` grant for RAG search functions means even unauthenticated users with the public anon key can call these.

### DB-H-3: `get_all_users_admin` session_stats CTE aggregates ALL chat sessions/messages before filtering — full table scans on large datasets

- **File:** `supabase/migrations/000_full_setup.sql:1468-1488, 3505-3527`
- **Issue:** The `session_stats` CTE at lines 1468-1475 (and identically at 3505-3513) runs `SELECT cs.user_id, COUNT(*), COUNT(cm.id) FROM chat_sessions cs LEFT JOIN chat_messages cm ON cm.session_id = cs.id GROUP BY cs.user_id`. This aggregates all users' sessions and messages unconditionally before the outer query applies `p_search` filtering or the keyset cursor. For 10k users each with 100 sessions and 500 messages, this is a 5M-row join that happens before pagination. The join is between two tables that already have covering indexes (`chat_sessions_user_id_idx`, `chat_messages_session_id_idx`) but the CTE forces a full aggregation regardless of the page size.
- **Impact:** The admin "users" page has O(total messages) query complexity regardless of the page size. With real data volume this becomes the slowest query in the system.

### DB-H-4: `match_dubai_code_hybrid` and `match_dubai_code_hybrid_filtered` include `keyword_weight` and `vector_weight` in the RRF formula incorrectly — the weights modify RRF ranks, not scores

- **File:** `supabase/migrations/000_full_setup.sql:614-617, 707-716`
- **Issue:** The combined score formula is `vector_weight * (1.0 / (rrf_k + v_rank)) + keyword_weight * (1.0 / (rrf_k + k_rank))`. Standard RRF is `SUM(1 / (k + rank))` with equal weight per list. Applying scalar weights to RRF reciprocal values is mathematically valid as a weighted fusion, but the weights default to `vector_weight=0.7` and `keyword_weight=0.3` summing to 1.0. These weights are applied to rank-based values that are already normalized by `rrf_k`. The issue is that `rrf_k=60` and the maximum reciprocal value is `1/61 ≈ 0.016`, meaning the combined score range is roughly `[0, 0.016]`. In `lib/rag.ts:212`, the application then multiplies `hybridScore * 10` to scale this back up to `[0, 0.16]`, and then clamps to 1.0. A chunk that is top-ranked in both vector and keyword search gets a combined score of `0.7/61 + 0.3/61 ≈ 0.016`, which after the `*10` multiplication in `lib/rag.ts` becomes 0.16 — well below the CRAG threshold of 0.3 even for the best possible result.
- **Impact:** The CRAG check in `lib/rag.ts` compares against a threshold of `0.3`. Since the best achievable hybrid score after `*10` scaling is `~0.16`, the CRAG check can never return true from hybrid results alone, meaning the pipeline can never distinguish "good hybrid result" from "mediocre hybrid result" via the CRAG pathway. The CRAG logic in `lib/rag.ts` is effectively dead for hybrid search results.

### DB-H-5: `analytics_daily` materialized view has no automatic refresh — staleness can exceed 29 days

- **File:** `supabase/migrations/000_full_setup.sql:454-469`
- **Issue:** The `analytics_daily` materialized view at line 454 is created with no scheduled refresh trigger, pg_cron job, or automatic invalidation mechanism. `refresh_analytics()` (line 1069) must be called manually via the admin dashboard "Refresh" button. The `get_message_activity_30d()` function at line 3234 reads from the MV for `ad.date < current_date` (yesterday and older), computing only today live. If the MV is never refreshed, the function returns zeros for all historic days and only shows today's live count.
- **Impact:** After a fresh database setup, the analytics dashboard shows no historic data until an admin clicks "Refresh". For a production deployment with no scheduled refresh job, data silently disappears from the 30-day view after midnight each day.

### DB-H-6: `create_permit_atomic` is callable by `authenticated` — users can supply arbitrary `p_user_id`

- **File:** `supabase/migrations/000_full_setup.sql:2921`
- **Issue:** `GRANT EXECUTE ON FUNCTION create_permit_atomic(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated`. The function at line 2888 accepts `p_user_id UUID` as its first parameter and inserts it directly into `permit_applications.user_id` without verifying it matches the calling database user. A PostgREST caller can pass any UUID as `p_user_id` to create a permit attributed to another user.
- **Impact:** A logged-in user can fabricate permit applications attributed to other users' IDs, polluting their permit list and potentially triggering notifications or compliance workflows on their behalf.

### DB-H-7: `bump_user_token_version` is callable by `authenticated` — any user can invalidate any other user's sessions

- **File:** `supabase/migrations/000_full_setup.sql:2686`
- **Issue:** `GRANT EXECUTE ON FUNCTION bump_user_token_version(UUID) TO authenticated`. The function at line 2669 accepts `p_user_id UUID` and increments `token_version` for that user with no caller identity check. Any authenticated user can pass another user's UUID to force their JWT to become invalid on the next middleware check.
- **Impact:** A logged-in user can log out any other user (including admins) by calling this function repeatedly. This is a targeted denial-of-service against individual accounts.

### DB-H-8: `incr_code_attempt` and `clear_code_attempt` are callable by `authenticated` — users can manipulate brute-force counters

- **File:** `supabase/migrations/000_full_setup.sql:2850, 2863`
- **Issue:** Both `incr_code_attempt(TEXT, INT, INT)` and `clear_code_attempt(TEXT)` are granted to `authenticated`. The `clear_code_attempt` function accepts a free-form `p_key TEXT` with no caller validation. A logged-in user can call `clear_code_attempt('verify:victim@example.com')` to reset the brute-force counter for another user's email verification, or call `incr_code_attempt('reset:admin@example.com', ...)` to lock out an admin's password reset flow.
- **Impact:** Targeted denial-of-service against any user's email verification or password reset flow, and the ability to bypass brute-force protection by resetting one's own counter.

---

## Medium

### DB-M-1: `GRANT ALL ON permit_applications TO authenticated` is overly broad — authenticated users have INSERT/DELETE/UPDATE on all rows, with only RLS as the guard

- **File:** `supabase/migrations/000_full_setup.sql:1536`
- **Issue:** `GRANT ALL ON permit_applications TO authenticated` at line 1536. This includes INSERT, UPDATE, DELETE, SELECT, TRUNCATE, REFERENCES, TRIGGER. RLS policies restrict access to own rows, but GRANT ALL is an unnecessarily broad privilege grant. Best practice is to grant only SELECT on the `authenticated` role and delegate mutations to `service_role`-only functions, since all mutations go through server actions anyway.
- **Impact:** Defense-in-depth is weakened. If an RLS policy is misconfigured or missing, `authenticated` users have unrestricted write access to the permit table. The same pattern applies to `permit_status_history`, `permit_attachments`, `permit_certificates`, `notifications`, `chat_sessions`, `chat_messages`, and `rate_limits` (all with `GRANT ALL TO authenticated`).

### DB-M-2: `users` table grants `UPDATE` to `authenticated` with no column restriction — users can update `role`, `blocked`, `password_hash`

- **File:** `supabase/migrations/000_full_setup.sql:1518`
- **Issue:** `GRANT SELECT, UPDATE ON users TO authenticated`. The RLS policy `"Authenticated users can update own profile"` restricts which rows can be updated (`id = auth.uid()`), but does not restrict which columns. Without column-level privileges, an authenticated user with a direct PostgREST call can issue `UPDATE users SET role='admin' WHERE id=<their_id>` if the RLS check passes on the row. The RLS policy uses `WITH CHECK (id = auth.uid())`, which ensures the row belongs to the caller, but it does not prevent updating `role`, `blocked`, `blocked_by`, `blocked_at`, or `password_hash`.
- **Impact:** A logged-in user via direct PostgREST (bypassing Next.js actions) can escalate their own role to `admin` or clear their `blocked` status. This is the highest-severity consequence of not having column-level grants.

### DB-M-3: Migration is destructive and not idempotent in the standard sense — `DROP TABLE ... CASCADE` on every run destroys all data

- **File:** `supabase/migrations/000_full_setup.sql:13-28`
- **Issue:** Lines 13-28 drop all tables unconditionally (`DROP TABLE IF EXISTS ... CASCADE`). The inline migrations 001-023 (from line 2183 onward) then use `ADD COLUMN IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`, making the incremental parts idempotent. But the opening section guarantees complete data loss on every re-run. The file is labeled "single idempotent migration" in CLAUDE.md, but it is only idempotent with respect to schema existence — not data.
- **Impact:** Re-running this migration in any environment (dev, staging, accidentally in production) erases all users, permits, chat history, chunks, and audit logs. There is no guard or warning in the SQL itself.

### DB-M-4: `find_chunks_by_page` and `match_citation` cast `metadata->>'startPage'` / `'endPage'` without NULL guards — runtime errors on chunks with missing metadata

- **File:** `supabase/migrations/000_full_setup.sql:789-813, 886-914`
- **Issue:** Predicates like `(d.metadata->>'startPage')::INT <= target_page` in `find_chunks_by_page` (line 799) and `match_citation` (line 907) will throw `ERROR: invalid input syntax for type integer` if `metadata->>'startPage'` is present but non-numeric (e.g., `"startPage": null` or `"startPage": "N/A"`). Chunks ingested from a PDF with non-standard metadata could contain such values.
- **Impact:** A single malformed chunk causes all page-based searches to throw a database error, returning no results and breaking the tree-reasoning path until the chunk is manually corrected.

### DB-M-5: `match_dubai_code_hybrid_filtered` receives `page_ranges` as a JSONB parameter with no validation — malformed JSON causes a runtime error inside the function

- **File:** `supabase/migrations/000_full_setup.sql:638-727`
- **Issue:** The function at line 638 accepts `page_ranges JSONB` and immediately calls `jsonb_array_elements(page_ranges)` inside the WHERE clause. If `page_ranges` is `NULL`, `jsonb_array_elements(NULL)` returns zero rows (safe). If it is a non-array JSONB value (e.g., `{}`), `jsonb_array_elements` raises `ERROR: cannot call jsonb_array_elements on a non-array`. There is no defensive check (`CASE WHEN jsonb_typeof(page_ranges) = 'array'`).
- **Impact:** A caller that passes a malformed `page_ranges` argument (e.g., from a bug in `lib/scope-detector.ts`) causes the function to throw, breaking the entire hybrid filtered search path and falling back to no results.

### DB-M-6: `get_all_users_admin` leaks the OFFSET path when `p_limit` is at max (100) on a large table

- **File:** `supabase/migrations/000_full_setup.sql:3526`
- **Issue:** When keyset pagination is not used (`v_use_keyset = FALSE`), the function applies `OFFSET GREATEST(p_offset, 0)`. On a table with 10k users and `p_offset=9900`, this forces Postgres to scan and discard 9,900 rows from the full users+session_stats join before returning a page. The function caps `p_limit` at 100 but places no cap on `p_offset`.
- **Impact:** Deep OFFSET pagination on the admin user list degrades linearly. For 10k users, fetching the last page with OFFSET takes O(N) work. The keyset path avoids this but is gated on the caller supplying the cursor; if the admin UI does not implement the cursor (e.g., direct API call), it falls back to OFFSET.

### DB-M-7: `save_document_tree` stores arbitrarily large JSONB in `document_trees.tree_data` with no size cap

- **File:** `supabase/migrations/000_full_setup.sql:939-962`
- **Issue:** `save_document_tree` at line 939 accepts `p_tree_data JSONB` with no maximum size check and upserts it into `document_trees.tree_data`. A PDF with a very deep or wide table-of-contents can generate a tree JSONB blob of several MB. The `document_trees` table has no CHECK constraint on the size of `tree_data`.
- **Impact:** Large tree blobs increase `document_trees` table size and slow down `get_document_tree` retrieval. In pathological cases (deeply nested PDF outline), this can cause a single row to exceed PostgreSQL's TOAST threshold repeatedly and degrade performance of tree-reasoning queries.

### DB-M-8: `HNSW ef_construction=64` may under-index for large corpora — recall degrades at scale

- **File:** `supabase/migrations/000_full_setup.sql:127, 373`
- **Issue:** Both the `dubai_code_chunks` embedding index (`ef_construction=64`, line 127) and the `semantic_cache` index (`ef_construction=64`, line 373) use `m=16, ef_construction=64`. For corpora larger than ~50k vectors, `ef_construction=64` produces an HNSW graph with lower recall (typically <90% recall at ef_search=40) as reported in pgvector benchmarks. A single large PDF ingest at 400-char child chunks can produce 10k-40k vectors per document.
- **Impact:** With multiple documents ingested, vector recall degrades silently — the planner returns the HNSW-approximate top-k, which may miss relevant chunks that a brute-force scan would return. There is no runtime warning when recall degrades. Recommended minimum for high-recall use: `ef_construction=128` or higher.

### DB-M-9: `cleanup_semantic_cache` is never called automatically — the cache grows unboundedly

- **File:** `supabase/migrations/000_full_setup.sql:1796-1810`
- **Issue:** `cleanup_semantic_cache()` is defined at line 1796 and granted to `service_role` only. There is no pg_cron schedule, trigger, or application code path that calls it proactively. The `storeInCache` function in `lib/semantic-cache.ts` only inserts; it never triggers cleanup. The `search_semantic_cache` function filters by TTL at query time (line 1765) but does not delete expired rows.
- **Impact:** `semantic_cache` grows without bound. The HNSW index on `query_embedding` will degrade in query performance as more entries accumulate, and storage will grow indefinitely. At 768-dimensional vectors, each cache entry is approximately 3KB of vector data plus text. After months of operation, this table could consume gigabytes.

### DB-M-10: `get_analytics_dashboard_stats` runs 10 correlated subqueries in a single SQL function — no index on `permit_applications.created_at`

- **File:** `supabase/migrations/000_full_setup.sql:1188-1208`
- **Issue:** The function at line 1172 fires 10 separate `SELECT count(*) FROM ...` subqueries sequentially. The subquery at line 1199 is `SELECT count(*) FROM permit_applications WHERE created_at >= date_trunc('day', now())`. There is a `permit_apps_created_at_idx` (line 254) but it is created as `DESC` which is fine for ORDER BY but the planner may still prefer a seq scan for `>= date_trunc(...)` depending on table statistics. More critically, the function is marked `SECURITY DEFINER` but does not include `SET search_path = public, pg_temp` — it uses only `SET search_path = public, pg_temp` at line 1187, which is correct, but the 10 separate count subqueries could be replaced with a single aggregating query.
- **Impact:** Every admin dashboard load triggers 10 independent count queries against large tables. At scale this multiplies per-request DB work by 10x compared to a single aggregating query.

### DB-M-11: `refresh_analytics` uses `REFRESH MATERIALIZED VIEW CONCURRENTLY` but holds a ShareUpdateExclusiveLock — concurrent reads are blocked during refresh on Supabase free tier

- **File:** `supabase/migrations/000_full_setup.sql:1069-1074`
- **Issue:** `REFRESH MATERIALIZED VIEW CONCURRENTLY analytics_daily` (line 1072) requires a unique index on the view, which exists (`analytics_daily_date_idx`, line 469). However, on Supabase free/pro tiers using PgBouncer in transaction mode, a long `REFRESH MATERIALIZED VIEW CONCURRENTLY` can exceed the statement timeout and be cancelled mid-refresh, leaving the view in a partially-refreshed state. Additionally, `CONCURRENT` still acquires a ShareUpdateExclusiveLock that blocks `VACUUM` and DDL on the underlying tables.
- **Impact:** On a large `chat_messages` table, a `REFRESH MATERIALIZED VIEW CONCURRENTLY` that is cancelled mid-run leaves the view stale but does not corrupt data. However, the admin dashboard will see an inconsistent state until the next successful refresh.

---

## Low

### DB-L-1: `document_registry` stores `badge_color` as a Tailwind CSS class string in the DB — a presentation concern with no validation

- **File:** `supabase/migrations/000_full_setup.sql:390`
- **Issue:** `badge_color VARCHAR(128) DEFAULT 'bg-gray-500/20 text-gray-400 border-gray-500/30'` stores Tailwind class strings directly in the database. There is no CHECK constraint validating the format. An admin can store arbitrary strings, including JavaScript injection payloads if DOMPurify is not applied when rendering badge colors.
- **Impact:** Low risk since rendering is handled by React (class attribute assignment is safe), but this couples the DB schema to a frontend framework choice and prevents future non-Tailwind rendering without a data migration.

### DB-L-2: `permit_applications.file_size` is `INTEGER` — truncates files larger than 2GB

- **File:** `supabase/migrations/000_full_setup.sql:287`
- **Issue:** `file_size INTEGER NOT NULL` in `permit_attachments` at line 287. `INTEGER` in Postgres is 32-bit signed, max 2,147,483,647 bytes (~2GB). The `insert_permit_attachment_capped` function at line 2408 declares `p_file_size BIGINT` as the parameter type, which is correct, but inserts into a column typed `INTEGER`, causing silent truncation for files > 2GB. The 10MB per-file limit in `lib/constants.ts` makes this a theoretical issue today, but the type mismatch is a latent bug.
- **Impact:** If the 10MB limit is ever raised without updating the column type, file sizes would silently truncate in the database while the storage system holds the actual file. Integrity checks comparing stored `file_size` against actual storage object size would fail.

### DB-L-3: `idx_document_trees_name` is redundant — `document_trees.document_name` already has a `UNIQUE` constraint creating an implicit B-tree index

- **File:** `supabase/migrations/000_full_setup.sql:155-162`
- **Issue:** `document_trees` at line 153 declares `document_name TEXT NOT NULL UNIQUE`. The `UNIQUE` constraint creates an implicit B-tree index. Line 162 then creates `CREATE INDEX idx_document_trees_name ON document_trees(document_name)`, which is a duplicate index on the same column.
- **Impact:** Two identical indexes on `document_name` double the write overhead for INSERT/UPDATE and waste storage. The query planner will always choose one and ignore the other.

### DB-L-4: `users.blocked` partial index only covers `blocked=TRUE` — queries filtering `blocked=FALSE` or `IS NULL` cannot use it

- **File:** `supabase/migrations/000_full_setup.sql:106`
- **Issue:** `CREATE INDEX users_blocked_idx ON users(blocked) WHERE blocked = TRUE`. The middleware block-status check queries `SELECT blocked FROM users WHERE id = $1`, which is served by the PK index. But any query filtering `WHERE blocked = FALSE` (e.g., counting active users) will perform a sequential scan of all unblocked users. This is an intentional design choice for a sparse `blocked=TRUE` case, which is fine.
- **Impact:** No functional bug. Noted because future queries like `SELECT COUNT(*) FROM users WHERE blocked = FALSE` will not use this index. Document the design intent explicitly.

### DB-L-5: `permit_status_history.from_status` allows NULL — no CHECK enforces that only the first transition has `from_status IS NULL`

- **File:** `supabase/migrations/000_full_setup.sql:266-267`
- **Issue:** `from_status TEXT CHECK (from_status IS NULL OR from_status IN (...))` allows NULL for any row, not just the initial `draft` transition. The `create_permit_atomic` function inserts `from_status=NULL` for the first row (line 2914), which is correct. But there is no database-level constraint preventing subsequent rows from also having `from_status=NULL`.
- **Impact:** If application code has a bug and omits `from_status` on a non-initial transition, the status history becomes inaccurate. The audit trail integrity depends entirely on application-layer correctness.

### DB-L-6: Stale function overloads are not cleaned up — the migration DROP loop targets functions by name but earlier migrations leave `check_rate_limit(UUID, INT, INT, INT)` as a residual overload

- **File:** `supabase/migrations/000_full_setup.sql:33-59, 2490-2547, 2576-2577`
- **Issue:** The opening cleanup block at line 33 drops all functions listed by name using `pg_function_is_visible`. Migrations 005 and 006 recreate `check_rate_limit` with different signatures, with explicit `DROP FUNCTION IF EXISTS` statements at lines 2576-2577. However, migration 005 at line 2490 creates `check_rate_limit(UUID, INT, INT, INT)` and grants it to `authenticated` at line 2547. Migration 006 drops that signature at line 2576, but the final merged migration runs sections sequentially, so the grant at line 2547 exists for the duration of the 005 block before being cleaned up. In a re-run scenario where only the schema is rebuilt, the intermediate grant state is transient, but in a live migration applied incrementally, an operator applying only migrations 005 without immediately applying 006 would have the old-signature function callable by `authenticated` indefinitely until 006 runs.
- **Impact:** Low in the merged single-file setup, but documents a hazard if the migration is ever split back into sequential files.

### DB-L-7: `semantic_cache` has no unique constraint on `query_text` — duplicate inserts create multiple cache entries for identical queries

- **File:** `supabase/migrations/000_full_setup.sql:362-374`
- **Issue:** `insert_semantic_cache` at line 1773 does a plain `INSERT INTO semantic_cache` with no `ON CONFLICT` clause. If two concurrent identical queries both miss the cache (before singleflight was introduced in X18), they both insert an entry. The HNSW similarity search returns the closest one, but the table accumulates duplicates. The `ttl_seconds` TTL-based cleanup will eventually remove them, but in the interim the HNSW index must scan extra vectors.
- **Impact:** Cache bloat and minor HNSW performance degradation. The X18 singleflight in `lib/chat-pipeline.ts` mitigates this in-process, but does not address cross-process or cross-instance duplicate inserts.

### DB-L-8: `parent_chunks` has no RLS policy for `anon` — anon clients can read parent chunk content directly

- **File:** `supabase/migrations/000_full_setup.sql:1700-1704`
- **Issue:** The RLS policy for `parent_chunks` at line 1700 grants SELECT to `authenticated` only. There is no explicit DENY for `anon`. The `GRANT SELECT ON parent_chunks` is not present for `anon` (checking lines 1495-1546), so by default anon cannot read via the Supabase client. However, `document_trees` and `dubai_code_chunks` are both granted to `anon` (lines 1497, 1512) while `parent_chunks` is not. This asymmetry means the RAG search functions that are callable by `anon` (match_dubai_code, etc.) return results but the parent expansion function (`get_parent_chunks`) is not callable by `anon`.
- **Impact:** If the application ever moves any path to the anon client, parent expansion silently returns empty results. Current behavior is correct but the asymmetry is a latent trap.

---

## Diploma Exceptions (wontfix-diploma)

- **Hardcoded `Admin123!` bcrypt hash (dynamic via `crypt()`):** `supabase/migrations/000_full_setup.sql:2081-2087`. The default admin user is seeded with `crypt('Admin123!', gen_salt('bf', 12))`. This is a well-known credential that must be changed immediately after first deployment. In a production system this would be a critical finding, but for a diploma submission where the credential is documented and the system is not internet-facing, it is accepted as-is. Operator must change the password before any public deployment.
