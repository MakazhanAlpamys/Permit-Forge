// ============================================================================
// Migration Grant Tests — verify least-privilege grants in 000_full_setup.sql
// ============================================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATION_PATH = resolve(__dirname, '../supabase/migrations/000_full_setup.sql');
const sql = readFileSync(MIGRATION_PATH, 'utf8');

describe('migration grants — dubai_code_chunks (A3 / C5)', () => {
  it('does NOT grant INSERT/UPDATE/DELETE on dubai_code_chunks to anon', () => {
    // The audit (C5) flagged that `anon` had INSERT/DELETE/UPDATE on the RAG corpus,
    // which is a footgun if RLS is ever disabled. anon must only read.
    const offendingPattern =
      /GRANT[^;]*?(INSERT|UPDATE|DELETE)[^;]*?ON\s+dubai_code_chunks[^;]*?\banon\b[^;]*?;/i;
    expect(sql).not.toMatch(offendingPattern);
  });

  it('does NOT grant INSERT/UPDATE/DELETE on dubai_code_chunks to authenticated', () => {
    // Defense-in-depth: chat reads via RPC, ingestion runs through service_role.
    // authenticated has no legitimate reason to mutate the corpus.
    const offendingPattern =
      /GRANT[^;]*?(INSERT|UPDATE|DELETE)[^;]*?ON\s+dubai_code_chunks[^;]*?\bauthenticated\b[^;]*?;/i;
    expect(sql).not.toMatch(offendingPattern);
  });

  it('grants SELECT on dubai_code_chunks to anon', () => {
    // anon still needs SELECT for public read paths.
    const allowedPattern =
      /GRANT\s+SELECT(?:\s*,\s*\w+)*\s+ON\s+dubai_code_chunks\s+TO\s+[^;]*?\banon\b[^;]*?;/i;
    expect(sql).toMatch(allowedPattern);
  });

  it('keeps INSERT/UPDATE/DELETE on dubai_code_chunks for service_role (ingestion)', () => {
    // Ingestion pipeline runs as service_role and needs full write access.
    const serviceRolePattern =
      /GRANT[^;]*?(INSERT|UPDATE|DELETE)[^;]*?ON\s+dubai_code_chunks[^;]*?\bservice_role\b[^;]*?;/i;
    expect(sql).toMatch(serviceRolePattern);
  });

  it('does NOT grant sequence write privileges on dubai_code_chunks_id_seq to anon or authenticated', () => {
    // Only the role that INSERTs (service_role) needs the sequence.
    const anonSeq =
      /GRANT[^;]*?ON\s+SEQUENCE\s+dubai_code_chunks_id_seq[^;]*?\banon\b[^;]*?;/i;
    const authedSeq =
      /GRANT[^;]*?ON\s+SEQUENCE\s+dubai_code_chunks_id_seq[^;]*?\bauthenticated\b[^;]*?;/i;
    expect(sql).not.toMatch(anonSeq);
    expect(sql).not.toMatch(authedSeq);
  });

  it('grants sequence privileges on dubai_code_chunks_id_seq to service_role', () => {
    const serviceSeq =
      /GRANT[^;]*?ON\s+SEQUENCE\s+dubai_code_chunks_id_seq[^;]*?\bservice_role\b[^;]*?;/i;
    expect(sql).toMatch(serviceSeq);
  });
});

