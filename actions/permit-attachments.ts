'use server';

// ============================================================================
// Permit Attachment Server Actions
// ============================================================================

import { createAdminClient, checkRateLimit } from '@/lib/supabase-server';
import { getQuickSession, logAuditEvent, getRequestMetadata } from '@/lib/auth';
import { requireAuth, requireCSRF } from '@/lib/security';
import { uuidSchema } from '@/lib/validations';
import { validateFile, generateStoragePath } from '@/lib/file-upload';
import { FILE_UPLOAD_LIMITS } from '@/lib/constants';
import type { PermitAttachment } from '@/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function transformAttachment(row: any): PermitAttachment {
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

// -----------------------------------------------------------------------------
// Upload Attachment
// -----------------------------------------------------------------------------

export async function uploadPermitAttachment(
  permitId: string,
  formData: FormData,
  csrfToken?: string
): Promise<{ success: boolean; attachment?: PermitAttachment; error?: string }> {
  try {
    const authCheck = await requireAuth();
    if (!authCheck.success || !authCheck.user) {
      return { success: false, error: authCheck.error };
    }

    const csrf = await requireCSRF(csrfToken);
    if (!csrf.valid) return { success: false, error: csrf.error };

    // Rate limiting
    const rateLimitResult = await checkRateLimit(authCheck.user.id);
    if (!rateLimitResult.allowed) {
      return { success: false, error: 'Too many requests. Please wait before uploading again.' };
    }

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

    if (!permit || permit.user_id !== authCheck.user.id) {
      return { success: false, error: 'Access denied' };
    }

    if (permit.status !== 'draft') {
      return { success: false, error: 'Can only upload attachments to draft permits' };
    }

    // Get file from FormData
    const file = formData.get('file') as File | null;
    if (!file) {
      return { success: false, error: 'No file provided' };
    }

    // Validate file
    const validation = validateFile(file);
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

    // C6H/H9: atomic count-and-insert. The previous SELECT count → INSERT
    // sequence let two concurrent uploads both observe count < 10 and both
    // insert, blowing through the cap. The RPC takes a row lock on the
    // parent permit row before counting, serializing concurrent uploaders.
    const { data: rpcRows, error: rpcError } = await supabase.rpc(
      'insert_permit_attachment_capped',
      {
        p_permit_id: permitId,
        p_file_name: file.name,
        p_file_size: file.size,
        p_file_type: file.type,
        p_storage_path: storagePath,
        p_uploaded_by: authCheck.user.id,
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

    const attachment = Array.isArray(rpcRows) ? rpcRows[0] : rpcRows;

    const metadata = await getRequestMetadata();
    await logAuditEvent({
      userId: authCheck.user.id,
      action: 'permit_attachment_uploaded',
      metadata: { permitId, fileName: file.name, fileSize: file.size },
      ...metadata,
    });

    return { success: true, attachment: transformAttachment(attachment) };
  } catch (error) {
    console.error('uploadPermitAttachment error:', error);
    return {
      success: false,
      error: 'Failed to upload attachment',
    };
  }
}

// -----------------------------------------------------------------------------
// Delete Attachment
// -----------------------------------------------------------------------------

export async function deletePermitAttachment(
  attachmentId: string,
  csrfToken?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const authCheck = await requireAuth();
    if (!authCheck.success || !authCheck.user) {
      return { success: false, error: authCheck.error };
    }

    const csrf = await requireCSRF(csrfToken);
    if (!csrf.valid) return { success: false, error: csrf.error };

    const idValidation = uuidSchema.safeParse(attachmentId);
    if (!idValidation.success) {
      return { success: false, error: 'Invalid attachment ID' };
    }

    const supabase = createAdminClient();

    // Fetch attachment with permit info
    const { data: attachment } = await supabase
      .from('permit_attachments')
      .select('*, permit_applications!inner(user_id, status)')
      .eq('id', attachmentId)
      .single();

    if (!attachment) {
      return { success: false, error: 'Attachment not found' };
    }

    // Verify ownership
    if (attachment.permit_applications.user_id !== authCheck.user.id) {
      return { success: false, error: 'Access denied' };
    }

    if (attachment.permit_applications.status !== 'draft') {
      return { success: false, error: 'Can only delete attachments from draft permits' };
    }

    // Delete DB record first (reversible orphan in storage is safer than
    // a DB record pointing to a deleted file)
    const { error } = await supabase
      .from('permit_attachments')
      .delete()
      .eq('id', attachmentId);

    if (error) throw error;

    // Then delete from storage (failure leaves an orphan file, not a broken reference)
    const adminClient = createAdminClient();
    await adminClient.storage
      .from(FILE_UPLOAD_LIMITS.storageBucket)
      .remove([attachment.storage_path]);

    const metadata = await getRequestMetadata();
    await logAuditEvent({
      userId: authCheck.user.id,
      action: 'permit_attachment_deleted',
      metadata: { attachmentId, permitId: attachment.permit_id, fileName: attachment.file_name },
      ...metadata,
    });

    return { success: true };
  } catch (error) {
    console.error('deletePermitAttachment error:', error);
    return {
      success: false,
      error: 'Failed to delete attachment',
    };
  }
}

// -----------------------------------------------------------------------------
// Get Permit Attachments
// -----------------------------------------------------------------------------

export async function getPermitAttachments(
  permitId: string
): Promise<{ data: PermitAttachment[]; error?: string }> {
  try {
    const user = await getQuickSession();
    if (!user) {
      return { data: [], error: 'Not authenticated' };
    }

    const idValidation = uuidSchema.safeParse(permitId);
    if (!idValidation.success) {
      return { data: [], error: 'Invalid permit ID' };
    }

    // Verify ownership or admin
    if (user.role !== 'admin') {
      const supabase = createAdminClient();
      const { data: permit } = await supabase
        .from('permit_applications')
        .select('user_id')
        .eq('id', permitId)
        .single();

      if (!permit || permit.user_id !== user.id) {
        return { data: [], error: 'Access denied' };
      }
    }

    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from('permit_attachments')
      .select('*')
      .eq('permit_id', permitId)
      .order('uploaded_at', { ascending: false });

    if (error) throw error;

    // OPTIMIZATION NOTE: Signed URLs cannot be batched via Supabase API,
    // so we must call createSignedUrl for each attachment.
    // This is a known limitation of the Supabase Storage API.
    // In production, consider: (1) serving through a proxy endpoint that generates
    // signed URLs on-the-fly, or (2) pre-generating signed URLs with longer TTLs
    // and caching them with the attachment record.
    const adminClient = createAdminClient();
    const attachments: PermitAttachment[] = [];

    for (const row of data || []) {
      const { data: signedData, error: signedError } = await adminClient.storage
        .from(FILE_UPLOAD_LIMITS.storageBucket)
        .createSignedUrl(row.storage_path, 3600); // 1 hour

      if (signedError) console.warn('Failed to generate signed URL:', signedError.message);

      attachments.push({
        ...transformAttachment(row),
        signedUrl: signedData?.signedUrl,
      });
    }

    return { data: attachments };
  } catch (error) {
    console.error('getPermitAttachments error:', error);
    return {
      data: [],
      error: 'Failed to fetch attachments',
    };
  }
}
