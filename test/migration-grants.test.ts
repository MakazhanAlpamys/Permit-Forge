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
