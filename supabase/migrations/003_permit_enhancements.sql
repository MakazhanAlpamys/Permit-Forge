-- ============================================================================
-- Permit System Enhancements
-- Migration 003: File Attachments, Notifications, Certificates, Revisions
-- ============================================================================

-- ============================================================================
-- 1. ALTER PERMIT APPLICATIONS — Revision Support
-- ============================================================================

ALTER TABLE permit_applications
  ADD COLUMN IF NOT EXISTS revision_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS revision_notes TEXT;

-- Update status CHECK constraint to include 'revision_requested'
ALTER TABLE permit_applications DROP CONSTRAINT IF EXISTS permit_applications_status_check;
ALTER TABLE permit_applications ADD CONSTRAINT permit_applications_status_check
  CHECK (status IN ('draft', 'submitted', 'under_review', 'approved', 'rejected', 'revision_requested'));

-- ============================================================================
-- 2. ADD EMAIL TO USERS (for email notifications)
-- ============================================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;

-- ============================================================================
-- 3. PERMIT ATTACHMENTS TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS permit_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  permit_id UUID NOT NULL REFERENCES permit_applications(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  file_type TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  uploaded_by UUID NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS permit_attachments_permit_id_idx ON permit_attachments(permit_id);
CREATE INDEX IF NOT EXISTS permit_attachments_uploaded_by_idx ON permit_attachments(uploaded_by);

ALTER TABLE permit_attachments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all permit_attachments operations" ON permit_attachments;
CREATE POLICY "Allow all permit_attachments operations" ON permit_attachments
  FOR ALL TO anon, authenticated, service_role
  USING (true) WITH CHECK (true);

GRANT ALL ON permit_attachments TO authenticated, service_role;

-- ============================================================================
-- 4. NOTIFICATIONS TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN (
    'permit_submitted',
    'permit_under_review',
    'permit_approved',
    'permit_rejected',
    'permit_revision_requested'
  )),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  data JSONB DEFAULT '{}',
  read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS notifications_user_id_idx ON notifications(user_id);
CREATE INDEX IF NOT EXISTS notifications_user_unread_idx ON notifications(user_id, read) WHERE read = FALSE;
CREATE INDEX IF NOT EXISTS notifications_created_at_idx ON notifications(created_at DESC);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all notifications operations" ON notifications;
CREATE POLICY "Allow all notifications operations" ON notifications
  FOR ALL TO anon, authenticated, service_role
  USING (true) WITH CHECK (true);

GRANT ALL ON notifications TO authenticated, service_role;

-- ============================================================================
-- 5. PERMIT CERTIFICATES TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS permit_certificates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  permit_id UUID NOT NULL REFERENCES permit_applications(id) ON DELETE CASCADE,
  certificate_number TEXT NOT NULL UNIQUE,
  generated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  storage_path TEXT,
  generated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS permit_certificates_permit_id_idx ON permit_certificates(permit_id);
CREATE UNIQUE INDEX IF NOT EXISTS permit_certificates_number_idx ON permit_certificates(certificate_number);

ALTER TABLE permit_certificates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all permit_certificates operations" ON permit_certificates;
CREATE POLICY "Allow all permit_certificates operations" ON permit_certificates
  FOR ALL TO anon, authenticated, service_role
  USING (true) WITH CHECK (true);

GRANT ALL ON permit_certificates TO authenticated, service_role;

-- ============================================================================
-- 6. UPDATE get_permit_stats() RPC — Include revision_requested
-- ============================================================================

-- Drop existing function (signature changed: added revision_requested_count)
DROP FUNCTION IF EXISTS get_permit_stats();

CREATE OR REPLACE FUNCTION get_permit_stats()
RETURNS TABLE (
  total_permits BIGINT,
  draft_count BIGINT,
  submitted_count BIGINT,
  under_review_count BIGINT,
  approved_count BIGINT,
  rejected_count BIGINT,
  revision_requested_count BIGINT,
  permits_today BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    (SELECT COUNT(*) FROM permit_applications)::BIGINT,
    (SELECT COUNT(*) FROM permit_applications WHERE status = 'draft')::BIGINT,
    (SELECT COUNT(*) FROM permit_applications WHERE status = 'submitted')::BIGINT,
    (SELECT COUNT(*) FROM permit_applications WHERE status = 'under_review')::BIGINT,
    (SELECT COUNT(*) FROM permit_applications WHERE status = 'approved')::BIGINT,
    (SELECT COUNT(*) FROM permit_applications WHERE status = 'rejected')::BIGINT,
    (SELECT COUNT(*) FROM permit_applications WHERE status = 'revision_requested')::BIGINT,
    (SELECT COUNT(*) FROM permit_applications WHERE created_at > NOW() - INTERVAL '24 hours')::BIGINT;
END;
$$;

GRANT EXECUTE ON FUNCTION get_permit_stats TO service_role;
REVOKE EXECUTE ON FUNCTION get_permit_stats FROM anon, authenticated;

-- ============================================================================
-- NOTE: Create Supabase Storage buckets manually in Dashboard:
--   1. "permit-attachments" (private, 10MB max per file)
--   2. "permit-certificates" (private)
-- ============================================================================
