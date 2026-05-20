-- ============================================================================
-- B4 — Track explicit ingestion state on document_registry
-- ============================================================================
--
-- ingestion_state is one of:
--   NULL       — never ingested (default)
--   'pending'  — an ingestion job is currently running
--   'completed'— last ingestion finished successfully
--   'failed'   — last ingestion errored or was aborted
--   'aborted'  — client cancelled the ingestion mid-stream
--
-- Used by the admin UI to surface which documents are mid-ingest, and to mark
-- abandoned runs so admin can spot them after a server crash / browser close.
--
-- ingestion_started_at / ingestion_finished_at let the UI show wall-clock
-- duration and detect runs older than the longest-allowed ingestion window
-- (those are effectively stuck and should be re-tried).

ALTER TABLE document_registry
  ADD COLUMN IF NOT EXISTS ingestion_state TEXT
    CHECK (ingestion_state IS NULL OR ingestion_state IN ('pending', 'completed', 'failed', 'aborted')),
  ADD COLUMN IF NOT EXISTS ingestion_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ingestion_finished_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_document_registry_ingestion_state
  ON document_registry(ingestion_state)
  WHERE ingestion_state IS NOT NULL;