describe('migration grants — semantic cache RPCs (A4 / H19)', () => {
  it('does NOT grant EXECUTE on insert_semantic_cache to authenticated', () => {
    // H19: insert_semantic_cache lets the caller poison the RAG response cache.
    // App code calls it via service_role (createAdminClient in lib/semantic-cache.ts).
    const offending =
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+insert_semantic_cache[^;]*?\bauthenticated\b[^;]*?;/i;
    expect(sql).not.toMatch(offending);
  });

  it('does NOT grant EXECUTE on cleanup_semantic_cache to authenticated', () => {
    // H19: cleanup_semantic_cache wipes the cache table. Maintenance-only.
    const offending =
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+cleanup_semantic_cache[^;]*?\bauthenticated\b[^;]*?;/i;
    expect(sql).not.toMatch(offending);
  });

  it('grants EXECUTE on insert_semantic_cache to service_role', () => {
    const allowed =
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+insert_semantic_cache[^;]*?\bservice_role\b[^;]*?;/i;
    expect(sql).toMatch(allowed);
  });

  it('grants EXECUTE on cleanup_semantic_cache to service_role', () => {
    const allowed =
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+cleanup_semantic_cache[^;]*?\bservice_role\b[^;]*?;/i;
    expect(sql).toMatch(allowed);
  });

  it('still revokes insert_semantic_cache from public and anon', () => {
    const revoke =
      /REVOKE\s+ALL\s+ON\s+FUNCTION\s+insert_semantic_cache[^;]*?\b(?:public|anon)\b[^;]*?;/i;
    expect(sql).toMatch(revoke);
  });

  it('still revokes cleanup_semantic_cache from public and anon', () => {
    const revoke =
      /REVOKE\s+ALL\s+ON\s+FUNCTION\s+cleanup_semantic_cache[^;]*?\b(?:public|anon)\b[^;]*?;/i;
    expect(sql).toMatch(revoke);
  });
});

describe('migration RLS ownership policies (A1 / C3)', () => {
  // C3: USING(true) on user-owned tables was masked by service_role today, but
  // a single anon-key read with a JWT would expose everyone's data. Replace
  // with ownership-based RLS that uses auth.uid().
  it('does NOT leave USING (true) on any user-owned table for authenticated', () => {
    const offending = [
      'chat_sessions', 'chat_messages',
      'permit_applications', 'permit_status_history', 'permit_attachments',
      'notifications', 'permit_certificates',
    ];
    for (const table of offending) {
      // Match a full CREATE POLICY statement on the table that targets
      // authenticated with USING (true). Use a tighter window so other SQL
      // (like information_schema lookups) doesn't get mis-matched.
      const bad = new RegExp(
        `CREATE\\s+POLICY[^;]*\\bON\\s+${table}\\b[^;]*FOR\\s+ALL\\s+TO\\s+authenticated[^;]*USING\\s*\\(\\s*true\\s*\\)[^;]*;`,
        'i',
      );
      expect(sql, `${table} should not have USING(true) for authenticated`).not.toMatch(bad);
    }
  });

  const OWN_USER_ID_TABLES = ['chat_sessions', 'permit_applications', 'notifications'];
  for (const table of OWN_USER_ID_TABLES) {
    it(`${table} has an ownership policy on user_id = auth.uid()`, () => {
      const pattern = new RegExp(
        `ON\\s+${table}[\\s\\S]{0,300}FOR\\s+ALL\\s+TO\\s+authenticated[\\s\\S]{0,300}user_id\\s*=\\s*\\(\\s*SELECT\\s+auth\\.uid\\(\\)\\s*\\)`,
        'i',
      );
      expect(sql).toMatch(pattern);
    });
  }

  const PARENT_OWN_TABLES = [
    { table: 'chat_messages', parent: 'chat_sessions', col: 'session_id' },
    { table: 'permit_status_history', parent: 'permit_applications', col: 'permit_id' },
    { table: 'permit_attachments', parent: 'permit_applications', col: 'permit_id' },
    { table: 'permit_certificates', parent: 'permit_applications', col: 'permit_id' },
  ];
  for (const { table, parent, col } of PARENT_OWN_TABLES) {
    it(`${table} has an ownership policy via parent ${parent}.user_id`, () => {
      const pattern = new RegExp(
        `ON\\s+${table}[\\s\\S]{0,300}FOR\\s+ALL\\s+TO\\s+authenticated[\\s\\S]{0,500}EXISTS[\\s\\S]{0,200}FROM\\s+${parent}[\\s\\S]{0,200}id\\s*=\\s*${table}\\.${col}[\\s\\S]{0,200}user_id\\s*=\\s*\\(\\s*SELECT\\s+auth\\.uid\\(\\)\\s*\\)`,
        'i',
      );
      expect(sql).toMatch(pattern);
    });
  }
});

