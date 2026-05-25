'use server';

// ============================================================================
// Document Registry Server Actions (Admin Only)
// ============================================================================

import { createAdminClient } from '@/lib/supabase-server';
import { requireAdmin, requireCSRF } from '@/lib/security';
import { logAuditWithMeta, getRequestMetadata } from '@/lib/auth';
import { invalidateAllDocumentCaches } from '@/lib/document-cache';
import { DOCUMENT_PDF_LIMITS } from '@/lib/constants';
import { uploadDocumentPdfShared } from '@/lib/document-pdf-upload';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface DocumentRecord {
  id: string;
  displayName: string;
  shortName: string;
  fileName: string;
  storagePath: string | null;
  sourceUrl: string;
  authority: string;
  description: string;
  badgeColor: string;
  keywords: string[];
  categories: string[];
  isActive: boolean;
  pdfHash: string | null;
  lastIngestedPdfHash: string | null;
  createdAt: string;
  updatedAt: string;
}

interface DocumentInput {
  id: string;
  displayName: string;
  shortName: string;
  fileName: string;
  sourceUrl?: string;
  authority?: string;
  description?: string;
  badgeColor?: string;
  keywords?: string[];
  categories?: string[];
}

// -----------------------------------------------------------------------------
// Get All Documents (including inactive)
// -----------------------------------------------------------------------------

export async function getAllRegisteredDocuments(): Promise<{
  data: DocumentRecord[];
  error?: string;
}> {
  const authCheck = await requireAdmin();
  if (!authCheck.success) {
    return { data: [], error: authCheck.error || 'Unauthorized' };
  }

  try {
    const supabase = createAdminClient();

    // F8: get_all_documents RPC is seeded by 000_full_setup.sql — surface
    // errors instead of silently masking them with a direct query fallback.
    const { data, error } = await supabase.rpc('get_all_documents');

    if (error) {
      return { data: [], error: error.message };
    }

    return {
      data: (data || []).map(mapDbRow),
    };
  } catch (error) {
    return {
      data: [],
      error: error instanceof Error ? error.message : 'Failed to fetch documents',
    };
  }
}

// -----------------------------------------------------------------------------
// Upsert Document (Create or Update)
// -----------------------------------------------------------------------------

export async function upsertDocument(
  input: DocumentInput,
  csrfToken: string
): Promise<{ success: boolean; error?: string; code?: 'soft_deleted' }> {
  const authCheck = await requireAdmin();
  if (!authCheck.success || !authCheck.user) {
    return { success: false, error: authCheck.error || 'Unauthorized' };
  }

  const csrf = await requireCSRF(csrfToken);
  if (!csrf.valid) return { success: false, error: csrf.error };

  if (!input.id || !input.displayName || !input.shortName || !input.fileName) {
    return { success: false, error: 'Missing required fields: id, displayName, shortName, fileName' };
  }

  // Sanitize document ID: lowercase, alphanumeric + hyphens only
  const sanitizedId = input.id.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');

  try {
    const supabase = createAdminClient();

    // CP-C-4 (v1.2.0 Part B): refuse to silently overwrite a soft-deleted row.
    // Before the previous behaviour blindly upserted, so a user who'd deleted
    // doc "X" and re-registered "X" reactivated the old row + chunks with no
    // audit trail and no UI hint that they were resurrecting prior data.
    // Now: detect the collision, surface a structured `code: 'soft_deleted'`
    // so the admin UI can prompt "name in use, restore instead?".
    const { data: existing } = await supabase
      .from('document_registry')
      .select('id, is_active')
      .eq('id', sanitizedId)
      .single();

    if (existing && (existing as { is_active?: boolean }).is_active === false) {
      return {
        success: false,
        error: 'A document with this name was previously deleted. Restore it instead of re-registering.',
        code: 'soft_deleted',
      };
    }

    // If admin explicitly provided keywords, mark them as manually set so the
    // ingestion pipeline won't overwrite them with auto-extracted keywords.
    const keywordsManuallySet = (input.keywords?.length ?? 0) > 0;

    // F8: upsert_document RPC is seeded by 000_full_setup.sql — surface
    // errors instead of silently masking them with a direct upsert fallback.
    const { error } = await supabase.rpc('upsert_document', {
      p_id: sanitizedId,
      p_display_name: input.displayName,
      p_short_name: input.shortName,
      p_file_name: input.fileName,
      p_source_url: input.sourceUrl || '',
      p_authority: input.authority || '',
      p_description: input.description || '',
      p_badge_color: input.badgeColor || 'bg-gray-500/20 text-gray-400 border-gray-500/30',
      p_keywords: input.keywords || [],
      p_categories: input.categories || [],
      p_keywords_auto_generated: !keywordsManuallySet,
    });

    if (error) {
      return { success: false, error: error.message };
    }

    // Invalidate caches so new document is visible immediately. v1.7.0 Part B:
    // single throat through invalidateAllDocumentCaches — no tree-cache
    // bound to a new registration yet, so omit the documentName arg.
    invalidateAllDocumentCaches();

    await logAuditWithMeta(authCheck.user.id, 'pdf_ingested', {
      metadata: { stage: 'document_registered', documentId: sanitizedId, displayName: input.displayName },
    });

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to save document',
    };
  }
}

