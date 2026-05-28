// ============================================================================
// Shared logic for "user uploads a permit attachment to Supabase Storage"
// ============================================================================
// Extracted (mirroring lib/document-pdf-upload.ts / C5H/H6) so both the
// `uploadPermitAttachment` server action and the
// /api/permits/[id]/attachments API route run the same validated flow.
//
// The API route is the entry point the UI uses: a permit attachment can be up
// to 10MB (FILE_UPLOAD_LIMITS.maxFileSize), but Next.js caps Server Action
// request bodies at the global serverActions.bodySizeLimit — kept at the 1MB
// default per C5H/H6. Route handlers don't share that cap, so an upload no
// longer 413s ("Body exceeded 1 MB limit") on any file over 1MB. Auth, CSRF
// and rate-limit stay with the caller; this helper owns ownership +
// state-machine + file validation + storage + the capped insert + audit.
// ============================================================================

import { createAdminClient } from '@/lib/supabase-server';
import { logAuditWithMeta } from '@/lib/auth';
import { validateFile, generateStoragePath } from '@/lib/file-upload';
import { FILE_UPLOAD_LIMITS } from '@/lib/constants';
import { canPerformOperation, type PermitStatus } from '@/lib/permit-state-machine';
import { uuidSchema } from '@/lib/validations';
import { firstRpcRow } from '@/lib/transforms';
import type { PermitAttachment } from '@/types';

export interface AttachmentRow {
  id: string;
  permit_id: string;
  file_name: string;
  file_size: number;
  file_type: string;
  storage_path: string;
  uploaded_by: string;
  uploaded_at: string;
}

export function transformAttachment(row: AttachmentRow): PermitAttachment {
  return {
    id: row.id,
    permitId: row.permit_id,
    fileName: row.file_name,
    fileSize: row.file_size,
    fileType: row.file_type,
    storagePath: row.storage_path,
    uploadedBy: row.uploaded_by,
    uploadedAt: row.uploaded_at,
  };
}

export interface UploadPermitAttachmentInput {
  permitId: string;
  /** Nullable so the "No file provided" check stays AFTER ownership + status
   *  validation — same order both entry points relied on. */
  file: File | null;
  uploadedByUserId: string;
}

export interface UploadPermitAttachmentResult {
  success: boolean;
  attachment?: PermitAttachment;
  error?: string;
}

export async function uploadPermitAttachmentShared(
  input: UploadPermitAttachmentInput,
): Promise<UploadPermitAttachmentResult> {
  const { permitId, file, uploadedByUserId } = input;

  const idValidation = uuidSchema.safeParse(permitId);
  if (!idValidation.success) {
    return { success: false, error: 'Invalid permit ID' };
  }

  // Verify ownership
  const supabase = createAdminClient();
  const { data: permit } = await supabase
    .from('permit_applications')
    .select('user_id, status')
    .eq('id', permitId)
    .single();

  if (!permit || permit.user_id !== uploadedByUserId) {
    return { success: false, error: 'Access denied' };
  }

  const uploadCheck = canPerformOperation(permit.status as PermitStatus, 'upload_attachment');
  if (!uploadCheck.allowed) {
    return { success: false, error: uploadCheck.reason };
  }

  if (!file) {
    return { success: false, error: 'No file provided' };
  }

  // Validate file (size, extension, MIME, magic bytes)
  const validation = await validateFile(file);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  // Upload to Supabase Storage first so a successful insert never references
  // a missing object. Cleanup compensates if the RPC then rejects.
  const storagePath = generateStoragePath(permitId, file.name);
  const adminClient = createAdminClient();
  const { error: uploadError } = await adminClient.storage
    .from(FILE_UPLOAD_LIMITS.storageBucket)
    .upload(storagePath, file, {
      contentType: file.type,
      upsert: false,
    });

  if (uploadError) {
    console.error('Storage upload error:', uploadError);
    return { success: false, error: 'Failed to upload file' };
  }

  // C6H/H9: atomic count-and-insert. The RPC takes a row lock on the parent
  // permit before counting, serializing concurrent uploaders so two can't both
  // observe count < 10 and blow through the cap.
  const { data: rpcRows, error: rpcError } = await supabase.rpc(
    'insert_permit_attachment_capped',
    {
      p_permit_id: permitId,
      p_file_name: file.name,
      p_file_size: file.size,
      p_file_type: file.type,
      p_storage_path: storagePath,
      p_uploaded_by: uploadedByUserId,
      p_max_files: FILE_UPLOAD_LIMITS.maxFilesPerPermit,
    },
  );

  if (rpcError || !rpcRows || (Array.isArray(rpcRows) && rpcRows.length === 0)) {
    // Compensating cleanup so we don't leave an orphan object in storage.
    try {
      await adminClient.storage
        .from(FILE_UPLOAD_LIMITS.storageBucket)
        .remove([storagePath]);
    } catch (cleanupErr) {
      console.error('Failed to cleanup orphaned file:', cleanupErr);
    }

    const errMsg = rpcError?.message ?? '';
    if (errMsg.includes('ATTACHMENT_LIMIT_EXCEEDED')) {
      return {
        success: false,
        error: `Maximum ${FILE_UPLOAD_LIMITS.maxFilesPerPermit} files allowed per permit`,
      };
    }
    throw rpcError ?? new Error('Attachment insert returned no rows');
  }

  const attachment = firstRpcRow<AttachmentRow>(rpcRows);
  if (!attachment) {
    return { success: false, error: 'Failed to record attachment' };
  }

  await logAuditWithMeta(uploadedByUserId, 'permit_attachment_uploaded', {
    metadata: { permitId, fileName: file.name, fileSize: file.size },
  });

  return { success: true, attachment: transformAttachment(attachment) };
}
