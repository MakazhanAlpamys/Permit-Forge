-- =====================================================================
-- Migration 001 — Create initial admin user
-- =====================================================================
-- USAGE:
--   1. Generate a bcrypt hash from the project root:
--        node -e "console.log(require('bcryptjs').hashSync('YOUR_PASSWORD', 12))"
--      Copy the output (starts with $2b$12$...).
--   2. Replace the three placeholders below:
--        <ADMIN_USERNAME>  → desired username (lowercase, unique)
--        <ADMIN_EMAIL>     → admin email
--        <BCRYPT_HASH>     → bcrypt hash from step 1
--   3. Run via Supabase SQL Editor or `supabase db push`.
--
-- Idempotent: re-running upgrades the user to admin if it already exists,
-- but never touches password_hash on conflict (so you can rotate manually).
-- =====================================================================

INSERT INTO users (
  username,
  email,
  password_hash,
  full_name,
  role,
  email_verified,
  created_at
)
VALUES (
  '<ADMIN_USERNAME>',
  '<ADMIN_EMAIL>',
  '<BCRYPT_HASH>',
  'System Administrator',
  'admin',
  TRUE,
  NOW()
)
ON CONFLICT (username) DO UPDATE
SET
  role           = 'admin',
  email_verified = TRUE,
  -- DO NOT overwrite password_hash on conflict.
  email          = COALESCE(EXCLUDED.email, users.email);

-- Verify creation:
--   SELECT id, username, email, role, email_verified, created_at
--   FROM users WHERE role = 'admin';
