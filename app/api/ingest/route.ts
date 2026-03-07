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
  let pdfPath: string;

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
      .select('file_name, is_active')
      .eq('id', documentId)
      .single();

    if (!dbDoc || !dbDoc.is_active) {
      return new Response(JSON.stringify({ error: 'Unknown document ID' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // SECURITY: strict filename validation — only allow safe PDF filenames
    const rawName = dbDoc.file_name as string;
    const fileName = rawName.split(/[\/\\]/).pop() || '';
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.pdf$/i.test(fileName)) {
      return new Response(JSON.stringify({ error: 'Invalid file name in document registry' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    pdfPath = `public/${fileName}`;
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
        pdfPath,
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
