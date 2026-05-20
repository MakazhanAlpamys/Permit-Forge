// ============================================================================
// Shared logic for "admin uploads a document PDF to Supabase Storage"
// ============================================================================
// Extracted so both the legacy server action and the /api/admin/documents/upload
// API route can share the same hash/upload/registry-update flow without
// duplicating the validation logic.
//
// The API route is the preferred entry point (C5H/H6): keeping document PDF
// uploads on a dedicated API route lets us drop the global 100MB
// `serverActions.bodySizeLimit` config from next.config.ts — only this one
// endpoint actually needs to accept large bodies.
// ============================================================================

import { createAdminClient } from '@/lib/supabase-server';
import { logAuditEvent } from '@/lib/auth';
import { invalidateRegistryCache } from '@/lib/document-registry';
import { DOCUMENT_PDF_LIMITS } from '@/lib/constants';
import { sniffMagic } from '@/lib/file-magic';

export interface UploadDocumentPdfInput {
  documentId: string;
  file: File;
  uploadedByUserId: string;
  /** Audit-log helpers expect IP/user-agent context — surfaced from the route handler. */
  ipAddress?: string;
  userAgent?: string;
}

export interface UploadDocumentPdfResult {
  success: boolean;
  storagePath?: string;
  pdfHash?: string;
  previousPdfHash?: string | null;
  error?: string;
}

const DOC_ID_RE = /^[a-z0-9-]{1,100}$/;

export async function uploadDocumentPdfShared(
  input: UploadDocumentPdfInput,
): Promise<UploadDocumentPdfResult> {
  const { documentId, file, uploadedByUserId } = input;

  if (!documentId || !DOC_ID_RE.test(documentId)) {
    return { success: false, error: 'Invalid documentId' };
  }

  if (!file || !(file instanceof File)) {
    return { success: false, error: 'No file provided' };
  }

  if (!DOCUMENT_PDF_LIMITS.allowedMimeTypes.includes(file.type as 'application/pdf')) {
    return { success: false, error: 'Only PDF files are allowed' };
  }

  if (file.size > DOCUMENT_PDF_LIMITS.maxSizeBytes) {
    return {
      success: false,
      error: `File too large. Maximum size is ${DOCUMENT_PDF_LIMITS.maxSizeMB}MB`,
    };
  }

  try {
    const supabase = createAdminClient();

    const { data: priorRow } = await supabase
      .from('document_registry')
      .select('pdf_hash')
      .eq('id', documentId)
      .single();
    const previousPdfHash = (priorRow?.pdf_hash as string | null) ?? null;

    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `documents/${documentId}/${safeName}`;

    const arrayBuffer = await file.arrayBuffer();
    const buffer = new Uint8Array(arrayBuffer);

    // C7H/H10: confirm the bytes are really a PDF. The MIME check above
    // trusts client-supplied data; the magic bytes don't.
    if (sniffMagic(buffer.subarray(0, 32)) !== 'pdf') {
      return { success: false, error: 'File contents are not a valid PDF' };
    }

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

    await logAuditEvent({
      userId: uploadedByUserId,
      action: 'pdf_ingested',
      metadata: {
        stage: 'pdf_uploaded',
        documentId,
        fileName: file.name,
        fileSize: file.size,
        pdfHash,
      },
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    });

    return { success: true, storagePath, pdfHash, previousPdfHash };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Upload failed',
    };
  }
}

async function sha256Hex(buffer: Uint8Array | ArrayBuffer): Promise<string> {
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
