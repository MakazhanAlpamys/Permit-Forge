-- ============================================================================
-- C10H — Atomic check_rate_limit
-- ============================================================================
--
-- The previous RPC did:
--   1. SELECT COUNT(*), MAX(request_timestamp) FROM rate_limits WHERE user=$1
--   2. compare against limits (in pl/pgsql)
--   3. INSERT a new row
--
-- Between steps 1 and 3 two concurrent callers can both observe
-- count < max_requests and both insert — the cap is bypassed.
--
-- Fix: take a per-user transaction-scoped advisory lock at the top of the
-- function. Two callers with the same user_id serialize through the lock
-- (cheap — int8 hash, no table involved). Different users are unaffected.
--
-- We also fold the cleanup-after-insert into the same transaction so it
-- can't leave stale rows behind on rollback.

CREATE OR REPLACE FUNCTION check_rate_limit(
  p_user_id UUID,
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
BEGIN
  -- C10H: per-user advisory lock to serialize concurrent rate-limit checks.
  -- hashtextextended is deterministic per UUID; the lock auto-releases at
  -- transaction end. Different users hash to different ints → no contention.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  v_window_start := NOW() - (p_window_seconds || ' seconds')::INTERVAL;

  SELECT COUNT(*), MAX(request_timestamp)
  INTO v_request_count, v_last_request
  FROM rate_limits
  WHERE user_id = p_user_id AND request_timestamp > v_window_start;

  -- Check minimum interval
  IF v_last_request IS NOT NULL THEN
    v_ms_since_last := EXTRACT(EPOCH FROM (NOW() - v_last_request)) * 1000;
    IF v_ms_since_last < p_min_interval_ms THEN
      RETURN QUERY SELECT FALSE, (p_min_interval_ms - v_ms_since_last)::INT, v_request_count::INT;
      RETURN;
    END IF;
  END IF;

  -- Check max requests
  IF v_request_count >= p_max_requests THEN
    RETURN QUERY SELECT FALSE, (p_window_seconds * 1000)::INT, v_request_count::INT;
    RETURN;
  END IF;

  -- Allowed — record and cleanup. Both writes are now inside the locked
  -- region, so a concurrent caller can't observe the pre-insert count.
  INSERT INTO rate_limits (user_id, request_timestamp) VALUES (p_user_id, NOW());
  DELETE FROM rate_limits WHERE user_id = p_user_id AND request_timestamp < NOW() - INTERVAL '1 hour';

  RETURN QUERY SELECT TRUE, 0, (v_request_count + 1)::INT;
END;
$$;

GRANT EXECUTE ON FUNCTION check_rate_limit(UUID, INT, INT, INT) TO authenticated, service_role;
