-- ============================================================================
-- Permit Applications System
-- Migration 002: Permit Application Workflow
-- ============================================================================

-- ============================================================================
-- 1. PERMIT APPLICATIONS TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS permit_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Application status workflow
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted', 'under_review', 'approved', 'rejected')),

  -- Step 1: Project Information
  project_name TEXT NOT NULL,
  project_type TEXT NOT NULL
    CHECK (project_type IN ('residential', 'commercial', 'industrial', 'mixed_use', 'institutional')),
  project_address TEXT NOT NULL,
  plot_number TEXT,
  project_description TEXT,

  -- Step 2: Building Details (JSONB for flexibility)
  building_details JSONB NOT NULL DEFAULT '{}',

  -- Step 3: Compliance Requirements (JSONB for flexibility)
  compliance_requirements JSONB NOT NULL DEFAULT '{}',

  -- AI Compliance Check Results (JSONB)
  compliance_check_result JSONB DEFAULT NULL,

  -- Admin review
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMP WITH TIME ZONE,
  review_comments TEXT,

  -- Timestamps
  submitted_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================================
-- 2. PERMIT STATUS HISTORY TABLE (Audit Trail)
-- ============================================================================

CREATE TABLE IF NOT EXISTS permit_status_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  permit_id UUID NOT NULL REFERENCES permit_applications(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  changed_by UUID NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  comment TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================================
-- 3. INDEXES
-- ============================================================================

CREATE INDEX IF NOT EXISTS permit_apps_user_id_idx ON permit_applications(user_id);
CREATE INDEX IF NOT EXISTS permit_apps_status_idx ON permit_applications(status);
CREATE INDEX IF NOT EXISTS permit_apps_created_at_idx ON permit_applications(created_at DESC);
CREATE INDEX IF NOT EXISTS permit_apps_submitted_at_idx ON permit_applications(submitted_at DESC);
CREATE INDEX IF NOT EXISTS permit_apps_reviewed_by_idx ON permit_applications(reviewed_by);
CREATE INDEX IF NOT EXISTS permit_apps_project_type_idx ON permit_applications(project_type);

CREATE INDEX IF NOT EXISTS permit_history_permit_id_idx ON permit_status_history(permit_id);
CREATE INDEX IF NOT EXISTS permit_history_created_at_idx ON permit_status_history(created_at DESC);

-- ============================================================================
-- 4. AUTO-UPDATE TRIGGER FOR updated_at
-- ============================================================================

CREATE OR REPLACE FUNCTION update_permit_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_permit_on_change ON permit_applications;
CREATE TRIGGER update_permit_on_change
BEFORE UPDATE ON permit_applications
FOR EACH ROW
EXECUTE FUNCTION update_permit_timestamp();

-- ============================================================================
-- 5. ROW LEVEL SECURITY
-- ============================================================================

ALTER TABLE permit_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE permit_status_history ENABLE ROW LEVEL SECURITY;

-- Permit applications: full access (auth checked in application layer)
DROP POLICY IF EXISTS "Allow all permit_applications operations" ON permit_applications;
CREATE POLICY "Allow all permit_applications operations" ON permit_applications
  FOR ALL
  TO anon, authenticated, service_role
  USING (true)
  WITH CHECK (true);

-- Permit status history: full access
DROP POLICY IF EXISTS "Allow all permit_status_history operations" ON permit_status_history;
CREATE POLICY "Allow all permit_status_history operations" ON permit_status_history
  FOR ALL
  TO anon, authenticated, service_role
  USING (true)
  WITH CHECK (true);

-- ============================================================================
-- 6. PERMISSIONS
-- ============================================================================

GRANT ALL ON permit_applications TO authenticated, service_role;
GRANT ALL ON permit_status_history TO authenticated, service_role;

-- ============================================================================
-- 7. ADMIN RPC FUNCTIONS
-- ============================================================================

-- Get permit statistics for admin dashboard
CREATE OR REPLACE FUNCTION get_permit_stats()
RETURNS TABLE (
  total_permits BIGINT,
  draft_count BIGINT,
  submitted_count BIGINT,
  under_review_count BIGINT,
  approved_count BIGINT,
  rejected_count BIGINT,
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
    (SELECT COUNT(*) FROM permit_applications WHERE created_at > NOW() - INTERVAL '24 hours')::BIGINT;
END;
$$;

GRANT EXECUTE ON FUNCTION get_permit_stats TO service_role;
REVOKE EXECUTE ON FUNCTION get_permit_stats FROM anon, authenticated;
