// ============================================================================
// PDF Ingestion API Route with Progress Streaming — Multi-Document
// ============================================================================

import { NextRequest } from 'next/server';
import { getQuickSession } from '@/lib/auth';
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
  let pdfBuffer: Buffer | undefined;
  let pdfPath: string | undefined;

  try {
    const body = await request.json();
    documentId = body.documentId;

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

      pdfBuffer = Buffer.from(await blob.arrayBuffer());
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
      await sendProgress({
        stage: 'error',
        progress: 0,
        total: 100,
        message: 'Ingestion failed',
        done: true,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      await writer.close();
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
