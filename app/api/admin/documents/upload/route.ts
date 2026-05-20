// ============================================================================
// Admin document PDF upload (C5H / H6)
// ============================================================================
// Moved off the `uploadDocumentPDF` server action so the global 100MB
// `serverActions.bodySizeLimit` in next.config.ts can be dropped — only this
// one endpoint actually needs to accept large bodies, and API routes don't
// share the server-action body cap.
// ============================================================================

import { NextRequest } from 'next/server';
import { getQuickSession, validateCSRFToken, getRequestMetadata } from '@/lib/auth';
import { applySecurityHeaders } from '@/lib/api-security-headers';
import { uploadDocumentPdfShared } from '@/lib/document-pdf-upload';

function jsonResponse(payload: Record<string, unknown>, status: number): Response {
  return applySecurityHeaders(
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

export async function POST(request: NextRequest) {
  const user = await getQuickSession();
  if (!user || user.role !== 'admin') {
    return jsonResponse({ success: false, error: 'Unauthorized' }, 401);
  }

  const csrfToken = request.headers.get('x-csrf-token');
  const csrfValid = csrfToken ? await validateCSRFToken(csrfToken) : false;
  if (!csrfValid) {
    return jsonResponse({ success: false, error: 'CSRF token invalid' }, 403);
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return jsonResponse({ success: false, error: 'Invalid form data' }, 400);
  }

  const documentId = formData.get('documentId');
  if (typeof documentId !== 'string') {
    return jsonResponse({ success: false, error: 'Missing documentId' }, 400);
  }

  const file = formData.get('file');
  if (!(file instanceof File)) {
    return jsonResponse({ success: false, error: 'No file provided' }, 400);
  }

  const metadata = await getRequestMetadata();
  const result = await uploadDocumentPdfShared({
    documentId,
    file,
    uploadedByUserId: user.id,
    ipAddress: metadata.ipAddress,
    userAgent: metadata.userAgent,
  });

  return jsonResponse({ ...result }, result.success ? 200 : 400);
}
