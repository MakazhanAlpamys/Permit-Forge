-- ============================================================================
-- D11/M19 — Bound document_registry.id / display_name / badge_color
-- ============================================================================
--
-- - id is sanitized to lowercase alphanumeric + hyphens in the app
--   layer (actions/documents.ts). It's used as a storage path segment
--   (documents/{id}/file.pdf) and an FK target (D18); 64 chars is well
--   inside any filesystem / btree limit and matches the worst case
--   a user is likely to type.
-- - display_name shows in headers and select dropdowns; 128 chars is
--   generous (typical: ~30 chars).
-- - badge_color stores a Tailwind class string (~50 chars in practice);
--   128 is plenty of headroom for future variants.
--
-- The defensive UPDATEs below truncate any pre-existing oversize row so
-- the ALTER TYPE casts can't fail.

UPDATE document_registry
   SET id = LEFT(id, 64)
 WHERE LENGTH(id) > 64;

UPDATE document_registry
   SET display_name = LEFT(display_name, 128)
 WHERE LENGTH(display_name) > 128;

UPDATE document_registry
   SET badge_color = LEFT(badge_color, 128)
 WHERE badge_color IS NOT NULL
   AND LENGTH(badge_color) > 128;

ALTER TABLE document_registry
  ALTER COLUMN id           TYPE VARCHAR(64)  USING id::VARCHAR(64),
  ALTER COLUMN display_name TYPE VARCHAR(128) USING display_name::VARCHAR(128),
  ALTER COLUMN badge_color  TYPE VARCHAR(128) USING badge_color::VARCHAR(128);