describe('migration zero-admin guards (C9H / H12)', () => {
  // H12: blocking the only remaining unblocked admin, or demoting them to
  // 'user', would lock everyone out of admin functions. Static-check that
  // both RPC bodies contain the count(*) + SELECT FOR UPDATE pattern.
  it('admin_block_user guards against zero unblocked admins', () => {
    const body = sql.match(
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+admin_block_user\b[\s\S]*?\$\$;/i,
    );
    expect(body, 'admin_block_user not found').not.toBeNull();
    expect(body![0]).toMatch(/role\s*=\s*'admin'\s+AND\s+blocked\s*=\s*FALSE[\s\S]*?FOR\s+UPDATE/i);
    expect(body![0]).toMatch(/v_unblocked_admin_count\s*<=\s*1/i);
  });

  it('admin_update_user_role guards against demoting the last unblocked admin', () => {
    const body = sql.match(
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+admin_update_user_role\b[\s\S]*?\$\$;/i,
    );
    expect(body, 'admin_update_user_role not found').not.toBeNull();
    expect(body![0]).toMatch(/role\s*=\s*'admin'\s+AND\s+blocked\s*=\s*FALSE[\s\S]*?FOR\s+UPDATE/i);
    expect(body![0]).toMatch(/v_unblocked_admin_count\s*<=\s*1/i);
  });
});

describe('migration constraints — permit_status_history (D5 / M12)', () => {
  // M12: permit_status_history.from_status / to_status are loose TEXT today,
  // so a bad insert could write an unrecognized status (e.g. typo "approveed")
  // that downstream code silently ignores. Bound them to the same enum used by
  // permit_applications.status.
  const VALUES = '(draft|submitted|under_review|approved|rejected|revision_requested)';

  it('constrains to_status to the permit status enum', () => {
    const pattern = new RegExp(
      `to_status[\\s\\S]*?CHECK\\s*\\(\\s*to_status\\s+IN\\s*\\([^)]*?'${VALUES}'`,
      'i',
    );
    expect(sql).toMatch(pattern);
  });

  it('constrains from_status to NULL or the permit status enum', () => {
    const pattern = new RegExp(
      `from_status[\\s\\S]*?CHECK\\s*\\(\\s*from_status\\s+IS\\s+NULL\\s+OR\\s+from_status\\s+IN`,
      'i',
    );
    expect(sql).toMatch(pattern);
  });
});

describe('migration search_path — SECURITY DEFINER analytics functions (A7 / M16)', () => {
  // M16: SECURITY DEFINER functions without a pinned search_path are vulnerable
  // to search-path-injection attacks. Pin each to (public, pg_temp).
  const FUNCTIONS = [
    'get_analytics_dashboard_stats',
    'get_message_activity_30d',
    'get_top_active_users',
    'get_weekly_activity',
  ] as const;

  for (const fn of FUNCTIONS) {
    it(`pins search_path on ${fn}`, () => {
      // Match the function body up to the AS $$ marker and assert SET search_path
      // = public, pg_temp appears within it.
      const bodyPattern = new RegExp(
        `CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+${fn}\\b[\\s\\S]*?AS\\s+\\$\\$`,
        'i',
      );
      const match = sql.match(bodyPattern);
      expect(match, `${fn} declaration not found`).not.toBeNull();
      expect(match![0]).toMatch(/SECURITY\s+DEFINER/i);
      expect(match![0]).toMatch(/SET\s+search_path\s*=\s*public\s*,\s*pg_temp/i);
    });
  }
});

// =============================================================================
// v1.0.0 "Auth Lockdown" — Parts A/B/C/D defenses against direct PostgREST calls
// =============================================================================
//
// Pattern below: extract the *final* (last) CREATE OR REPLACE block for the
// function name — Postgres applies whichever definition wins. The body must
// reference `auth.uid()` somewhere so the function refuses calls made via
// PostgREST as authenticated (auth.uid() is non-null) without an admin or
// matching-self user. service_role calls have auth.uid() = NULL and bypass
// the guard.

function getLastFunctionBody(fn: string): string {
  const re = new RegExp(
    `CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+${fn}\\b[\\s\\S]*?\\$\\$;`,
    'gi',
  );
  const matches = sql.match(re);
  if (!matches || matches.length === 0) {
    throw new Error(`Function ${fn} not found in migration`);
  }
  return matches[matches.length - 1];
}

