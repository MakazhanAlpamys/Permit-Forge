-- ============================================================================
-- D9/M17 — Tighten users.verification_code / reset_code to CHAR(6)
-- ============================================================================
--
-- Both columns are only ever written via generateSixDigitCode() in
-- lib/email.ts, which produces exactly 6 numeric characters. The
-- columns were TEXT, which accepted arbitrarily long values (e.g. via
-- a future code path that forgot to validate). CHAR(6) enforces the
-- length at the type level.
--
-- Existing values are 6 chars by construction, so no truncation is
-- needed in practice. The LEFT(_, 6) below is defensive: if any stale
-- row has a longer value it'll be trimmed; NULLs are preserved.
--
-- CHAR(6) values are returned without padding when the stored value
-- already fills the column (always the case here), so safeEqual() in
-- the verification flow continues to work without changes.

UPDATE users
   SET verification_code = LEFT(verification_code, 6)
 WHERE verification_code IS NOT NULL
   AND LENGTH(verification_code) <> 6;

UPDATE users
   SET reset_code = LEFT(reset_code, 6)
 WHERE reset_code IS NOT NULL
   AND LENGTH(reset_code) <> 6;

ALTER TABLE users
  ALTER COLUMN verification_code TYPE CHAR(6) USING verification_code::CHAR(6),
  ALTER COLUMN reset_code        TYPE CHAR(6) USING reset_code::CHAR(6);
