'use server';

// ============================================================================
// Permit Attachment Server Actions
// ============================================================================

import { createAdminClient, checkRateLimit } from '@/lib/supabase-server';
import { getQuickSession, logAuditWithMeta } from '@/lib/auth';
import { requireAuth, requireCSRF } from '@/lib/security';
import { uuidSchema } from '@/lib/validations';
import { FILE_UPLOAD_LIMITS, PERMIT_ATTACHMENT_SIGNED_URL_TTL_SECONDS } from '@/lib/constants';
import { canPerformOperation, type PermitStatus } from '@/lib/permit-state-machine';
import { uploadPermitAttachmentShared, transformAttachment } from '@/lib/permit-attachment-upload';
import type { PermitAttachment } from '@/types';

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
    // S-H-1 / v1.0.0 Part F: attachment uploads get their own bucket so they
    // don't starve other actions in 'default'.
    const rateLimitResult = await checkRateLimit(authCheck.user.id, {
      endpoint: 'permit-attachment',
    });
    if (!rateLimitResult.allowed) {
      return { success: false, error: 'Too many requests. Please wait before uploading again.' };
    }

    // The ownership + status + file-validation + storage + capped-insert flow
    // lives in the shared helper so the /api/permits/[id]/attachments route can
    // run the exact same path without the 1MB Server Action body cap. The file
    // may be absent here — the helper does the "No file provided" check after
    // the ownership/status checks, preserving the original error ordering.
    const file = formData.get('file');
    return await uploadPermitAttachmentShared({
      permitId,
      file: file instanceof File ? file : null,
      uploadedByUserId: authCheck.user.id,
    });
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

    const deleteCheck = canPerformOperation(
      attachment.permit_applications.status as PermitStatus,
      'delete_attachment',
    );
    if (!deleteCheck.allowed) {
      return { success: false, error: deleteCheck.reason };
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

    await logAuditWithMeta(authCheck.user.id, 'permit_attachment_deleted', {
      metadata: { attachmentId, permitId: attachment.permit_id, fileName: attachment.file_name },
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

    // v1.10.0 Part A: Supabase Storage doesn't expose a batch createSignedUrl
    // endpoint, but the per-row calls are independent — Promise.all parallelises
    // the network latency so a 10-attachment permit fans out into one round-trip
    // window instead of 10 sequential round trips.
    const adminClient = createAdminClient();
    const rows = data || [];
    const signedResults = await Promise.all(
      rows.map((row) =>
        adminClient.storage
          .from(FILE_UPLOAD_LIMITS.storageBucket)
          .createSignedUrl(row.storage_path, PERMIT_ATTACHMENT_SIGNED_URL_TTL_SECONDS),
      ),
    );

    const attachments: PermitAttachment[] = rows.map((row, i) => {
      const { data: signedData, error: signedError } = signedResults[i];
      if (signedError) console.warn('Failed to generate signed URL:', signedError.message);
      return {
        ...transformAttachment(row),
        signedUrl: signedData?.signedUrl,
      };
    });

    return { data: attachments };
  } catch (error) {
    console.error('getPermitAttachments error:', error);
    return {
      data: [],
      error: 'Failed to fetch attachments',
    };
  }
}
