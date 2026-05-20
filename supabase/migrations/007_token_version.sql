-- ============================================================================
-- C14H/M3 — token_version column for session invalidation on privilege change
-- ============================================================================
--
-- Adds users.token_version. Bumped by admin_update_user_role, admin_block_user
-- (so the bump can't be skipped by a forgetful TS caller), and TS-side
-- password change paths.
--
-- The JWT carries `tv` at issue time; middleware compares JWT.tv against
-- users.token_version on the existing block-status hop (no extra DB call).
-- Mismatch → session is treated as invalid and the user is logged out.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS token_version INT NOT NULL DEFAULT 0;

-- Helper for TS callers (password changes) so the increment is atomic and
-- can't be skipped by writing UPDATE ... SET password_hash=... and forgetting
-- the bump.
CREATE OR REPLACE FUNCTION bump_user_token_version(p_user_id UUID)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_new INT;
BEGIN
  UPDATE users
     SET token_version = COALESCE(token_version, 0) + 1
   WHERE id = p_user_id
   RETURNING token_version INTO v_new;
  RETURN COALESCE(v_new, 0);
END;
$$;

GRANT EXECUTE ON FUNCTION bump_user_token_version(UUID) TO authenticated, service_role;

-- Re-create admin_update_user_role with token_version bump; keep BOOLEAN
-- return type and existing guards so callers don't need to change.
CREATE OR REPLACE FUNCTION admin_update_user_role(
  p_admin_id UUID,
  p_target_user_id UUID,
  p_new_role TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin_role TEXT;
  v_target_current_role TEXT;
  v_target_blocked BOOLEAN;
  v_unblocked_admin_count INT;
BEGIN
  IF p_new_role NOT IN ('admin', 'user') THEN RAISE EXCEPTION 'Invalid role'; END IF;
  SELECT role INTO v_admin_role FROM users WHERE id = p_admin_id;
  IF v_admin_role != 'admin' THEN RAISE EXCEPTION 'Unauthorized: Admin role required'; END IF;

  SELECT role, blocked INTO v_target_current_role, v_target_blocked
  FROM users WHERE id = p_target_user_id;

  IF v_target_current_role = 'admin' AND p_new_role = 'user' AND v_target_blocked = FALSE THEN
    SELECT count(*) INTO v_unblocked_admin_count
    FROM users
    WHERE role = 'admin' AND blocked = FALSE
    FOR UPDATE;
    IF v_unblocked_admin_count <= 1 THEN
      RAISE EXCEPTION 'Cannot demote the only remaining unblocked admin';
    END IF;
  END IF;

  UPDATE users
     SET role = p_new_role,
         token_version = COALESCE(token_version, 0) + 1
   WHERE id = p_target_user_id;
  RETURN TRUE;
END;
$$;

-- Re-create admin_block_user with token_version bump.
CREATE OR REPLACE FUNCTION admin_block_user(
  p_admin_id UUID,
  p_target_user_id UUID,
  p_blocked BOOLEAN,
  p_reason TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin_role TEXT;
  v_target_role TEXT;
  v_unblocked_admin_count INT;
BEGIN
  SELECT role INTO v_admin_role FROM users WHERE id = p_admin_id;
  IF v_admin_role != 'admin' THEN RAISE EXCEPTION 'Unauthorized: Admin role required'; END IF;
  IF p_admin_id = p_target_user_id THEN RAISE EXCEPTION 'Cannot block yourself'; END IF;

  IF p_blocked THEN
    SELECT role INTO v_target_role FROM users WHERE id = p_target_user_id;
    IF v_target_role = 'admin' THEN
      SELECT count(*) INTO v_unblocked_admin_count
      FROM users
      WHERE role = 'admin' AND blocked = FALSE
      FOR UPDATE;
      IF v_unblocked_admin_count <= 1 THEN
        RAISE EXCEPTION 'Cannot block the only remaining unblocked admin';
      END IF;
    END IF;
  END IF;

  UPDATE users SET
    blocked = p_blocked,
    blocked_reason = CASE WHEN p_blocked THEN p_reason ELSE NULL END,
    blocked_at = CASE WHEN p_blocked THEN NOW() ELSE NULL END,
    blocked_by = CASE WHEN p_blocked THEN p_admin_id ELSE NULL END,
    token_version = COALESCE(token_version, 0) + 1
  WHERE id = p_target_user_id;

  RETURN TRUE;
END;
$$;
