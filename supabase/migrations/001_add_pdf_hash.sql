-- ============================================================================
-- B5 — Track PDF content hash on document_registry
-- ============================================================================
--
-- pdf_hash:               SHA-256 of the most recently uploaded PDF.
-- last_ingested_pdf_hash: SHA-256 of the PDF that produced the *current* chunk
--                         set. When these diverge AND chunks already exist,
--                         the admin UI prompts before clearing prior chunks
--                         (avoids silently mixing old + new chunks).
--
-- Idempotent — safe to re-run after a fresh 000_full_setup.sql.

ALTER TABLE document_registry
  ADD COLUMN IF NOT EXISTS pdf_hash TEXT,
  ADD COLUMN IF NOT EXISTS last_ingested_pdf_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_document_registry_pdf_hash
  ON document_registry(pdf_hash)
  WHERE pdf_hash IS NOT NULL;