// -----------------------------------------------------------------------------
// Delete Document (soft delete + optionally clear chunks)
// -----------------------------------------------------------------------------

export async function deleteDocument(
  documentId: string,
  clearChunks: boolean = false,
  csrfToken: string
): Promise<{ success: boolean; error?: string }> {
  const authCheck = await requireAdmin();
  if (!authCheck.success || !authCheck.user) {
    return { success: false, error: authCheck.error || 'Unauthorized' };
  }

  const csrf = await requireCSRF(csrfToken);
  if (!csrf.valid) return { success: false, error: csrf.error };

  // C21H/M11: validate ID shape before reaching the RPC. document_registry.id
  // is a slug (TEXT, not UUID), produced by the same sanitization on insert
  // (lowercase a-z, 0-9, hyphen, max 100). Reject anything else so a bad call
  // can't enter the RPC with a malformed identifier.
  if (!documentId || !/^[a-z0-9-]{1,100}$/.test(documentId)) {
    return { success: false, error: 'Invalid documentId' };
  }

  try {
    const supabase = createAdminClient();

    // Before the atomic delete, peek at storage_path so we can clean up the
    // PDF object after the DB transaction commits (Storage isn't in the same
    // transaction as Postgres — best-effort cleanup, leaves an orphan if it
    // fails, never blocks the delete).
    let storagePath: string | null = null;
    if (clearChunks) {
      const { data: docRow } = await supabase
        .from('document_registry')
        .select('storage_path')
        .eq('id', documentId)
        .single();
      storagePath = (docRow?.storage_path as string | null) ?? null;
    }

    // C17H/M6: single transactional RPC handles both flavors:
    //   clearChunks=false → flip is_active=false (soft delete).
    //   clearChunks=true  → cascade delete chunks/parent_chunks/trees/registry row.
    const { error } = await supabase.rpc('delete_document_atomic', {
      p_document_id: documentId,
      p_clear_chunks: clearChunks,
    });

    if (error) {
      return { success: false, error: error.message };
    }

    if (clearChunks && storagePath) {
      try {
        await supabase.storage
          .from(DOCUMENT_PDF_LIMITS.storageBucket)
          .remove([storagePath]);
      } catch (storageErr) {
        console.error('Storage cleanup failed (orphan left):', storageErr);
      }
    }

    // v1.7.0 Part B: single throat. Scopes the tree-cache eviction to this
    // document; soft-delete still benefits from clearing the per-doc tree
    // since the document is now invisible to chat queries either way.
    invalidateAllDocumentCaches(documentId);

    await logAuditWithMeta(authCheck.user.id, 'chunks_cleared', {
      metadata: { documentId, action: 'document_deleted', chunksCleared: clearChunks },
    });

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to delete document',
    };
  }
}

// -----------------------------------------------------------------------------
// Restore (re-activate) a soft-deleted document
// -----------------------------------------------------------------------------

export async function restoreDocument(
  documentId: string,
  csrfToken: string
): Promise<{ success: boolean; error?: string }> {
  const authCheck = await requireAdmin();
  if (!authCheck.success || !authCheck.user) {
    return { success: false, error: authCheck.error || 'Unauthorized' };
  }

  const csrf = await requireCSRF(csrfToken);
  if (!csrf.valid) return { success: false, error: csrf.error };

  // Same id-shape validation as deleteDocument so a malformed slug can't
  // bypass the admin-only update path.
  if (!documentId || !/^[a-z0-9-]{1,100}$/.test(documentId)) {
    return { success: false, error: 'Invalid documentId' };
  }

  try {
    const supabase = createAdminClient();

    const { error } = await supabase
      .from('document_registry')
      .update({ is_active: true, updated_at: new Date().toISOString() })
      .eq('id', documentId);

    if (error) {
      return { success: false, error: error.message };
    }

    // v1.7.0 Part B: single throat. Tree cache may already be empty for a
    // soft-deleted document; harmless no-op when so.
    invalidateAllDocumentCaches(documentId);

    // CP-C-5 (v1.2.0 Part B): log restoration so the admin audit log shows
    // a document was re-activated. Reuse `pdf_ingested` action type with a
    // distinct `stage` so we don't have to add a new AuditAction enum value
    // (keeps the migration surface frozen — diploma scope).
    await logAuditWithMeta(authCheck.user.id, 'pdf_ingested', {
      metadata: { stage: 'document_restored', documentId },
    });

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to restore document',
    };
  }
}

