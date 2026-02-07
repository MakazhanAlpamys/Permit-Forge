-- ============================================================================
-- Migration 005: Analytics Dashboard Functions
-- ============================================================================

-- -----------------------------------------------------------------------------
-- 1. Enhanced Dashboard Stats (today vs yesterday for trend calculation)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION get_analytics_dashboard_stats()
RETURNS TABLE (
  total_users bigint,
  active_users_today bigint,
  active_users_yesterday bigint,
  messages_today bigint,
  messages_yesterday bigint,
  permits_today bigint,
  permits_yesterday bigint,
  new_users_today bigint,
  new_users_yesterday bigint,
  total_chunks bigint
)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT
    (SELECT count(*) FROM users) AS total_users,

    (SELECT count(DISTINCT user_id) FROM chat_sessions
     WHERE created_at >= date_trunc('day', now())) AS active_users_today,

    (SELECT count(DISTINCT user_id) FROM chat_sessions
     WHERE created_at >= date_trunc('day', now() - interval '1 day')
       AND created_at < date_trunc('day', now())) AS active_users_yesterday,

    (SELECT count(*) FROM chat_messages
     WHERE created_at >= date_trunc('day', now())) AS messages_today,

    (SELECT count(*) FROM chat_messages
     WHERE created_at >= date_trunc('day', now() - interval '1 day')
       AND created_at < date_trunc('day', now())) AS messages_yesterday,

    (SELECT count(*) FROM permit_applications
     WHERE created_at >= date_trunc('day', now())) AS permits_today,

    (SELECT count(*) FROM permit_applications
     WHERE created_at >= date_trunc('day', now() - interval '1 day')
       AND created_at < date_trunc('day', now())) AS permits_yesterday,

    (SELECT count(*) FROM users
     WHERE created_at >= date_trunc('day', now())) AS new_users_today,

    (SELECT count(*) FROM users
     WHERE created_at >= date_trunc('day', now() - interval '1 day')
       AND created_at < date_trunc('day', now())) AS new_users_yesterday,

    (SELECT count(*) FROM dubai_code_chunks) AS total_chunks;
$$;

-- -----------------------------------------------------------------------------
-- 2. Message Activity (last 30 days, no gaps)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION get_message_activity_30d()
RETURNS TABLE (
  day date,
  user_count bigint,
  assistant_count bigint,
  total_count bigint,
  active_users bigint
)
LANGUAGE sql
SECURITY DEFINER
AS $$
  WITH date_series AS (
    SELECT generate_series(
      (current_date - interval '29 days')::date,
      current_date,
      '1 day'::interval
    )::date AS day
  ),
  daily_messages AS (
    SELECT
      date_trunc('day', cm.created_at)::date AS day,
      count(*) FILTER (WHERE cm.role = 'user') AS user_count,
      count(*) FILTER (WHERE cm.role = 'assistant') AS assistant_count,
      count(*) AS total_count,
      count(DISTINCT cs.user_id) AS active_users
    FROM chat_messages cm
    JOIN chat_sessions cs ON cs.id = cm.session_id
    WHERE cm.created_at >= current_date - interval '29 days'
    GROUP BY 1
  )
  SELECT
    ds.day,
    COALESCE(dm.user_count, 0) AS user_count,
    COALESCE(dm.assistant_count, 0) AS assistant_count,
    COALESCE(dm.total_count, 0) AS total_count,
    COALESCE(dm.active_users, 0) AS active_users
  FROM date_series ds
  LEFT JOIN daily_messages dm ON dm.day = ds.day
  ORDER BY ds.day;
$$;

-- -----------------------------------------------------------------------------
-- 3. Top Active Users
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION get_top_active_users(p_days int DEFAULT 30, p_limit int DEFAULT 5)
RETURNS TABLE (
  user_id uuid,
  username text,
  full_name text,
  message_count bigint,
  last_active timestamptz
)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT
    u.id AS user_id,
    u.username,
    u.full_name,
    count(cm.id) AS message_count,
    max(cm.created_at) AS last_active
  FROM users u
  JOIN chat_sessions cs ON cs.user_id = u.id
  JOIN chat_messages cm ON cm.session_id = cs.id
  WHERE cm.created_at >= now() - (p_days || ' days')::interval
    AND cm.role = 'user'
  GROUP BY u.id, u.username, u.full_name
  ORDER BY message_count DESC
  LIMIT p_limit;
$$;
