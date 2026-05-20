-- ============================================================================
-- C6H — Atomic per-permit attachment insert with cap enforcement
-- ============================================================================
--
-- The Node-side flow was:
--   1. SELECT count(*) FROM permit_attachments WHERE permit_id = $1
--   2. if count >= 10: reject
--   3. INSERT INTO permit_attachments ...
--
-- Two concurrent uploads both see count=9, both insert, end state = 11
-- attachments — the cap is silently bypassed. This RPC moves the count check
-- inside the same transaction as the insert, holding ROW SHARE locks via the
-- pl/pgsql block so a second caller observes the first caller's pending row.
--
-- Returns the inserted row's id (or raises ATTACHMENT_LIMIT_EXCEEDED). The
-- caller is expected to have already validated ownership + status='draft'.

DROP FUNCTION IF EXISTS insert_permit_attachment_capped(UUID, TEXT, BIGINT, TEXT, TEXT, UUID, INT);

CREATE OR REPLACE FUNCTION insert_permit_attachment_capped(
  p_permit_id UUID,
  p_file_name TEXT,
  p_file_size BIGINT,
  p_file_type TEXT,
  p_storage_path TEXT,
  p_uploaded_by UUID,
  p_max_files INT DEFAULT 10
)
RETURNS TABLE (
  id UUID,
  permit_id UUID,
  file_name TEXT,
  file_size BIGINT,
  file_type TEXT,
  storage_path TEXT,
  uploaded_by UUID,
  uploaded_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing_count INT;
BEGIN
  -- Lock the parent permit row so concurrent uploaders serialize on it.
  -- This is what makes the SELECT count below see committed-and-uncommitted
  -- inserts from the previous holder of the lock.
  PERFORM 1 FROM permit_applications WHERE permit_applications.id = p_permit_id FOR UPDATE;

  SELECT COUNT(*) INTO v_existing_count
  FROM permit_attachments
  WHERE permit_attachments.permit_id = p_permit_id;

  IF v_existing_count >= p_max_files THEN
    RAISE EXCEPTION 'ATTACHMENT_LIMIT_EXCEEDED' USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY
  INSERT INTO permit_attachments (
    permit_id, file_name, file_size, file_type, storage_path, uploaded_by
  )
  VALUES (
    p_permit_id, p_file_name, p_file_size, p_file_type, p_storage_path, p_uploaded_by
  )
  RETURNING
    permit_attachments.id,
    permit_attachments.permit_id,
    permit_attachments.file_name,
    permit_attachments.file_size,
    permit_attachments.file_type,
    permit_attachments.storage_path,
    permit_attachments.uploaded_by,
    permit_attachments.uploaded_at;
END;
$$;

GRANT EXECUTE ON FUNCTION insert_permit_attachment_capped(UUID, TEXT, BIGINT, TEXT, TEXT, UUID, INT) TO authenticated, service_role;
