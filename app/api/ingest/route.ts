// ============================================================================
// PDF Ingestion API Route with Progress Streaming
// ============================================================================

import { NextRequest } from 'next/server';
import { getQuickSession } from '@/lib/auth';
import { runIngestionPipeline, type IngestionProgress } from '@/lib/pdf-ingestion';

// -----------------------------------------------------------------------------
// Streaming API Route
// -----------------------------------------------------------------------------

export async function POST(_request: NextRequest) {
  // Check authentication
  const user = await getQuickSession();
  if (!user || user.role !== 'admin') {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
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
        message: 'Reading PDF file...',
      });

      // Run the centralized ingestion pipeline with progress callback
      await runIngestionPipeline(sendProgress);
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