describe('v1.0.0 Part A — RPC admin guards inside function bodies (DB-C-2/3, DB-H-6/7)', () => {
  it('review_permit_atomic guards admin role inside the function body', () => {
    // DB-C-2: even if grant accidentally lets authenticated in, the body
    // must refuse non-admin callers. service_role bypass: auth.uid() = NULL.
    const body = getLastFunctionBody('review_permit_atomic');
    expect(body).toMatch(/auth\.uid\(\)/i);
    expect(body).toMatch(/role\s*=\s*'admin'/i);
  });

  it('delete_document_atomic guards admin role inside the function body', () => {
    // DB-C-3: same shape — admin or service_role only.
    const body = getLastFunctionBody('delete_document_atomic');
    expect(body).toMatch(/auth\.uid\(\)/i);
    expect(body).toMatch(/role\s*=\s*'admin'/i);
  });

  it('create_permit_atomic guards p_user_id against the caller identity', () => {
    // DB-H-6: a logged-in user must not be able to attribute permits to
    // other users. Either auth.uid() = NULL (service_role) or
    // auth.uid() = p_user_id (or admin).
    const body = getLastFunctionBody('create_permit_atomic');
    expect(body).toMatch(/auth\.uid\(\)/i);
    expect(body).toMatch(/p_user_id/i);
  });

  it('bump_user_token_version is callable only by admins (or self via service_role)', () => {
    // DB-H-7: any user could force-log-out any other user without this guard.
    const body = getLastFunctionBody('bump_user_token_version');
    expect(body).toMatch(/auth\.uid\(\)/i);
    expect(body).toMatch(/role\s*=\s*'admin'/i);
  });
});

describe('v1.0.0 Part B — REVOKE EXECUTE on sensitive atomic RPCs from authenticated (DB-C-4 / DB-H-6/7/8)', () => {
  // DB-C-4: the final create/replace cycle should leave these callable only by
  // service_role. App code always invokes them through createAdminClient.
  const FUNCTIONS = [
    'submit_permit_atomic',
    'revise_permit_atomic',
    'review_permit_atomic',
    'create_permit_atomic',
    'delete_document_atomic',
    'bump_user_token_version',
    'incr_code_attempt',
    'clear_code_attempt',
  ] as const;

  for (const fn of FUNCTIONS) {
    it(`explicitly REVOKEs EXECUTE on ${fn} from authenticated`, () => {
      const re = new RegExp(
        `REVOKE[^;]*EXECUTE[^;]*ON\\s+FUNCTION\\s+${fn}[^;]*\\bauthenticated\\b[^;]*;`,
        'i',
      );
      expect(sql, `${fn} should REVOKE EXECUTE from authenticated`).toMatch(re);
    });
  }
});

describe('v1.0.0 Part C — code_attempts has Row Level Security enabled (DB-C-1)', () => {
  it('ALTER TABLE code_attempts ENABLE ROW LEVEL SECURITY appears', () => {
    expect(sql).toMatch(
      /ALTER\s+TABLE\s+code_attempts\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/i,
    );
  });
});

describe('v1.0.0 Part D — semantic_cache SELECT lockdown (DB-C-5)', () => {
  it('does NOT grant SELECT on semantic_cache to authenticated via policy', () => {
    // The previous "Allow read semantic_cache" policy let any authenticated
    // user read every other user's queries + AI responses. Must be removed.
    const offending =
      /CREATE\s+POLICY\s+"Allow read semantic_cache"\s+ON\s+semantic_cache\s+FOR\s+SELECT\s+TO\s+authenticated/i;
    expect(sql).not.toMatch(offending);
  });

  it('keeps service_role full access policy on semantic_cache', () => {
    // service_role still needs full access for cache hits via createAdminClient.
    expect(sql).toMatch(
      /CREATE\s+POLICY\s+"Service role full access to semantic_cache"\s+ON\s+semantic_cache\s+FOR\s+ALL\s+TO\s+service_role/i,
    );
  });
});