// -----------------------------------------------------------------------------
// B5: Check whether the currently-uploaded PDF differs from the one that
// produced the existing chunks. Called by the admin UI just before re-ingest
// to decide if the user should be prompted to replace prior chunks.
// -----------------------------------------------------------------------------

export async function checkPdfReingest(
  documentId: string
): Promise<{
  pdfHash: string | null;
  lastIngestedPdfHash: string | null;
  hashChanged: boolean;
  chunkCount: number;
  error?: string;
}> {
  const authCheck = await requireAdmin();
  if (!authCheck.success) {
    return {
      pdfHash: null,
      lastIngestedPdfHash: null,
      hashChanged: false,
      chunkCount: 0,
      error: authCheck.error || 'Unauthorized',
    };
  }

  if (!documentId || !/^[a-z0-9-]{1,100}$/.test(documentId)) {
    return {
      pdfHash: null,
      lastIngestedPdfHash: null,
      hashChanged: false,
      chunkCount: 0,
      error: 'Invalid documentId',
    };
  }

  try {
    const supabase = createAdminClient();

    const { data: docRow } = await supabase
      .from('document_registry')
      .select('pdf_hash, last_ingested_pdf_hash')
      .eq('id', documentId)
      .single();

    const pdfHash = (docRow?.pdf_hash as string | null) ?? null;
    const lastIngestedPdfHash = (docRow?.last_ingested_pdf_hash as string | null) ?? null;

    const { count } = await supabase
      .from('dubai_code_chunks')
      .select('*', { count: 'exact', head: true })
      .eq('document_name', documentId);

    // hashChanged only matters when we *have* a baseline ingestion to compare
    // against. First-time ingest (lastIngestedPdfHash IS NULL) is not a
    // replacement — the chunk table is empty for this document.
    const hashChanged =
      pdfHash !== null && lastIngestedPdfHash !== null && pdfHash !== lastIngestedPdfHash;

    return {
      pdfHash,
      lastIngestedPdfHash,
      hashChanged,
      chunkCount: count ?? 0,
    };
  } catch (error) {
    return {
      pdfHash: null,
      lastIngestedPdfHash: null,
      hashChanged: false,
      chunkCount: 0,
      error: error instanceof Error ? error.message : 'Failed to check reingest state',
    };
  }
}

// -----------------------------------------------------------------------------
// Upload Document PDF to Supabase Storage
// -----------------------------------------------------------------------------

/**
 * @deprecated C5H/H6: prefer POST /api/admin/documents/upload — this server
 * action remains as a thin shim so existing tests and any direct callers keep
 * working, but the UI uses the API route to avoid pinning the global server-
 * actions body limit to 100MB.
 */
export async function uploadDocumentPDF(
  documentId: string,
  formData: FormData,
  csrfToken?: string
): Promise<{
  success: boolean;
  storagePath?: string;
  error?: string;
  pdfHash?: string;
  previousPdfHash?: string | null;
}> {
  const authCheck = await requireAdmin();
  if (!authCheck.success || !authCheck.user) {
    return { success: false, error: authCheck.error || 'Unauthorized' };
  }

  const csrf = await requireCSRF(csrfToken);
  if (!csrf.valid) return { success: false, error: csrf.error };

  const file = formData.get('file') as File | null;
  if (!file || !(file instanceof File)) {
    return { success: false, error: 'No file provided' };
  }

  try {
    const metadata = await getRequestMetadata();
    return await uploadDocumentPdfShared({
      documentId,
      file,
      uploadedByUserId: authCheck.user.id,
      ipAddress: metadata.ipAddress,
      userAgent: metadata.userAgent,
    });
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Upload failed',
    };
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function mapDbRow(row: Record<string, unknown>): DocumentRecord {
  return {
    id: row.id as string,
    displayName: (row.display_name as string) || '',
    shortName: (row.short_name as string) || '',
    fileName: (row.file_name as string) || '',
    storagePath: (row.storage_path as string) || null,
    sourceUrl: (row.source_url as string) || '',
    authority: (row.authority as string) || '',
    description: (row.description as string) || '',
    badgeColor: (row.badge_color as string) || '',
    keywords: (row.keywords as string[]) || [],
    categories: (row.categories as string[]) || [],
    isActive: row.is_active !== false,
    pdfHash: (row.pdf_hash as string) || null,
    lastIngestedPdfHash: (row.last_ingested_pdf_hash as string) || null,
    createdAt: (row.created_at as string) || '',
    updatedAt: (row.updated_at as string) || '',
  };
}

