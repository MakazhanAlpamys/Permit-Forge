-- ============================================================================
-- C17H/M6 — Single-RPC mutations for createPermit, reviewPermit, deleteDocument
-- ============================================================================
--
-- B7 already covered submit/revise. C17H wraps the remaining multi-write
-- actions in transactional RPCs so a crash between writes can't leave the
-- DB inconsistent (e.g. permit row inserted but no status_history audit, or
-- chunks deleted but document_registry row stuck pointing to them).
--
-- Notification side-effects stay in the app layer per B8 — a failed in-app
-- notification surfaces a non-blocking warning instead of rolling back the
-- DB state change.

-- ---------------------------------------------------------------------------
-- create_permit_atomic: insert the application + the initial status_history
-- row in one transaction.
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS create_permit_atomic(UUID, TEXT, TEXT, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION create_permit_atomic(
  p_user_id UUID,
  p_project_name TEXT,
  p_project_type TEXT,
  p_project_address TEXT,
  p_plot_number TEXT,
  p_project_description TEXT
)
RETURNS TABLE (permit_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO permit_applications (
    user_id, status, project_name, project_type, project_address,
    plot_number, project_description
  )
  VALUES (
    p_user_id, 'draft', p_project_name, p_project_type, p_project_address,
    p_plot_number, p_project_description
  )
  RETURNING id INTO v_id;

  INSERT INTO permit_status_history (permit_id, from_status, to_status, changed_by, comment)
  VALUES (v_id, NULL, 'draft', p_user_id, 'Permit application created');

  RETURN QUERY SELECT v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION create_permit_atomic(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- review_permit_atomic: status update + history insert in one transaction.
-- Notification stays in the app layer (see B8).
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS review_permit_atomic(UUID, UUID, TEXT, TEXT);

CREATE OR REPLACE FUNCTION review_permit_atomic(
  p_permit_id UUID,
  p_admin_id UUID,
  p_new_status TEXT,
  p_comments TEXT
)
RETURNS TABLE (
  status_changed BOOLEAN,
  prev_status TEXT,
  project_name TEXT,
  permit_user_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_prev_status TEXT;
  v_project_name TEXT;
  v_user_id UUID;
BEGIN
  IF p_new_status NOT IN ('approved', 'rejected', 'revision_requested') THEN
    RAISE EXCEPTION 'Invalid review status' USING ERRCODE = 'P0002';
  END IF;

  SELECT pa.status, pa.project_name, pa.user_id
    INTO v_prev_status, v_project_name, v_user_id
  FROM permit_applications pa
  WHERE pa.id = p_permit_id
  FOR UPDATE;

  IF v_prev_status IS NULL THEN
    RAISE EXCEPTION 'PERMIT_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF v_prev_status NOT IN ('submitted', 'under_review') THEN
    RETURN QUERY SELECT FALSE, v_prev_status, v_project_name, v_user_id;
    RETURN;
  END IF;

  UPDATE permit_applications
     SET status = p_new_status,
         reviewed_by = p_admin_id,
         reviewed_at = NOW(),
         review_comments = p_comments,
         revision_notes = CASE WHEN p_new_status = 'revision_requested' THEN p_comments ELSE revision_notes END,
         updated_at = NOW()
   WHERE id = p_permit_id;

  INSERT INTO permit_status_history (permit_id, from_status, to_status, changed_by, comment)
  VALUES (p_permit_id, v_prev_status, p_new_status, p_admin_id, p_comments);

  RETURN QUERY SELECT TRUE, v_prev_status, v_project_name, v_user_id;
END;
$$;

GRANT EXECUTE ON FUNCTION review_permit_atomic(UUID, UUID, TEXT, TEXT) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- delete_document_atomic: registry deactivate / hard-delete + cascade
-- cleanup of chunks, parent_chunks, document_trees in one transaction.
-- p_clear_chunks=false → soft delete (is_active=false, keep chunks).
-- p_clear_chunks=true → hard delete (registry row + all child data).
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS delete_document_atomic(TEXT, BOOLEAN);

CREATE OR REPLACE FUNCTION delete_document_atomic(
  p_document_id TEXT,
  p_clear_chunks BOOLEAN DEFAULT FALSE
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_clear_chunks THEN
    DELETE FROM dubai_code_chunks WHERE document_name = p_document_id;
    DELETE FROM parent_chunks WHERE document_name = p_document_id;
    DELETE FROM document_trees WHERE document_name = p_document_id;
    DELETE FROM document_registry WHERE id = p_document_id;
  ELSE
    UPDATE document_registry
       SET is_active = FALSE, updated_at = NOW()
     WHERE id = p_document_id;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION delete_document_atomic(TEXT, BOOLEAN) TO authenticated, service_role;
