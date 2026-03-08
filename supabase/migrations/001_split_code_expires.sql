-- Migration 001: Bug fixes for code expiry collision + IP rate limiting

-- ============================================================================
-- Fix #1: Split shared code_expires_at into separate expiry columns
-- Fixes: verification_code and reset_code both wrote to code_expires_at,
--        causing one to silently overwrite the other's expiry timestamp.
-- ============================================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_code_expires_at TIMESTAMPTZ;

-- Migrate existing data: users with a reset_code get their current expiry moved over
UPDATE users SET reset_code_expires_at = code_expires_at WHERE reset_code IS NOT NULL;

-- ============================================================================
-- Fix #2: IP-based rate limit table (for pre-login brute-force protection)
-- The existing rate_limits table requires a UUID user_id, which doesn't exist
-- before login. This table allows rate limiting by IP address.
-- ============================================================================

CREATE TABLE IF NOT EXISTS ip_rate_limits (
  id BIGSERIAL PRIMARY KEY,
  ip_address TEXT NOT NULL,
  request_timestamp TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ip_rate_limits_ip_time_idx
  ON ip_rate_limits(ip_address, request_timestamp DESC);

-- RLS: service_role only (written exclusively by server-side code)
ALTER TABLE ip_rate_limits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access to ip_rate_limits" ON ip_rate_limits
  FOR ALL TO service_role USING (true) WITH CHECK (true);

GRANT ALL ON ip_rate_limits TO service_role;
GRANT USAGE, SELECT ON SEQUENCE ip_rate_limits_id_seq TO service_role;

-- Function: check and record an IP-based rate limit hit
CREATE OR REPLACE FUNCTION check_ip_rate_limit(
  p_ip TEXT,
  p_window_seconds INT DEFAULT 60,
  p_max_requests INT DEFAULT 10
)
RETURNS TABLE(allowed BOOLEAN, request_count INT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_window_start TIMESTAMPTZ;
  v_request_count BIGINT;
BEGIN
  v_window_start := NOW() - (p_window_seconds || ' seconds')::INTERVAL;

  SELECT COUNT(*)
  INTO v_request_count
  FROM ip_rate_limits
  WHERE ip_address = p_ip AND request_timestamp > v_window_start;

  IF v_request_count >= p_max_requests THEN
    RETURN QUERY SELECT FALSE, v_request_count::INT;
    RETURN;
  END IF;

  -- Allowed — record request and cleanup old entries
  INSERT INTO ip_rate_limits (ip_address, request_timestamp) VALUES (p_ip, NOW());
  DELETE FROM ip_rate_limits
    WHERE ip_address = p_ip AND request_timestamp < NOW() - INTERVAL '1 hour';

  RETURN QUERY SELECT TRUE, (v_request_count + 1)::INT;
END;
$$;

REVOKE ALL ON FUNCTION check_ip_rate_limit(TEXT, INT, INT) FROM public, anon;
GRANT EXECUTE ON FUNCTION check_ip_rate_limit(TEXT, INT, INT) TO service_role;
