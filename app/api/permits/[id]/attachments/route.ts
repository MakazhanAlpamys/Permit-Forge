// ============================================================================
// Permit attachment upload API route (mirrors C5H/H6 document-upload route)
// ============================================================================
// Moved off the `uploadPermitAttachment` server action's request path so a
// permit attachment (up to 10MB) isn't rejected by the global 1MB
// serverActions.bodySizeLimit ("Body exceeded 1 MB limit", HTTP 413). API
// routes don't share that cap. Auth / CSRF / rate-limit run here; the upload
// flow is reused from lib/permit-attachment-upload.
// ============================================================================

import { NextRequest } from 'next/server';
import { validateCSRFToken } from '@/lib/auth';
import { requireAuth } from '@/lib/security';
import { checkRateLimit } from '@/lib/supabase-server';
import { applySecurityHeaders } from '@/lib/api-security-headers';
import { uploadPermitAttachmentShared } from '@/lib/permit-attachment-upload';

function jsonResponse(payload: Record<string, unknown>, status: number): Response {
  return applySecurityHeaders(
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // AUTH-C1: route through requireAuth so JWT.tv vs. users.token_version is
  // enforced — a revoked session can't keep uploading for the token lifetime.
  const auth = await requireAuth();
  if (!auth.success || !auth.user) {
    return jsonResponse({ success: false, error: auth.error || 'Unauthorized' }, 401);
  }

  const csrfToken = request.headers.get('x-csrf-token');
  const csrfValid = csrfToken ? await validateCSRFToken(csrfToken) : false;
  if (!csrfValid) {
    return jsonResponse({ success: false, error: 'CSRF token invalid' }, 403);
  }

  // S-H-1: attachment uploads keep their own rate-limit bucket so they don't
  // starve other actions.
  const rateLimit = await checkRateLimit(auth.user.id, { endpoint: 'permit-attachment' });
  if (!rateLimit.allowed) {
    return jsonResponse(
      { success: false, error: 'Too many requests. Please wait before uploading again.' },
      429,
    );
  }

  const { id: permitId } = await params;

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return jsonResponse({ success: false, error: 'Invalid form data' }, 400);
  }

  const file = formData.get('file');

  try {
    const result = await uploadPermitAttachmentShared({
      permitId,
      file: file instanceof File ? file : null,
      uploadedByUserId: auth.user.id,
    });
    return jsonResponse({ ...result }, result.success ? 200 : 400);
  } catch (error) {
    console.error('permit attachment upload route error:', error);
    return jsonResponse({ success: false, error: 'Failed to upload attachment' }, 500);
  }
}
