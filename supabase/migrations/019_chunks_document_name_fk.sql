-- ============================================================================
-- D18/P2-A8 — Real FK from dubai_code_chunks.document_name → document_registry.id
-- ============================================================================
--
-- The two tables were related by convention only — nothing in the schema
-- stopped an ingestion path from inserting chunks for a document_name
-- that didn't exist in the registry (or vice versa, an admin from
-- hard-deleting a registry row while chunks still pointed at it).
--
-- Steps:
--   1. Defensive cleanup — auto-create inactive registry stubs for any
--      orphan document_name found in dubai_code_chunks. This avoids
--      losing chunks but flags the row as inactive so the document
--      selector / dashboard ignore it until an admin fills in metadata.
--   2. ALTER COLUMN to match document_registry.id's VARCHAR(64) so the
--      FK type lines up (chunks.document_name was TEXT before).
--   3. Add FK with ON DELETE CASCADE. delete_document_atomic already
--      deletes child chunks before the registry row in the hard-delete
--      path; CASCADE is belt-and-braces for any future deletion path.

-- 1. Backfill orphan stubs.
INSERT INTO document_registry (id, display_name, short_name, file_name, is_active)
SELECT DISTINCT
       LEFT(c.document_name, 64),
       LEFT(c.document_name, 128),
       LEFT(c.document_name, 64),
       'unknown.pdf',
       FALSE
  FROM dubai_code_chunks c
 WHERE c.document_name IS NOT NULL
   AND c.document_name <> ''
   AND NOT EXISTS (
     SELECT 1 FROM document_registry r WHERE r.id = LEFT(c.document_name, 64)
   )
ON CONFLICT (id) DO NOTHING;

-- 1b. If any chunks still have an empty document_name, route them to the
-- 'unknown' stub. Create the stub if it doesn't exist.
INSERT INTO document_registry (id, display_name, short_name, file_name, is_active)
VALUES ('unknown', 'Unknown (orphan chunks)', 'UNK', 'unknown.pdf', FALSE)
ON CONFLICT (id) DO NOTHING;

UPDATE dubai_code_chunks
   SET document_name = 'unknown'
 WHERE document_name IS NULL OR document_name = '';

-- 1c. Truncate any document_name longer than 64 to match registry.id.
UPDATE dubai_code_chunks
   SET document_name = LEFT(document_name, 64)
 WHERE LENGTH(document_name) > 64;

-- 2. Bring the column type in line with document_registry.id.
ALTER TABLE dubai_code_chunks
  ALTER COLUMN document_name TYPE VARCHAR(64)
    USING document_name::VARCHAR(64);

-- 3. The FK itself.
ALTER TABLE dubai_code_chunks
  DROP CONSTRAINT IF EXISTS dubai_code_chunks_document_name_fkey;

ALTER TABLE dubai_code_chunks
  ADD CONSTRAINT dubai_code_chunks_document_name_fkey
  FOREIGN KEY (document_name) REFERENCES document_registry(id) ON DELETE CASCADE;
