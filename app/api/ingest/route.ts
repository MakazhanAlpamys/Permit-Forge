// ============================================================================
// PDF Ingestion API Route with Progress Streaming — Multi-Document
// ============================================================================

import { NextRequest } from 'next/server';
import { getQuickSession, validateCSRFToken } from '@/lib/auth';
import { checkRateLimit } from '@/lib/supabase-server';
import { runIngestionPipeline, type IngestionProgress } from '@/lib/pdf-ingestion';
import { createAdminClient } from '@/lib/supabase-server';

// -----------------------------------------------------------------------------
// Streaming API Route
// -----------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  // Check authentication
  const user = await getQuickSession();
  if (!user || user.role !== 'admin') {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // CSRF validation
  const csrfToken = request.headers.get('x-csrf-token');
  const csrfValid = csrfToken ? await validateCSRFToken(csrfToken) : false;
  if (!csrfValid) {
    return new Response(JSON.stringify({ error: 'CSRF token invalid' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Rate limiting
  const rateLimitResult = await checkRateLimit(user.id);
  if (!rateLimitResult.allowed) {
    return new Response(JSON.stringify({
      error: 'Rate limited',
      retryAfter: rateLimitResult.retryAfterMs,
    }), {
      status: 429,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Parse request body for document info
  let documentId: string;
  let pdfBuffer: Uint8Array | undefined;
  let pdfPath: string | undefined;
  let clearFirst = false;

  try {
    const body = await request.json();
    documentId = body.documentId;
    clearFirst = body.clearFirst === true;

    if (!documentId) {
      return new Response(JSON.stringify({ error: 'Missing documentId' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // SECURITY: Validate documentId from DB registry
    const supabase = createAdminClient();
    const { data: dbDoc } = await supabase
      .from('document_registry')
      .select('file_name, is_active, storage_path')
      .eq('id', documentId)
      .single();

    if (!dbDoc || !dbDoc.is_active) {
      return new Response(JSON.stringify({ error: 'Unknown document ID' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (dbDoc.storage_path) {
      // Download PDF from Supabase Storage
      const { data: blob, error: dlError } = await supabase.storage
        .from('document-pdfs')
        .download(dbDoc.storage_path);

      if (dlError || !blob) {
        return new Response(JSON.stringify({ error: 'Failed to download PDF from storage' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      pdfBuffer = new Uint8Array(await blob.arrayBuffer());
    } else {
      // Fallback: read from public/ folder (local dev)
      const rawName = dbDoc.file_name as string;
      const fileName = rawName.split(/[\/\\]/).pop() || '';
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.pdf$/i.test(fileName)) {
        return new Response(JSON.stringify({ error: 'No PDF uploaded. Upload a PDF file first.' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      pdfPath = `public/${fileName}`;
    }
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid request body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Create a TransformStream for streaming progress
  const encoder = new TextEncoder();
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();

  // Helper to send progress updates
  const sendProgress = async (data: IngestionProgress) => {
    await writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
  };

  // P2-C2: react to client disconnect — abort flag is read by the pipeline.
  let aborted = false;
  request.signal.addEventListener('abort', () => { aborted = true; });

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

      // P2-C3: re-ingest path clears prior chunks atomically before re-running. Without
      // this, a re-ingest after a PDF replace leaves stale chunks with stale page numbers
      // alongside new chunks, silently corrupting citations.
      if (clearFirst) {
        const supabase = createAdminClient();
        await supabase.from('dubai_code_chunks').delete().eq('document_name', documentId);
        await supabase.from('parent_chunks').delete().eq('document_name', documentId);
        await supabase.from('document_trees').delete().eq('document_name', documentId);
      }

      if (aborted) {
        await sendProgress({ stage: 'error', progress: 0, total: 100, message: 'Aborted by client', done: true, error: 'aborted' });
        return;
      }

      // Run the centralized ingestion pipeline with document info
      await runIngestionPipeline({
        documentId,
        ...(pdfBuffer ? { pdfBuffer } : { pdfPath }),
        onProgress: async (p) => {
          if (aborted) throw new Error('aborted');
          await sendProgress(p);
        },
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

  return new Response(stream.readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
