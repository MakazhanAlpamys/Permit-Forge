-- ============================================================================
-- B7 — Atomic permit submit / revise RPCs
-- ============================================================================
--
-- Replaces two-step "UPDATE then INSERT status_history" with a single
-- transactional RPC so a crash between the two writes can't leave a permit
-- in 'submitted' state without a matching status history row.
--
-- Returns:
--   { status_changed boolean, is_resubmission boolean, project_name text,
--     prev_status text, new_status text }
-- so the caller can decide whether the row actually transitioned (false if
-- another tab raced and already moved it).
--
-- Best-effort notification stays in the application layer — it isn't part
-- of the DB transaction because notification failure shouldn't block the
-- state change (see B8 warning surface).

DROP FUNCTION IF EXISTS submit_permit_atomic(UUID, UUID);

CREATE OR REPLACE FUNCTION submit_permit_atomic(
  p_permit_id UUID,
  p_user_id UUID
)
RETURNS TABLE (
  status_changed BOOLEAN,
  is_resubmission BOOLEAN,
  project_name TEXT,
  prev_status TEXT,
  new_status TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_prev_status TEXT;
  v_revision_count INT;
  v_bd JSONB;
  v_project_name TEXT;
  v_is_resub BOOLEAN := FALSE;
BEGIN
  -- Lock the row for the duration of this transaction to prevent racing
  -- submitters from both observing status='draft' and both transitioning.
  SELECT pa.status, pa.revision_count, pa.building_details, pa.project_name
    INTO v_prev_status, v_revision_count, v_bd, v_project_name
  FROM permit_applications pa
  WHERE pa.id = p_permit_id AND pa.user_id = p_user_id
  FOR UPDATE;

  IF v_prev_status IS NULL THEN
    RAISE EXCEPTION 'PERMIT_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF v_prev_status NOT IN ('draft', 'revision_requested') THEN
    -- Idempotent: don't raise, just report no change.
    RETURN QUERY SELECT FALSE, FALSE, v_project_name, v_prev_status, v_prev_status;
    RETURN;
  END IF;

  -- Building details guard mirrors the action-layer check so the RPC is
  -- safe to call without re-validating in JS.
  IF v_bd IS NULL
     OR COALESCE((v_bd->>'numberOfFloors')::NUMERIC, 0) <= 0
     OR COALESCE((v_bd->>'totalBuiltUpArea')::NUMERIC, 0) <= 0
     OR COALESCE((v_bd->>'plotArea')::NUMERIC, 0) <= 0
     OR COALESCE((v_bd->>'buildingHeight')::NUMERIC, 0) <= 0 THEN
    RAISE EXCEPTION 'BUILDING_DETAILS_INCOMPLETE' USING ERRCODE = 'P0002';
  END IF;

  v_is_resub := v_prev_status = 'revision_requested';

  UPDATE permit_applications
     SET status = 'submitted',
         submitted_at = NOW(),
         revision_count = CASE WHEN v_is_resub THEN COALESCE(v_revision_count, 0) + 1
                               ELSE COALESCE(v_revision_count, 0) END,
         revision_notes = CASE WHEN v_is_resub THEN NULL ELSE revision_notes END,
         updated_at = NOW()
   WHERE id = p_permit_id AND user_id = p_user_id;

  INSERT INTO permit_status_history (permit_id, from_status, to_status, changed_by, comment)
  VALUES (
    p_permit_id,
    v_prev_status,
    'submitted',
    p_user_id,
    CASE WHEN v_is_resub THEN 'Application resubmitted after revision'
         ELSE 'Application submitted for review' END
  );

  RETURN QUERY SELECT TRUE, v_is_resub, v_project_name, v_prev_status, 'submitted'::TEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION submit_permit_atomic(UUID, UUID) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- revise_permit_atomic: same shape, for the user re-opening a returned permit.
-- ----------------------------------------------------------------------------

DROP FUNCTION IF EXISTS revise_permit_atomic(UUID, UUID);

CREATE OR REPLACE FUNCTION revise_permit_atomic(
  p_permit_id UUID,
  p_user_id UUID
)
RETURNS TABLE (
  status_changed BOOLEAN,
  prev_status TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_prev_status TEXT;
BEGIN
  SELECT pa.status INTO v_prev_status
  FROM permit_applications pa
  WHERE pa.id = p_permit_id AND pa.user_id = p_user_id
  FOR UPDATE;

  IF v_prev_status IS NULL THEN
    RAISE EXCEPTION 'PERMIT_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF v_prev_status <> 'revision_requested' THEN
    RETURN QUERY SELECT FALSE, v_prev_status;
    RETURN;
  END IF;

  UPDATE permit_applications
     SET status = 'draft',
         compliance_check_result = NULL,
         updated_at = NOW()
   WHERE id = p_permit_id AND user_id = p_user_id;

  INSERT INTO permit_status_history (permit_id, from_status, to_status, changed_by, comment)
  VALUES (p_permit_id, v_prev_status, 'draft', p_user_id, 'Started revision');

  RETURN QUERY SELECT TRUE, v_prev_status;
END;
$$;

GRANT EXECUTE ON FUNCTION revise_permit_atomic(UUID, UUID) TO authenticated, service_role;
