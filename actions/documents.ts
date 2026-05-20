'use server';

// ============================================================================
// Document Registry Server Actions (Admin Only)
// ============================================================================

import { createAdminClient } from '@/lib/supabase-server';
import { requireAdmin, requireCSRF } from '@/lib/security';
import { logAuditEvent, getRequestMetadata } from '@/lib/auth';
import { clearDocumentTreeCache } from '@/lib/tree-cache';
import { invalidateRegistryCache } from '@/lib/document-registry';
import { invalidateProfileCache } from '@/lib/document-selector';
import { DOCUMENT_PDF_LIMITS } from '@/lib/constants';

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

    // Try RPC first
    const { data, error } = await supabase.rpc('get_all_documents');

    if (error) {
      // Fallback: direct query
      const { data: directData, error: directError } = await supabase
        .from('document_registry')
        .select('*')
        .order('created_at');

      if (directError) {
        return { data: [], error: directError.message };
      }

      return {
        data: (directData || []).map(mapDbRow),
      };
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
): Promise<{ success: boolean; error?: string }> {
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

    // If admin explicitly provided keywords, mark them as manually set so the
    // ingestion pipeline won't overwrite them with auto-extracted keywords.
    const keywordsManuallySet = (input.keywords?.length ?? 0) > 0;

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
      // Fallback: direct upsert
      const { error: directError } = await supabase
        .from('document_registry')
        .upsert({
          id: sanitizedId,
          display_name: input.displayName,
          short_name: input.shortName,
          file_name: input.fileName,
          source_url: input.sourceUrl || '',
          authority: input.authority || '',
          description: input.description || '',
          badge_color: input.badgeColor || 'bg-gray-500/20 text-gray-400 border-gray-500/30',
          keywords: input.keywords || [],
          categories: input.categories || [],
          keywords_auto_generated: !keywordsManuallySet,
          is_active: true,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'id' });

      if (directError) {
        return { success: false, error: directError.message };
      }
    }

    // Invalidate caches so new document is visible immediately
    invalidateRegistryCache();
    invalidateProfileCache();

    const metadata = await getRequestMetadata();
    await logAuditEvent({
      userId: authCheck.user.id,
      action: 'pdf_ingested', // reuse existing action type
      metadata: { stage: 'document_registered', documentId: sanitizedId, displayName: input.displayName },
      ...metadata,
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

    // Soft delete
    const { error } = await supabase.rpc('delete_document', { p_id: documentId });

    if (error) {
      // Fallback: direct update
      const { error: directError } = await supabase
        .from('document_registry')
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq('id', documentId);

      if (directError) {
        return { success: false, error: directError.message };
      }
    }

    // Optionally clear chunks
    if (clearChunks) {
      const { error: clearError } = await supabase.rpc('clear_document_chunks', {
        target_document: documentId,
      });

      if (clearError) {
        // Fallback
        await supabase
          .from('dubai_code_chunks')
          .delete()
          .eq('document_name', documentId);
      }

      // Also clear document tree
      await supabase
        .from('document_trees')
        .delete()
        .eq('document_name', documentId);

      clearDocumentTreeCache(documentId);

      // Delete PDF from Storage if exists
      const { data: docRow, error: docError } = await supabase
        .from('document_registry')
        .select('storage_path')
        .eq('id', documentId)
        .single();

      if (!docError && docRow?.storage_path) {
        await supabase.storage
          .from(DOCUMENT_PDF_LIMITS.storageBucket)
          .remove([docRow.storage_path]);
      }

      // Hard delete the registry entry so it fully disappears
      await supabase
        .from('document_registry')
        .delete()
        .eq('id', documentId);
    }

    invalidateRegistryCache();
    invalidateProfileCache();

    const metadata = await getRequestMetadata();
    await logAuditEvent({
      userId: authCheck.user.id,
      action: 'chunks_cleared',
      metadata: { documentId, action: 'document_deleted', chunksCleared: clearChunks },
      ...metadata,
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

  try {
    const supabase = createAdminClient();

    const { error } = await supabase
      .from('document_registry')
      .update({ is_active: true, updated_at: new Date().toISOString() })
      .eq('id', documentId);

    if (error) {
      return { success: false, error: error.message };
    }

    invalidateRegistryCache();
    invalidateProfileCache();

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

export async function uploadDocumentPDF(
  documentId: string,
  formData: FormData,
  csrfToken?: string
): Promise<{
  success: boolean;
  storagePath?: string;
  error?: string;
  /**
   * B5: SHA-256 of the bytes that were uploaded. The client compares this to
   * the previous pdf_hash to decide whether re-ingesting will drop chunks.
   */
  pdfHash?: string;
  previousPdfHash?: string | null;
}> {
  const authCheck = await requireAdmin();
  if (!authCheck.success || !authCheck.user) {
    return { success: false, error: authCheck.error || 'Unauthorized' };
  }

  const csrf = await requireCSRF(csrfToken);
  if (!csrf.valid) return { success: false, error: csrf.error };

  // C21H/M11: same slug check on the upload path (documentId becomes part of
  // the Storage path below; a malformed id could escape the storage prefix).
  if (!documentId || !/^[a-z0-9-]{1,100}$/.test(documentId)) {
    return { success: false, error: 'Invalid documentId' };
  }

  const file = formData.get('file') as File | null;
  if (!file || !(file instanceof File)) {
    return { success: false, error: 'No file provided' };
  }

  // Validate file type
  if (!DOCUMENT_PDF_LIMITS.allowedMimeTypes.includes(file.type as 'application/pdf')) {
    return { success: false, error: 'Only PDF files are allowed' };
  }

  // Validate file size
  if (file.size > DOCUMENT_PDF_LIMITS.maxSizeBytes) {
    return { success: false, error: `File too large. Maximum size is ${DOCUMENT_PDF_LIMITS.maxSizeMB}MB` };
  }

  try {
    const supabase = createAdminClient();

    // B5: read the previous hash before overwriting it so we can return both
    // to the client. The client compares them to decide whether to prompt
    // "Replace existing N chunks?" before re-ingestion.
    const { data: priorRow } = await supabase
      .from('document_registry')
      .select('pdf_hash')
      .eq('id', documentId)
      .single();
    const previousPdfHash = (priorRow?.pdf_hash as string | null) ?? null;

    // Sanitize filename
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `documents/${documentId}/${safeName}`;

    // Upload to Supabase Storage
    const arrayBuffer = await file.arrayBuffer();
    const buffer = new Uint8Array(arrayBuffer);
    const pdfHash = await sha256Hex(buffer);

    const { error: uploadError } = await supabase.storage
      .from(DOCUMENT_PDF_LIMITS.storageBucket)
      .upload(storagePath, buffer, {
        contentType: 'application/pdf',
        upsert: true,
      });

    if (uploadError) {
      return { success: false, error: `Upload failed: ${uploadError.message}` };
    }

    // Update document_registry with storage_path, file_name, and pdf_hash.
    const { error: updateError } = await supabase
      .from('document_registry')
      .update({
        storage_path: storagePath,
        file_name: file.name,
        pdf_hash: pdfHash,
        updated_at: new Date().toISOString(),
      })
      .eq('id', documentId);

    if (updateError) {
      return { success: false, error: `DB update failed: ${updateError.message}` };
    }

    invalidateRegistryCache();

    const metadata = await getRequestMetadata();
    await logAuditEvent({
      userId: authCheck.user.id,
      action: 'pdf_ingested',
      metadata: { stage: 'pdf_uploaded', documentId, fileName: file.name, fileSize: file.size, pdfHash },
      ...metadata,
    });

    return { success: true, storagePath, pdfHash, previousPdfHash };
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

// B5: SHA-256 of an arbitrary buffer, hex-encoded. Used to fingerprint the
// uploaded PDF so the admin UI can detect a true content change vs. just a
// "re-ingest" click on the same file.
async function sha256Hex(buffer: Uint8Array | ArrayBuffer): Promise<string> {
  // crypto.subtle.digest insists on a plain ArrayBuffer (not SharedArrayBuffer).
  // Copy into a fresh ArrayBuffer to satisfy the type checker and stay safe.
  const source = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const ab = new ArrayBuffer(source.byteLength);
  new Uint8Array(ab).set(source);
  const digest = await crypto.subtle.digest('SHA-256', ab);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}
