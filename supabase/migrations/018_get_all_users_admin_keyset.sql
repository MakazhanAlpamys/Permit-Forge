-- ============================================================================
-- D12/M21 — Keyset pagination on get_all_users_admin
-- ============================================================================
--
-- OFFSET pagination on a large users table is O(offset) — the planner has
-- to skip N rows before returning a page. Keyset pagination on
-- (created_at DESC, id DESC) is O(log N) per page and survives row
-- inserts during pagination without skipping or repeating rows.
--
-- New params: p_after_created_at and p_after_id form the cursor. The
-- caller passes the last row of the previous page; the function returns
-- the next page strictly after that cursor.
--
-- Backward compat: p_offset is still accepted and honored when the
-- cursor params are NULL. Existing callers (admin page passes offset=0)
-- behave identically. New keyset callers pass NULL for offset and
-- supply the cursor pair.

DROP FUNCTION IF EXISTS get_all_users_admin(UUID, INT, INT, TEXT);

CREATE OR REPLACE FUNCTION get_all_users_admin(
  p_admin_id UUID,
  p_limit INT DEFAULT 50,
  p_offset INT DEFAULT 0,
  p_search TEXT DEFAULT NULL,
  p_after_created_at TIMESTAMPTZ DEFAULT NULL,
  p_after_id UUID DEFAULT NULL
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
  v_use_keyset BOOLEAN := (p_after_created_at IS NOT NULL AND p_after_id IS NOT NULL);
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
    -- Keyset: take rows strictly *after* the cursor in (created_at DESC, id DESC) order.
    AND (NOT v_use_keyset OR (u.created_at, u.id) < (p_after_created_at, p_after_id))
  ORDER BY u.created_at DESC, u.id DESC
  LIMIT LEAST(p_limit, 100)
  OFFSET CASE WHEN v_use_keyset THEN 0 ELSE GREATEST(p_offset, 0) END;
END;
$$;

GRANT EXECUTE ON FUNCTION get_all_users_admin(UUID, INT, INT, TEXT, TIMESTAMPTZ, UUID) TO service_role;
REVOKE EXECUTE ON FUNCTION get_all_users_admin(UUID, INT, INT, TEXT, TIMESTAMPTZ, UUID) FROM anon, authenticated;
