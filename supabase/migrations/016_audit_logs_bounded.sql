-- ============================================================================
-- D10/M18 — Bound audit_logs.ip_address (45) and user_agent (512)
-- ============================================================================
--
-- ip_address is at most 45 chars (IPv6 with embedded IPv4, e.g.
--   "0000:0000:0000:0000:0000:ffff:255.255.255.255" = 45 chars).
-- user_agent strings rarely exceed 256 chars; 512 leaves headroom for
-- unusual browsers without inviting log-bloat attacks (we already trim
-- on the app side, but the DB constraint is defense in depth).
--
-- Existing rows are truncated defensively before the type change so
-- the ALTER TYPE cast can't fail.

UPDATE audit_logs
   SET ip_address = LEFT(ip_address, 45)
 WHERE ip_address IS NOT NULL
   AND LENGTH(ip_address) > 45;

UPDATE audit_logs
   SET user_agent = LEFT(user_agent, 512)
 WHERE user_agent IS NOT NULL
   AND LENGTH(user_agent) > 512;

ALTER TABLE audit_logs
  ALTER COLUMN ip_address TYPE VARCHAR(45)  USING ip_address::VARCHAR(45),
  ALTER COLUMN user_agent TYPE VARCHAR(512) USING user_agent::VARCHAR(512);