describe('v1.3.0 Part C — semantic_cache de-duplication (A-C-3)', () => {
  // A burst of N concurrent identical queries each lose the cache lookup race
  // and each call insert_semantic_cache → without a unique index this inflates
  // the HNSW index and serves a non-deterministic answer back. Fix is a
  // UNIQUE index on md5(query_text) + ON CONFLICT DO UPDATE in the RPC.
  it('declares a UNIQUE INDEX on md5(query_text) for semantic_cache', () => {
    expect(sql).toMatch(
      /CREATE\s+UNIQUE\s+INDEX[^;]*?semantic_cache[^;]*?\(\s*md5\s*\(\s*query_text\s*\)\s*\)/i,
    );
  });

  it('insert_semantic_cache uses ON CONFLICT DO UPDATE on the md5(query_text) target', () => {
    // Body of insert_semantic_cache must contain ON CONFLICT referencing the
    // expression index target, otherwise concurrent inserts duplicate rows.
    // The migration `CREATE OR REPLACE`s this function twice — only the last
    // definition wins at runtime, so we assert against that one.
    const matches = [
      ...sql.matchAll(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+insert_semantic_cache[\s\S]*?\$\$\s*;/gi),
    ];
    expect(matches.length).toBeGreaterThan(0);
    const lastBody = matches[matches.length - 1][0];
    expect(lastBody).toMatch(
      /ON\s+CONFLICT\s*\(\s*\(\s*md5\s*\(\s*query_text\s*\)\s*\)\s*\)\s*DO\s+UPDATE/i,
    );
  });
});

describe('v1.5.0 Part E — DB High Cleanup', () => {
  // DB-H-1: The last (winning) definition of check_rate_limit must use the
  // single-bigint advisory lock form. The two-bigint form silently truncates
  // each arg to INT, collapsing per-(user, endpoint) isolation under load.
  it('check_rate_limit uses single-bigint pg_advisory_xact_lock (DB-H-1)', () => {
    const matches = [
      ...sql.matchAll(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+check_rate_limit[\s\S]*?\$\$\s*;/gi),
    ];
    expect(matches.length).toBeGreaterThan(0);
    const lastBody = matches[matches.length - 1][0];
    // Must contain a single-arg pg_advisory_xact_lock(hashtextextended(...)).
    expect(lastBody).toMatch(
      /pg_advisory_xact_lock\s*\(\s*hashtextextended\s*\([^)]+\|\|[^)]+\)/i,
    );
    // And must NOT use the truncating two-arg form anywhere in the winning body.
    const twoArgRegex = /pg_advisory_xact_lock\s*\(\s*hashtextextended\s*\([^)]*\)\s*,\s*hashtextextended\s*\([^)]*\)\s*\)/i;
    expect(lastBody).not.toMatch(twoArgRegex);
  });

  // DB-H-2: every search RPC's outer LIMIT must be capped at 50 so a caller
  // can't ask for 10k rows + DoS the LLM context builder.
  it('every search RPC caps match_count at 50 (DB-H-2)', () => {
    // Find all LIMIT clauses that reference match_count.
    const limitClauses = sql.match(/LIMIT\s+[^;]*match_count[^;]*;/gi) || [];
    expect(limitClauses.length).toBeGreaterThan(0);
    for (const clause of limitClauses) {
      // Each must be of the form LIMIT LEAST(match_count, N) with N <= 50.
      expect(clause).toMatch(/LIMIT\s+LEAST\s*\(\s*match_count\s*,\s*(\d+)\s*\)/i);
      const n = Number(clause.match(/LEAST\s*\(\s*match_count\s*,\s*(\d+)\s*\)/i)![1]);
      expect(n).toBeLessThanOrEqual(50);
    }
  });

  // DB-H-3: the winning definition of get_all_users_admin must filter users
  // BEFORE aggregating sessions+messages, not after. We assert the order of
  // the CTEs (filtered_users defined before session_stats).
  //
  // Re-audit PSE1: actions/admin.ts calls the 6-arg keyset overload, NOT the
  // 4-arg form. The lockdown drop must hit BOTH signatures so the keyset
  // overload also gets the push-down body. Without this the v1.5.0 fix is
  // dead code.
  it('get_all_users_admin filters users before aggregating sessions — applies to 6-arg keyset overload (DB-H-3 push-down + PSE1)', () => {
    const matches = [
      ...sql.matchAll(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+get_all_users_admin[\s\S]*?\$\$\s*;/gi),
    ];
    expect(matches.length).toBeGreaterThan(0);
    const lastBody = matches[matches.length - 1][0];
    // Winning overload must be the 6-arg keyset signature (the active caller).
    expect(lastBody).toMatch(/p_after_created_at\s+TIMESTAMPTZ/i);
    expect(lastBody).toMatch(/p_after_id\s+UUID/i);
    // The push-down version declares a filtered_users CTE BEFORE session_stats.
    expect(lastBody).toMatch(/WITH\s+filtered_users\s+AS/i);
    expect(lastBody).toMatch(/session_stats[\s\S]*?filtered_users/i);
    // And v1.5.0 explicitly drops both overloads so the 4-arg form can't
    // shadow this one when PostgREST picks the function variant.
    expect(sql).toMatch(
      /DROP\s+FUNCTION\s+IF\s+EXISTS\s+get_all_users_admin\(UUID,\s*INT,\s*INT,\s*TEXT,\s*TIMESTAMPTZ,\s*UUID\)/i,
    );
  });

  // DB-H-5: refresh_analytics() must be explicitly grantable to service_role
  // so a Vercel cron / Supabase pg_cron job can fire it without service_role
  // owning the function (which CREATE OR REPLACE preserves but we want
  // belt + suspenders).
  it('refresh_analytics() is GRANT EXECUTE to service_role (DB-H-5)', () => {
    expect(sql).toMatch(
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+refresh_analytics\(\)\s+TO\s+service_role/i,
    );
  });
});

