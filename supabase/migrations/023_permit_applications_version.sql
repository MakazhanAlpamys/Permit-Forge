-- ============================================================================
-- X17 / P2-A5: optimistic-locking version column on permit_applications
-- ============================================================================
-- Two tabs editing the same permit used to race: whichever tab saved last
-- silently overwrote the other's edits because every UPDATE only matched on
-- `id`. This adds a `version INT NOT NULL DEFAULT 0` column. The application
-- layer:
--   * reads `version` along with the permit on load
--   * sends it back on every UPDATE
--   * the UPDATE adds `WHERE version = :expected_version` and bumps `version`
--   * 0 rows affected → "permit changed externally, reload"
--
-- Existing rows seed at 0 so already-open editors don't get a phantom mismatch
-- on first save (their cached version 0 will match the seeded 0).

ALTER TABLE permit_applications
  ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 0;

-- The status-transition RPCs (submit_permit_atomic / revise_permit_atomic /
-- review_permit_atomic) already use their own atomic guard against
-- concurrent status changes. To keep them coherent with the version column,
-- have them bump `version` whenever they UPDATE the row so the application
-- layer's cached version on the editor's tab is invalidated.

CREATE OR REPLACE FUNCTION submit_permit_atomic(
  p_permit_id UUID,
  p_user_id UUID
) RETURNS TABLE(status_changed BOOLEAN, project_name TEXT, prev_status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_prev_status TEXT;
  v_project_name TEXT;
BEGIN
  SELECT pa.status, pa.project_name
    INTO v_prev_status, v_project_name
  FROM permit_applications pa
  WHERE pa.id = p_permit_id AND pa.user_id = p_user_id
  FOR UPDATE;

  IF v_prev_status IS NULL THEN
    RAISE EXCEPTION 'PERMIT_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF v_prev_status NOT IN ('draft', 'revision_requested') THEN
    RETURN QUERY SELECT FALSE, v_project_name, v_prev_status;
    RETURN;
  END IF;

  UPDATE permit_applications
     SET status = 'submitted',
         submitted_at = NOW(),
         updated_at = NOW(),
         version = version + 1
   WHERE id = p_permit_id;

  INSERT INTO permit_status_history (permit_id, from_status, to_status, changed_by, comment)
  VALUES (p_permit_id, v_prev_status, 'submitted', p_user_id, NULL);

  RETURN QUERY SELECT TRUE, v_project_name, v_prev_status;
END;
$$;

CREATE OR REPLACE FUNCTION revise_permit_atomic(
  p_permit_id UUID,
  p_user_id UUID
) RETURNS TABLE(status_changed BOOLEAN, prev_status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_prev_status TEXT;
BEGIN
  SELECT pa.status
    INTO v_prev_status
  FROM permit_applications pa
  WHERE pa.id = p_permit_id AND pa.user_id = p_user_id
  FOR UPDATE;

  IF v_prev_status IS NULL THEN
    RAISE EXCEPTION 'PERMIT_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF v_prev_status NOT IN ('rejected', 'revision_requested') THEN
    RETURN QUERY SELECT FALSE, v_prev_status;
    RETURN;
  END IF;

  UPDATE permit_applications
     SET status = 'draft',
         updated_at = NOW(),
         version = version + 1
   WHERE id = p_permit_id;

  INSERT INTO permit_status_history (permit_id, from_status, to_status, changed_by, comment)
  VALUES (p_permit_id, v_prev_status, 'draft', p_user_id, NULL);

  RETURN QUERY SELECT TRUE, v_prev_status;
END;
$$;

CREATE OR REPLACE FUNCTION review_permit_atomic(
  p_permit_id UUID,
  p_admin_id UUID,
  p_new_status TEXT,
  p_comments TEXT
) RETURNS TABLE(status_changed BOOLEAN, project_name TEXT, permit_user_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_prev_status TEXT;
  v_project_name TEXT;
  v_user_id UUID;
BEGIN
  SELECT pa.status, pa.project_name, pa.user_id
    INTO v_prev_status, v_project_name, v_user_id
  FROM permit_applications pa
  WHERE pa.id = p_permit_id
  FOR UPDATE;

  IF v_prev_status IS NULL THEN
    RAISE EXCEPTION 'PERMIT_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF v_prev_status NOT IN ('submitted', 'under_review') THEN
    RETURN QUERY SELECT FALSE, v_project_name, v_user_id;
    RETURN;
  END IF;

  UPDATE permit_applications
     SET status = p_new_status,
         reviewed_by = p_admin_id,
         reviewed_at = NOW(),
         review_comments = p_comments,
         updated_at = NOW(),
         version = version + 1
   WHERE id = p_permit_id;

  INSERT INTO permit_status_history (permit_id, from_status, to_status, changed_by, comment)
  VALUES (p_permit_id, v_prev_status, p_new_status, p_admin_id, p_comments);

  RETURN QUERY SELECT TRUE, v_project_name, v_user_id;
END;
$$;

GRANT EXECUTE ON FUNCTION submit_permit_atomic(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION revise_permit_atomic(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION review_permit_atomic(UUID, UUID, TEXT, TEXT) TO service_role;
