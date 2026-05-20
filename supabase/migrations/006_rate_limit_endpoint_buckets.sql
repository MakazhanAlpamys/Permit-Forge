-- ============================================================================
-- C11H + C22H prep — per-endpoint rate-limit buckets
-- ============================================================================
--
-- The old check_rate_limit was keyed on user_id only, so chat streaming,
-- permit submission, certificate downloads, and admin mutations all shared
-- one bucket. A heavy endpoint (chat) starved everything else.
--
-- This migration:
--   1. Adds rate_limits.endpoint TEXT, defaulting to 'default' for existing rows.
--   2. Replaces the single (user_id, ts) index with (user_id, endpoint, ts).
--   3. Re-creates check_rate_limit with an optional p_endpoint param. The
--      window query is now WHERE user_id=$1 AND endpoint=$2. Per-user advisory
--      lock (C10H) becomes per-(user, endpoint) so concurrent endpoints don't
--      block each other.

ALTER TABLE rate_limits ADD COLUMN IF NOT EXISTS endpoint TEXT NOT NULL DEFAULT 'default';

DROP INDEX IF EXISTS rate_limits_user_time_idx;
CREATE INDEX IF NOT EXISTS rate_limits_user_endpoint_time_idx
  ON rate_limits(user_id, endpoint, request_timestamp DESC);

-- Drop and recreate so the parameter list changes cleanly. Postgres requires
-- a drop because adding a new parameter is treated as a new overload.
DROP FUNCTION IF EXISTS check_rate_limit(UUID, INT, INT, INT);
DROP FUNCTION IF EXISTS check_rate_limit(UUID, TEXT, INT, INT, INT);

CREATE OR REPLACE FUNCTION check_rate_limit(
  p_user_id UUID,
  p_endpoint TEXT DEFAULT 'default',
  p_window_seconds INT DEFAULT 60,
  p_max_requests INT DEFAULT 10,
  p_min_interval_ms INT DEFAULT 2000
)
RETURNS TABLE (
  allowed BOOLEAN,
  retry_after_ms INT,
  current_count INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_window_start TIMESTAMPTZ;
  v_last_request TIMESTAMPTZ;
  v_request_count INT;
  v_ms_since_last INT;
  v_endpoint TEXT;
BEGIN
  v_endpoint := COALESCE(p_endpoint, 'default');

  -- C10H: per-(user, endpoint) advisory lock, transaction-scoped.
  -- Two callers for the same user+endpoint serialize; different endpoints
  -- under the same user don't contend with each other.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_user_id::text, 0),
    hashtextextended(v_endpoint, 0)
  );

  v_window_start := NOW() - (p_window_seconds || ' seconds')::INTERVAL;

  SELECT COUNT(*), MAX(request_timestamp)
  INTO v_request_count, v_last_request
  FROM rate_limits
  WHERE user_id = p_user_id
    AND endpoint = v_endpoint
    AND request_timestamp > v_window_start;

  IF v_last_request IS NOT NULL THEN
    v_ms_since_last := EXTRACT(EPOCH FROM (NOW() - v_last_request)) * 1000;
    IF v_ms_since_last < p_min_interval_ms THEN
      RETURN QUERY SELECT FALSE, (p_min_interval_ms - v_ms_since_last)::INT, v_request_count::INT;
      RETURN;
    END IF;
  END IF;

  IF v_request_count >= p_max_requests THEN
    RETURN QUERY SELECT FALSE, (p_window_seconds * 1000)::INT, v_request_count::INT;
    RETURN;
  END IF;

  INSERT INTO rate_limits (user_id, endpoint, request_timestamp)
  VALUES (p_user_id, v_endpoint, NOW());

  DELETE FROM rate_limits
  WHERE user_id = p_user_id
    AND endpoint = v_endpoint
    AND request_timestamp < NOW() - INTERVAL '1 hour';

  RETURN QUERY SELECT TRUE, 0, (v_request_count + 1)::INT;
END;
$$;

GRANT EXECUTE ON FUNCTION check_rate_limit(UUID, TEXT, INT, INT, INT) TO authenticated, service_role;
