-- ============================================================================
-- X4 / M8 (clickpath): cache permit-certificate PDFs in Supabase Storage
-- ============================================================================
-- Adds a `permit-certificates` bucket so the certificate route can serve a
-- cached PDF instead of regenerating it on every download. The bucket is
-- private; access goes through the API route which already checks ownership
-- + rate limits. permit_certificates.storage_path was already in the schema
-- (000_full_setup.sql) but was never populated — this migration is purely
-- the storage-bucket + RLS setup.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'permit-certificates',
  'permit-certificates',
  FALSE,
  10485760, -- 10 MB ceiling per cert (PDFKit output is ~50–200KB; cap is defensive)
  ARRAY['application/pdf']
)
ON CONFLICT (id) DO NOTHING;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'objects' AND policyname = 'Service role full access to permit-certificates'
  ) THEN
    CREATE POLICY "Service role full access to permit-certificates"
      ON storage.objects FOR ALL TO service_role
      USING (bucket_id = 'permit-certificates')
      WITH CHECK (bucket_id = 'permit-certificates');
  END IF;
END $$;
