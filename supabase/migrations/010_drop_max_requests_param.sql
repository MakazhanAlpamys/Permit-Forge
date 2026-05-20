-- ============================================================================
-- C22H/M20 — Move per-endpoint rate-limit thresholds into the RPC body
-- ============================================================================
--
-- Previously each call site could pass its own p_window_seconds /
-- p_max_requests / p_min_interval_ms, which meant a careless client could
-- effectively disable the cap (e.g. p_max_requests=99999). Per-endpoint
-- limits now live in a CASE inside the function — callers can only pick the
-- endpoint label.
--
-- p_endpoint is still required (defaults to 'default'). For backwards compat
-- the old window/max/interval parameters remain in the signature but are
-- accepted only when endpoint='default'; for any named endpoint they are
-- ignored and the hardcoded values win.

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
  v_window_seconds INT;
  v_max_requests INT;
  v_min_interval_ms INT;
BEGIN
  v_endpoint := COALESCE(p_endpoint, 'default');

  -- Per-endpoint limits. Anything not listed falls back to the default bucket
  -- (10 req / 60s, 2s minimum interval). To add a new endpoint, add a WHEN
  -- branch here; callers don't get to pick their own cap anymore.
  CASE v_endpoint
    WHEN 'chat'                                 THEN v_window_seconds := 60;   v_max_requests := 20; v_min_interval_ms := 1500;
    WHEN 'permit_certificate'                   THEN v_window_seconds := 60;   v_max_requests := 5;  v_min_interval_ms := 1000;
    WHEN 'pdf_ingest'                           THEN v_window_seconds := 300;  v_max_requests := 3;  v_min_interval_ms := 5000;
    WHEN 'createPermit'                         THEN v_window_seconds := 60;   v_max_requests := 10; v_min_interval_ms := 1000;
    WHEN 'updatePermitBuildingDetails'          THEN v_window_seconds := 60;   v_max_requests := 30; v_min_interval_ms := 500;
    WHEN 'updatePermitComplianceRequirements'   THEN v_window_seconds := 60;   v_max_requests := 30; v_min_interval_ms := 500;
    WHEN 'runComplianceCheck'                   THEN v_window_seconds := 300;  v_max_requests := 5;  v_min_interval_ms := 10000;
    WHEN 'reviewPermit'                         THEN v_window_seconds := 60;   v_max_requests := 30; v_min_interval_ms := 500;
    WHEN 'setPermitUnderReview'                 THEN v_window_seconds := 60;   v_max_requests := 30; v_min_interval_ms := 500;
    WHEN 'blockUser'                            THEN v_window_seconds := 60;   v_max_requests := 20; v_min_interval_ms := 500;
    WHEN 'updateUserRole'                       THEN v_window_seconds := 60;   v_max_requests := 20; v_min_interval_ms := 500;
    WHEN 'adminCreateUser'                      THEN v_window_seconds := 60;   v_max_requests := 10; v_min_interval_ms := 1000;
    WHEN 'adminDeleteUser'                      THEN v_window_seconds := 60;   v_max_requests := 10; v_min_interval_ms := 1000;
    WHEN 'adminResetPassword'                   THEN v_window_seconds := 60;   v_max_requests := 10; v_min_interval_ms := 1000;
    WHEN 'default'                              THEN v_window_seconds := COALESCE(p_window_seconds, 60);
                                                      v_max_requests := COALESCE(p_max_requests, 10);
                                                      v_min_interval_ms := COALESCE(p_min_interval_ms, 2000);
    ELSE                                              v_window_seconds := 60;  v_max_requests := 10; v_min_interval_ms := 2000;
  END CASE;

  -- C10H + C11H: per-(user, endpoint) advisory lock, transaction-scoped.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_user_id::text, 0),
    hashtextextended(v_endpoint, 0)
  );

  v_window_start := NOW() - (v_window_seconds || ' seconds')::INTERVAL;

  SELECT COUNT(*), MAX(request_timestamp)
  INTO v_request_count, v_last_request
  FROM rate_limits
  WHERE user_id = p_user_id
    AND endpoint = v_endpoint
    AND request_timestamp > v_window_start;

  IF v_last_request IS NOT NULL THEN
    v_ms_since_last := EXTRACT(EPOCH FROM (NOW() - v_last_request)) * 1000;
    IF v_ms_since_last < v_min_interval_ms THEN
      RETURN QUERY SELECT FALSE, (v_min_interval_ms - v_ms_since_last)::INT, v_request_count::INT;
      RETURN;
    END IF;
  END IF;

  IF v_request_count >= v_max_requests THEN
    RETURN QUERY SELECT FALSE, (v_window_seconds * 1000)::INT, v_request_count::INT;
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
