-- ============================================================================
-- Data Cleanup Functions
-- ============================================================================
-- Provides maintenance functions to clean up old data.
-- Can be scheduled via Supabase pg_cron or triggered manually via admin API.
-- ============================================================================

-- -----------------------------------------------------------------------------
-- Clean old chat sessions (no activity in retention_days)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION cleanup_old_sessions(retention_days INT DEFAULT 90)
RETURNS TABLE(deleted_count BIGINT) AS $$
DECLARE
  _deleted BIGINT;
BEGIN
  WITH deleted AS (
    DELETE FROM chat_sessions
    WHERE updated_at < NOW() - (retention_days || ' days')::INTERVAL
    RETURNING id
  )
  SELECT COUNT(*) INTO _deleted FROM deleted;

  RETURN QUERY SELECT _deleted;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- -----------------------------------------------------------------------------
-- Clean old audit logs (older than retention_days)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION cleanup_old_audit_logs(retention_days INT DEFAULT 365)
RETURNS TABLE(deleted_count BIGINT) AS $$
DECLARE
  _deleted BIGINT;
BEGIN
  WITH deleted AS (
    DELETE FROM audit_logs
    WHERE created_at < NOW() - (retention_days || ' days')::INTERVAL
    RETURNING id
  )
  SELECT COUNT(*) INTO _deleted FROM deleted;

  RETURN QUERY SELECT _deleted;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- -----------------------------------------------------------------------------
-- Clean expired rate limit entries (older than 1 hour)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION cleanup_expired_rate_limits()
RETURNS TABLE(deleted_count BIGINT) AS $$
DECLARE
  _deleted BIGINT;
BEGIN
  WITH deleted AS (
    DELETE FROM rate_limits
    WHERE request_timestamp < NOW() - INTERVAL '1 hour'
    RETURNING id
  )
  SELECT COUNT(*) INTO _deleted FROM deleted;

  RETURN QUERY SELECT _deleted;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- -----------------------------------------------------------------------------
-- Run all cleanup functions at once
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION run_all_cleanup(
  session_retention_days INT DEFAULT 90,
  audit_retention_days INT DEFAULT 365
)
RETURNS TABLE(
  sessions_deleted BIGINT,
  audit_logs_deleted BIGINT,
  rate_limits_deleted BIGINT
) AS $$
DECLARE
  _sessions BIGINT;
  _audits BIGINT;
  _rates BIGINT;
BEGIN
  SELECT deleted_count INTO _sessions FROM cleanup_old_sessions(session_retention_days);
  SELECT deleted_count INTO _audits FROM cleanup_old_audit_logs(audit_retention_days);
  SELECT deleted_count INTO _rates FROM cleanup_expired_rate_limits();

  RETURN QUERY SELECT _sessions, _audits, _rates;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
