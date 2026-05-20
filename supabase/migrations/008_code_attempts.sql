-- ============================================================================
-- C15H/M4 — DB-backed code-attempt counter
-- ============================================================================
--
-- The in-memory Map in lib/code-verification.ts didn't survive serverless
-- restarts or scale across instances, so an attacker could iterate codes by
-- triggering a new function instance per attempt. This table moves the
-- counter into Postgres.
--
-- key shape: 'verify:<email>' or 'reset:<email>' (already used by callers).
-- Free-form TEXT so callers don't need a new schema if we add more purposes.

CREATE TABLE IF NOT EXISTS code_attempts (
  key TEXT PRIMARY KEY,
  count INT NOT NULL DEFAULT 0,
  first_attempt TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS code_attempts_first_attempt_idx
  ON code_attempts(first_attempt);

GRANT SELECT, INSERT, UPDATE, DELETE ON code_attempts TO service_role;

-- Atomic increment + check. Returns the new count and whether the caller
-- should proceed (count <= p_max within the window). On a window rollover
-- (first_attempt older than window) the counter resets to 1.
CREATE OR REPLACE FUNCTION incr_code_attempt(
  p_key TEXT,
  p_window_seconds INT DEFAULT 900,
  p_max INT DEFAULT 5
)
RETURNS TABLE (
  allowed BOOLEAN,
  current_count INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := NOW();
  v_cutoff TIMESTAMPTZ;
  v_row RECORD;
  v_new_count INT;
BEGIN
  v_cutoff := v_now - (p_window_seconds || ' seconds')::INTERVAL;

  INSERT INTO code_attempts (key, count, first_attempt)
  VALUES (p_key, 1, v_now)
  ON CONFLICT (key) DO UPDATE
    SET count = CASE
                  WHEN code_attempts.first_attempt < v_cutoff THEN 1
                  ELSE code_attempts.count + 1
                END,
        first_attempt = CASE
                          WHEN code_attempts.first_attempt < v_cutoff THEN v_now
                          ELSE code_attempts.first_attempt
                        END
  RETURNING code_attempts.count INTO v_new_count;

  -- Opportunistic cleanup of unrelated stale rows on every write
  IF random() < 0.05 THEN
    DELETE FROM code_attempts WHERE first_attempt < v_now - INTERVAL '1 day';
  END IF;

  SELECT * INTO v_row FROM (SELECT TRUE AS dummy) AS d; -- noop, satisfies plpgsql
  RETURN QUERY SELECT (v_new_count <= p_max), v_new_count;
END;
$$;

GRANT EXECUTE ON FUNCTION incr_code_attempt(TEXT, INT, INT) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION clear_code_attempt(p_key TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  DELETE FROM code_attempts WHERE key = p_key;
END;
$$;

GRANT EXECUTE ON FUNCTION clear_code_attempt(TEXT) TO authenticated, service_role;