// ============================================================================
// v1.9.0 Part B — Database Mediums
// ============================================================================

describe('v1.9.0 Part B — Database Mediums', () => {
  // DB-M-2: an authenticated user must NOT be able to update their own role,
  // blocked flag, or password_hash via a direct PostgREST UPDATE that passes
  // the row-level "id = auth.uid()" RLS check. The fix is column-level grants
  // that restrict authenticated to the columns the profile UI legitimately
  // touches (full_name, username, email — verification fields are bumped via
  // service_role server actions).
  it('grants UPDATE on users to authenticated only on safe columns (DB-M-2)', () => {
    // The unconstrained `GRANT SELECT, UPDATE ON users TO authenticated` is
    // gone (or has been explicitly narrowed); the lockdown block must list
    // explicit columns. We assert there's a column-scoped UPDATE grant for
    // authenticated and there's no unscoped one in the *winning* lockdown.
    expect(sql).toMatch(
      /GRANT\s+UPDATE\s*\(\s*[^)]*\bfull_name\b[^)]*\)\s+ON\s+users\s+TO\s+authenticated/i,
    );
    expect(sql).toMatch(
      /GRANT\s+UPDATE\s*\(\s*[^)]*\busername\b[^)]*\)\s+ON\s+users\s+TO\s+authenticated/i,
    );
    // role / blocked / password_hash must NEVER appear inside the
    // authenticated-scoped UPDATE column list.
    const authUpdate = sql.match(
      /GRANT\s+UPDATE\s*\(([^)]*)\)\s+ON\s+users\s+TO\s+authenticated/gi,
    );
    expect(authUpdate).toBeTruthy();
    for (const grant of authUpdate!) {
      expect(grant).not.toMatch(/\brole\b/);
      expect(grant).not.toMatch(/\bblocked\b/);
      expect(grant).not.toMatch(/\bpassword_hash\b/);
      expect(grant).not.toMatch(/\btoken_version\b/);
    }
  });

  it('revokes the legacy unconstrained UPDATE on users from authenticated (DB-M-2)', () => {
    // Defense in depth: the lockdown block must explicitly REVOKE UPDATE ON
    // users so even if a future migration accidentally re-GRANTs it, the
    // revoke runs *after* and wins. The column-level grant then re-enables
    // only the safe columns.
    expect(sql).toMatch(
      /REVOKE\s+UPDATE\s+ON\s+users\s+FROM\s+[^;]*\bauthenticated\b[^;]*;/i,
    );
  });

  // DB-M-6: get_all_users_admin's OFFSET path must be capped so a caller
  // passing p_offset=10000 doesn't force a sequential scan of the entire
  // join. We cap at 1000 — past that the caller should be using the keyset
  // cursor path (admin UI already does).
  it('get_all_users_admin caps p_offset at 1000 (DB-M-6)', () => {
    const matches = [
      ...sql.matchAll(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+get_all_users_admin[\s\S]*?\$\$\s*;/gi),
    ];
    expect(matches.length).toBeGreaterThan(0);
    const lastBody = matches[matches.length - 1][0];
    // Cap can be either LEAST(p_offset, 1000) or LEAST(GREATEST(p_offset, 0), 1000).
    expect(lastBody).toMatch(/LEAST\s*\([\s\S]*?p_offset[\s\S]*?,\s*1000\s*\)/i);
  });

  // DB-M-7: save_document_tree must reject pathologically large tree_data
  // blobs so a malformed PDF outline can't bloat document_trees. Re-audit
  // C-1 + M-3 (v1.9.0): keep the original (TEXT, INT, JSONB) RETURNS UUID
  // signature so CREATE OR REPLACE actually replaces (not creates an
  // overload), and raise the cap from 1 MB to 4 MB so legitimate large
  // outlines don't trip it.
  it('save_document_tree raises on tree_data > 4MB and keeps the TEXT/UUID signature (DB-M-7 + re-audit C-1/M-3)', () => {
    const matches = [
      ...sql.matchAll(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+save_document_tree[\s\S]*?\$\$\s*;/gi),
    ];
    expect(matches.length).toBeGreaterThan(0);
    const lastBody = matches[matches.length - 1][0];
    expect(lastBody).toMatch(/pg_column_size\s*\(\s*p_tree_data\s*\)/i);
    expect(lastBody).toMatch(/RAISE\s+EXCEPTION[^;]*TREE_TOO_LARGE/i);
    // Winning body MUST use TEXT (matches original) — VARCHAR(64) would
    // create a second overload instead of replacing.
    expect(lastBody).toMatch(/p_document_name\s+TEXT/i);
    expect(lastBody).toMatch(/RETURNS\s+UUID/i);
    // Cap bumped to 4 MB so 1k-page outlines don't silently disable
    // tree-reasoning. Allowed range: [4 MB, 8 MB].
    const capMatch = lastBody.match(/(\d{6,7})\b/);
    expect(capMatch).toBeTruthy();
    const cap = Number(capMatch![1]);
    expect(cap).toBeGreaterThanOrEqual(4194304);
    expect(cap).toBeLessThanOrEqual(8388608);
  });

  // Re-audit M-1 (v1.9.0): the named-parameter RPC call at actions/admin.ts:144
  // passes `p_admin_id`; renaming the function's first parameter to
  // p_caller_id would break every admin user-list call at runtime. Pin the
  // expected parameter name.
  it('get_all_users_admin keeps p_admin_id as the first parameter (re-audit M-1)', () => {
    const matches = [
      ...sql.matchAll(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+get_all_users_admin[\s\S]*?\$\$\s*;/gi),
    ];
    expect(matches.length).toBeGreaterThan(0);
    const lastBody = matches[matches.length - 1][0];
    expect(lastBody).toMatch(/\(\s*p_admin_id\s+UUID/i);
  });

  // DB-M-8: HNSW ef_construction = 128 (was 64). Better recall on multi-doc
  // corpora at the cost of slightly slower index builds during ingestion.
  // Both indexes need to be re-declared with the new value.
  it('HNSW indexes use ef_construction = 128 (DB-M-8)', () => {
    // Find every USING hnsw(...) cosine_ops definition.
    const hnswMatches = [
      ...sql.matchAll(/USING\s+hnsw[\s\S]*?ef_construction\s*=\s*(\d+)/gi),
    ];
    expect(hnswMatches.length).toBeGreaterThan(0);
    for (const m of hnswMatches) {
      expect(Number(m[1])).toBeGreaterThanOrEqual(128);
    }
  });
});
