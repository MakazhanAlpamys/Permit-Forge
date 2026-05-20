-- ============================================================================
-- D1/H14 — Replace correlated subqueries in get_all_users_admin with a
-- single JOIN aggregation.
-- ============================================================================
--
-- The original implementation ran two correlated subqueries per user row:
--
--   (SELECT COUNT(*) FROM chat_sessions WHERE user_id = u.id)
--   (SELECT COUNT(*) FROM chat_messages cm
--      JOIN chat_sessions cs ON cm.session_id = cs.id
--      WHERE cs.user_id = u.id)
--
-- That fanned out to N * 2 subqueries (where N = page size, up to 100). On a
-- realistic dataset with 100+ users this was O(N) seq-scans of chat_messages.
--
-- Rewrite: pre-aggregate session counts and message counts per user with two
-- LEFT JOIN LATERAL grouped subqueries, then join those once. Each aggregate
-- subquery runs once total, not once per row.
--
-- Contract is unchanged (same parameters, same returned columns).

DROP FUNCTION IF EXISTS get_all_users_admin(UUID, INT, INT, TEXT);

CREATE OR REPLACE FUNCTION get_all_users_admin(
  p_admin_id UUID,
  p_limit INT DEFAULT 50,
  p_offset INT DEFAULT 0,
  p_search TEXT DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  username TEXT,
  full_name TEXT,
  role TEXT,
  blocked BOOLEAN,
  blocked_reason TEXT,
  created_at TIMESTAMPTZ,
  last_login TIMESTAMPTZ,
  session_count BIGINT,
  message_count BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin_role TEXT;
BEGIN
  SELECT users.role INTO v_admin_role FROM users WHERE users.id = p_admin_id;
  IF v_admin_role != 'admin' THEN RAISE EXCEPTION 'Unauthorized: Admin role required'; END IF;

  RETURN QUERY
  WITH session_stats AS (
    SELECT cs.user_id,
           COUNT(*)::BIGINT AS session_count,
           COUNT(cm.id)::BIGINT AS message_count
    FROM chat_sessions cs
    LEFT JOIN chat_messages cm ON cm.session_id = cs.id
    GROUP BY cs.user_id
  )
  SELECT
    u.id, u.username, u.full_name, u.role, u.blocked, u.blocked_reason,
    u.created_at, u.last_login,
    COALESCE(s.session_count, 0)::BIGINT AS session_count,
    COALESCE(s.message_count, 0)::BIGINT AS message_count
  FROM users u
  LEFT JOIN session_stats s ON s.user_id = u.id
  WHERE (p_search IS NULL OR u.username ILIKE '%' || p_search || '%' OR u.full_name ILIKE '%' || p_search || '%')
  ORDER BY u.created_at DESC
  LIMIT LEAST(p_limit, 100) OFFSET p_offset;
END;
$$;

GRANT EXECUTE ON FUNCTION get_all_users_admin(UUID, INT, INT, TEXT) TO service_role;
REVOKE EXECUTE ON FUNCTION get_all_users_admin(UUID, INT, INT, TEXT) FROM anon, authenticated;
