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
