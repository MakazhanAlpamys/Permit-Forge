-- ============================================================================
-- D2/H15+H16 — Wire admin dashboard to read from analytics_daily MV
-- ============================================================================
--
-- The materialized view analytics_daily already pre-aggregates message
-- activity per day. Reading the dashboard from it (instead of recomputing
-- from chat_messages JOIN chat_sessions on every load) cuts query time
-- proportionally to data volume.
--
-- The MV is stale until refreshed, so today's bucket is computed live and
-- merged onto the MV's historic rows. The admin "Refresh" button calls
-- refresh_analytics() to update the MV.
--
-- Contract is unchanged: same return columns, same 30-day window with no
-- date gaps.

CREATE OR REPLACE FUNCTION get_message_activity_30d()
RETURNS TABLE (
  day DATE,
  user_count BIGINT,
  assistant_count BIGINT,
  total_count BIGINT,
  active_users BIGINT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH date_series AS (
    SELECT generate_series(
      (current_date - interval '29 days')::date,
      current_date,
      '1 day'::interval
    )::date AS day
  ),
  -- Historic days come from the MV. Cap at yesterday because today's row
  -- in the MV is stale until refresh_analytics() runs.
  historic AS (
    SELECT
      ad.date AS day,
      ad.user_messages AS user_count,
      ad.assistant_messages AS assistant_count,
      ad.total_messages AS total_count,
      ad.active_users
    FROM analytics_daily ad
    WHERE ad.date >= current_date - interval '29 days'
      AND ad.date < current_date
  ),
  -- Today is always computed live so the dashboard reflects in-progress
  -- activity without requiring a refresh after every message.
  today_live AS (
    SELECT
      current_date::date AS day,
      count(*) FILTER (WHERE cm.role = 'user') AS user_count,
      count(*) FILTER (WHERE cm.role = 'assistant') AS assistant_count,
      count(*) AS total_count,
      count(DISTINCT cs.user_id) AS active_users
    FROM chat_messages cm
    JOIN chat_sessions cs ON cs.id = cm.session_id
    WHERE cm.created_at >= current_date
  ),
  merged AS (
    SELECT * FROM historic
    UNION ALL
    SELECT * FROM today_live WHERE total_count > 0
  )
  SELECT
    ds.day,
    COALESCE(m.user_count, 0),
    COALESCE(m.assistant_count, 0),
    COALESCE(m.total_count, 0),
    COALESCE(m.active_users, 0)
  FROM date_series ds
  LEFT JOIN merged m ON m.day = ds.day
  ORDER BY ds.day;
$$;

GRANT EXECUTE ON FUNCTION get_message_activity_30d() TO service_role;
REVOKE EXECUTE ON FUNCTION get_message_activity_30d() FROM anon, authenticated;
