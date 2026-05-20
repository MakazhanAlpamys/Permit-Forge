// ============================================================================
// PDF Ingestion API Route with Progress Streaming — Multi-Document
// ============================================================================

import { NextRequest } from 'next/server';
import { getQuickSession, validateCSRFToken } from '@/lib/auth';
import { checkRateLimit } from '@/lib/supabase-server';
import { runIngestionPipeline, type IngestionProgress } from '@/lib/pdf-ingestion';
import { createAdminClient } from '@/lib/supabase-server';
import { applySecurityHeaders } from '@/lib/api-security-headers';

function jsonError(payload: Record<string, unknown>, status: number): Response {
  return applySecurityHeaders(
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

// -----------------------------------------------------------------------------
// Streaming API Route
// -----------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  // Check authentication
  const user = await getQuickSession();
  if (!user || user.role !== 'admin') {
    return jsonError({ error: 'Unauthorized' }, 401);
  }

  // CSRF validation
  const csrfToken = request.headers.get('x-csrf-token');
  const csrfValid = csrfToken ? await validateCSRFToken(csrfToken) : false;
  if (!csrfValid) {
    return jsonError({ error: 'CSRF token invalid' }, 403);
  }

  // Rate limiting
  const rateLimitResult = await checkRateLimit(user.id);
  if (!rateLimitResult.allowed) {
    return jsonError({ error: 'Rate limited', retryAfter: rateLimitResult.retryAfterMs }, 429);
  }

  // Parse request body for document info
  let documentId: string;
  let pdfBuffer: Uint8Array | undefined;
  let pdfPath: string | undefined;

  try {
    const body = await request.json();
    documentId = body.documentId;

    if (!documentId) {
      return jsonError({ error: 'Missing documentId' }, 400);
    }

    // SECURITY: Validate documentId from DB registry
    const supabase = createAdminClient();
    const { data: dbDoc } = await supabase
      .from('document_registry')
      .select('file_name, is_active, storage_path')
      .eq('id', documentId)
      .single();

    if (!dbDoc || !dbDoc.is_active) {
      return jsonError({ error: 'Unknown document ID' }, 400);
    }

    if (dbDoc.storage_path) {
      // Download PDF from Supabase Storage
      const { data: blob, error: dlError } = await supabase.storage
        .from('document-pdfs')
        .download(dbDoc.storage_path);

      if (dlError || !blob) {
        return jsonError({ error: 'Failed to download PDF from storage' }, 500);
      }

      pdfBuffer = new Uint8Array(await blob.arrayBuffer());
    } else {
      // Fallback: read from public/ folder (local dev)
      const rawName = dbDoc.file_name as string;
      const fileName = rawName.split(/[\/\\]/).pop() || '';
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.pdf$/i.test(fileName)) {
        return jsonError({ error: 'No PDF uploaded. Upload a PDF file first.' }, 400);
      }
      pdfPath = `public/${fileName}`;
    }
  } catch {
    return jsonError({ error: 'Invalid request body' }, 400);
  }

  // Create a TransformStream for streaming progress
  const encoder = new TextEncoder();
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();

  // Helper to send progress updates
  const sendProgress = async (data: IngestionProgress) => {
    await writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
  };

  // Start processing in background
  (async () => {
    try {
      // Send initial progress
      await sendProgress({
        stage: 'reading',
        progress: 0,
        total: 100,
        message: `Reading PDF for ${documentId}...`,
      });

      // Run the centralized ingestion pipeline with document info
      await runIngestionPipeline({
        documentId,
        ...(pdfBuffer ? { pdfBuffer } : { pdfPath }),
        onProgress: sendProgress,
      });
    } catch (error) {
      console.error('Ingestion error:', error);
      try {
        await sendProgress({
          stage: 'error',
          progress: 0,
          total: 100,
          message: 'Ingestion failed',
          done: true,
          error: 'Ingestion pipeline encountered an error',
        });
      } catch { /* client disconnected */ }
    } finally {
      try { await writer.close(); } catch { /* client disconnected */ }
    }
  })();

  return applySecurityHeaders(
    new Response(stream.readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    }),
  );
}
