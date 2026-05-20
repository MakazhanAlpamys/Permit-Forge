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
  let replaceChunks = false;
  let pdfHash: string | null = null;

  try {
    const body = await request.json();
    documentId = body.documentId;
    // B5: client signals consent to overwrite prior chunks. The action layer
    // is the only place that validates whether replacing is justified — this
    // route just honors the flag.
    replaceChunks = body.replaceChunks === true;

    if (!documentId) {
      return jsonError({ error: 'Missing documentId' }, 400);
    }

    // SECURITY: Validate documentId from DB registry
    const supabase = createAdminClient();
    const { data: dbDoc } = await supabase
      .from('document_registry')
      .select('file_name, is_active, storage_path, pdf_hash')
      .eq('id', documentId)
      .single();

    if (!dbDoc || !dbDoc.is_active) {
      return jsonError({ error: 'Unknown document ID' }, 400);
    }

    pdfHash = (dbDoc.pdf_hash as string | null) ?? null;

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

  // B4: pre-create an admin client used for ingestion_state bookkeeping so
  // every stage stamps the same row without creating fresh clients.
  const bookkeepingSupabase = createAdminClient();

  // B4: AbortSignal from the inbound request fires when the client tab closes
  // or explicitly aborts (e.g. the admin UI's "Cancel" button). We can't
  // synchronously cancel chunk inserts mid-batch, but we can short-circuit
  // between stages and stamp the registry row so the admin sees what
  // happened.
  const requestSignal: AbortSignal | undefined = request.signal;

  // Helper to send progress updates
  const sendProgress = async (data: IngestionProgress) => {
    await writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
  };

  // B4: stamp ingestion_state at each lifecycle boundary.
  async function markIngestionState(state: 'pending' | 'completed' | 'failed' | 'aborted') {
    try {
      const update: Record<string, unknown> = { ingestion_state: state };
      if (state === 'pending') {
        update.ingestion_started_at = new Date().toISOString();
        update.ingestion_finished_at = null;
      } else {
        update.ingestion_finished_at = new Date().toISOString();
      }
      await bookkeepingSupabase.from('document_registry').update(update).eq('id', documentId);
    } catch (markError) {
      console.error('Failed to mark ingestion_state:', markError);
    }
  }

  // Start processing in background
  (async () => {
    let pipelineSucceeded = false;
    try {
      await markIngestionState('pending');

      // Send initial progress
      await sendProgress({
        stage: 'reading',
        progress: 0,
        total: 100,
        message: `Reading PDF for ${documentId}...`,
      });

      // B4: early-abort check between stages. Throwing into the catch lets the
      // finally block stamp ingestion_state=aborted and close the stream.
      if (requestSignal?.aborted) {
        throw new DOMException('Aborted by client', 'AbortError');
      }

      // B5: when the caller asked to replace, clear prior chunks BEFORE the
      // pipeline starts inserting. We can't make this truly transactional
      // across a streaming pipeline, but clearing first guarantees the chunk
      // table is never simultaneously old + new.
      if (replaceChunks) {
        const adminSupabase = createAdminClient();
        await adminSupabase
          .from('dubai_code_chunks')
          .delete()
          .eq('document_name', documentId);
        await adminSupabase
          .from('parent_chunks')
          .delete()
          .eq('document_name', documentId);
        await adminSupabase
          .from('document_trees')
          .delete()
          .eq('document_name', documentId);
      }

      if (requestSignal?.aborted) {
        throw new DOMException('Aborted by client', 'AbortError');
      }

      // Run the centralized ingestion pipeline with document info. We hook
      // onProgress to also check the abort signal — that's the only natural
      // re-entry point we have into the pipeline without rewriting it.
      const pipelineResult = await runIngestionPipeline({
        documentId,
        ...(pdfBuffer ? { pdfBuffer } : { pdfPath }),
        onProgress: async (data) => {
          if (requestSignal?.aborted) {
            // Throw inside onProgress so the pipeline unwinds at the next
            // await point instead of completing the current stage silently.
            throw new DOMException('Aborted by client', 'AbortError');
          }
          await sendProgress(data);
        },
      });

      pipelineSucceeded = !!pipelineResult?.success;

      // B5: stamp last_ingested_pdf_hash so the next re-ingest can detect
      // whether the *content* changed (vs. the same file being re-ingested).
      if (pipelineSucceeded && pdfHash) {
        await bookkeepingSupabase
          .from('document_registry')
          .update({ last_ingested_pdf_hash: pdfHash })
          .eq('id', documentId);
      }
    } catch (error) {
      const isAbort = error instanceof DOMException && error.name === 'AbortError';
      if (isAbort) {
        console.warn('Ingestion aborted by client');
      } else {
        console.error('Ingestion error:', error);
      }
      try {
        await sendProgress({
          stage: isAbort ? 'aborted' : 'error',
          progress: 0,
          total: 100,
          message: isAbort ? 'Ingestion cancelled.' : 'Ingestion failed',
          done: true,
          error: isAbort ? 'Aborted by client' : 'Ingestion pipeline encountered an error',
        });
      } catch { /* client disconnected */ }
      await markIngestionState(isAbort ? 'aborted' : 'failed');
      return;
    } finally {
      try { await writer.close(); } catch { /* client disconnected */ }
    }
    await markIngestionState(pipelineSucceeded ? 'completed' : 'failed');
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
