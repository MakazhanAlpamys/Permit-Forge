-- ============================================================================
-- D19/P2-A9 — Advisory-lock-guarded ingestion start
-- ============================================================================
--
-- Two parallel /api/ingest calls for the same document_id could both
-- pass the prior "is ingestion in progress?" check (or do no check at
-- all) and both insert chunks, producing duplicates. Supabase uses a
-- connection pool so we can't safely hold a session-level advisory
-- lock for the whole ingestion run.
--
-- Instead: this RPC takes a per-document pg_advisory_xact_lock (held
-- only for the duration of *this* transaction, then released),
-- atomically reads ingestion_state inside that lock, and either:
--   - returns FALSE if a run is already 'pending' (caller should bail)
--   - sets ingestion_state='pending' and returns TRUE (caller proceeds)
--
-- The lock serializes the read+write so two concurrent claims can't
-- both see "no pending run" and both proceed. The ingestion_state flag
-- carries the "in progress" signal forward across the rest of the run.
--
-- Callers MUST eventually flip ingestion_state out of 'pending' (either
-- to 'completed', 'failed', or 'aborted') — the existing
-- markIngestionState() helper in app/api/ingest/route.ts already does
-- this in the success/error/finally branches.

DROP FUNCTION IF EXISTS try_start_ingestion(TEXT);

CREATE OR REPLACE FUNCTION try_start_ingestion(p_document_id TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_current_state TEXT;
BEGIN
  -- Per-document advisory lock, transaction-scoped. Two concurrent
  -- callers for the same id will serialize here; for different ids the
  -- locks are independent so ingestion of doc-A doesn't block doc-B.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_document_id, 0));

  SELECT ingestion_state INTO v_current_state
    FROM document_registry
   WHERE id = p_document_id
   FOR UPDATE;

  -- A row that doesn't exist yet shouldn't be ingestable — the admin
  -- must register the document first. Refuse rather than auto-create.
  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  IF v_current_state = 'pending' THEN
    RETURN FALSE;
  END IF;

  UPDATE document_registry
     SET ingestion_state = 'pending',
         ingestion_started_at = NOW(),
         ingestion_finished_at = NULL,
         updated_at = NOW()
   WHERE id = p_document_id;

  RETURN TRUE;
END;
$$;

GRANT EXECUTE ON FUNCTION try_start_ingestion(TEXT) TO service_role;
REVOKE EXECUTE ON FUNCTION try_start_ingestion(TEXT) FROM anon, authenticated;
