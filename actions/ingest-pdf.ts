'use server';

// ============================================================================
// PDF Ingestion Server Actions (Admin Only) — Multi-Document Support
// ============================================================================

import { createAdminClient } from '@/lib/supabase-server';
import { requireAdmin, requireCSRF } from '@/lib/security';
import { runIngestionPipeline } from '@/lib/pdf-ingestion';
import { clearDocumentTreeCache } from '@/lib/tree-cache';
import { logAuditEvent, getRequestMetadata } from '@/lib/auth';
import type { ChunkMetadata, IngestionResult } from '@/types';

// -----------------------------------------------------------------------------
// Main Ingestion Action — Per-Document
// -----------------------------------------------------------------------------

export async function ingestPDF(
  documentId: string,
  csrfToken: string,
  options: { replaceChunks?: boolean } = {}
): Promise<IngestionResult> {
  // SECURITY: Verify admin role
  const authCheck = await requireAdmin();
  if (!authCheck.success || !authCheck.user) {
    return {
      success: false,
      chunksProcessed: 0,
      error: authCheck.error || 'Unauthorized',
    };
  }

  const csrf = await requireCSRF(csrfToken);
  if (!csrf.valid) return { success: false, chunksProcessed: 0, error: csrf.error };

  if (!documentId) {
    return {
      success: false,
      chunksProcessed: 0,
      error: 'Missing documentId',
    };
  }

  // SECURITY: Validate documentId from DB registry
  const supabase = createAdminClient();
  const { data: dbDoc } = await supabase
    .from('document_registry')
    .select('file_name, is_active, storage_path, pdf_hash')
    .eq('id', documentId)
    .single();

  if (!dbDoc || !dbDoc.is_active) {
    return {
      success: false,
      chunksProcessed: 0,
      error: 'Unknown document ID',
    };
  }

  // B5: caller-supplied replace flag. The streaming API route owns the UI
  // confirm flow; this action mirrors the same handling for the (rare)
  // direct server-action call path so the two ingestion entry points
  // behave the same way.
  if (options.replaceChunks) {
    await supabase.from('dubai_code_chunks').delete().eq('document_name', documentId);
    await supabase.from('parent_chunks').delete().eq('document_name', documentId);
    await supabase.from('document_trees').delete().eq('document_name', documentId);
  }

  // Determine PDF source: Supabase Storage or local file
  let pdfBuffer: Uint8Array | undefined;
  let pdfPath: string | undefined;

  if (dbDoc.storage_path) {
    // Download from Supabase Storage
    const { data: blob, error: dlError } = await supabase.storage
      .from('document-pdfs')
      .download(dbDoc.storage_path as string);

    if (dlError || !blob) {
      return {
        success: false,
        chunksProcessed: 0,
        error: `Failed to download PDF from storage: ${dlError?.message || 'No data'}`,
      };
    }

    pdfBuffer = new Uint8Array(await blob.arrayBuffer());
  } else {
    // Fallback: read from public/ folder (local dev)
    const rawName = dbDoc.file_name as string;
    const fileName = rawName.split(/[\/\\]/).pop() || '';
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.pdf$/i.test(fileName)) {
      return {
        success: false,
        chunksProcessed: 0,
        error: 'No PDF uploaded. Upload a PDF file first.',
      };
    }
    pdfPath = `public/${fileName}`;
  }

  console.log(`📄 Starting PDF ingestion for document: ${documentId}...`);

  // Log admin action
  const metadata = await getRequestMetadata();
  await logAuditEvent({
    userId: authCheck.user.id,
    action: 'pdf_ingested',
    metadata: { stage: 'started', documentId },
    ...metadata,
  });

  const result = await runIngestionPipeline({
    documentId,
    ...(pdfBuffer ? { pdfBuffer } : { pdfPath }),
  });

  // Invalidate the tree cache for this document
  if (result.success) {
    clearDocumentTreeCache(documentId);
    // B5: record which PDF content produced the now-current chunk set.
    if (dbDoc.pdf_hash) {
      await supabase
        .from('document_registry')
        .update({ last_ingested_pdf_hash: dbDoc.pdf_hash })
        .eq('id', documentId);
    }
  }

  // Log completion
  await logAuditEvent({
    userId: authCheck.user.id,
    action: 'pdf_ingested',
    metadata: {
      stage: 'completed',
      documentId,
      success: result.success,
      chunksProcessed: result.chunksProcessed,
    },
    ...metadata,
  });

  return result;
}

// -----------------------------------------------------------------------------
// Clear Chunks for a Specific Document
// -----------------------------------------------------------------------------

export async function clearDocumentChunks(
  documentId: string,
  csrfToken: string
): Promise<{ success: boolean; deletedCount?: number; error?: string }> {
  // SECURITY: Verify admin role
  const authCheck = await requireAdmin();
  if (!authCheck.success || !authCheck.user) {
    return { success: false, error: authCheck.error || 'Unauthorized' };
  }

  const csrf = await requireCSRF(csrfToken);
  if (!csrf.valid) return { success: false, error: csrf.error };

  if (!documentId) {
    return { success: false, error: 'Missing documentId' };
  }

  try {
    const supabase = createAdminClient();

    // Try the dedicated RPC first
    const { data: rpcResult, error: rpcError } = await supabase.rpc('clear_document_chunks', {
      target_document: documentId,
    });

    if (!rpcError && rpcResult !== null) {
      const deletedCount = typeof rpcResult === 'number' ? rpcResult : 0;

      console.log(`✅ Cleared ${deletedCount} chunks for document: ${documentId}`);

      // Invalidate tree cache for this document
      clearDocumentTreeCache(documentId);

      // Log admin action
      const metadata = await getRequestMetadata();
      await logAuditEvent({
        userId: authCheck.user.id,
        action: 'chunks_cleared',
        metadata: { documentId, chunksCleared: deletedCount },
        ...metadata,
      });

      return { success: true, deletedCount };
    }

    // Fallback: direct delete with filter
    if (rpcError) {
      console.warn('clear_document_chunks RPC not available, using direct delete:', rpcError.message);
    }

    // Count first
    const { count } = await supabase
      .from('dubai_code_chunks')
      .select('*', { count: 'exact', head: true })
      .eq('document_name', documentId);

    // Delete
    const { error: deleteError } = await supabase
      .from('dubai_code_chunks')
      .delete()
      .eq('document_name', documentId);

    if (deleteError) {
      return { success: false, error: `Delete error: ${deleteError.message}` };
    }

    const deletedCount = count || 0;
    console.log(`✅ Cleared ${deletedCount} chunks for document: ${documentId}`);

    clearDocumentTreeCache(documentId);

    const metadata = await getRequestMetadata();
    await logAuditEvent({
      userId: authCheck.user.id,
      action: 'chunks_cleared',
      metadata: { documentId, chunksCleared: deletedCount },
      ...metadata,
    });

    return { success: true, deletedCount };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Clear document chunks error:', errorMessage);
    return { success: false, error: `Failed to clear chunks: ${errorMessage}` };
  }
}

// -----------------------------------------------------------------------------
// Clear All Chunks (Legacy)
// -----------------------------------------------------------------------------

export async function clearChunks(
  csrfToken: string
): Promise<{ success: boolean; error?: string }> {
  // SECURITY: Verify admin role
  const authCheck = await requireAdmin();
  if (!authCheck.success || !authCheck.user) {
    return { success: false, error: authCheck.error || 'Unauthorized' };
  }

  const csrf = await requireCSRF(csrfToken);
  if (!csrf.valid) return { success: false, error: csrf.error };

  try {
    const supabase = createAdminClient();

    const { count, error: countError } = await supabase
      .from('dubai_code_chunks')
      .select('*', { count: 'exact', head: true });

    if (countError) {
      return {
        success: false,
        error: `Access error: ${countError.message}. Please ensure the SQL migration has been run.`
      };
    }

    if (count === 0) {
      return { success: true };
    }

    const { error } = await supabase
      .from('dubai_code_chunks')
      .delete()
      .gte('id', 0);

    if (error) {
      return { success: false, error: `Delete error: ${error.message}` };
    }

    console.log(`✅ Cleared all ${count} chunks from database`);
    clearDocumentTreeCache(); // Clear all caches

    const metadata = await getRequestMetadata();
    await logAuditEvent({
      userId: authCheck.user.id,
      action: 'chunks_cleared',
      metadata: { chunksCleared: count },
      ...metadata,
    });

    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: `Failed to clear chunks: ${errorMessage}` };
  }
}

// -----------------------------------------------------------------------------
// Get Ingestion Status — Multi-Document
// -----------------------------------------------------------------------------

export async function getIngestionStatus(): Promise<{
  hasChunks: boolean;
  chunkCount: number;
  documentStats: { document_name: string; chunk_count: number; min_page: number; max_page: number }[];
  lastUpdated?: string;
  dbConnected: boolean;
  error?: string;
}> {
  // SECURITY: Verify admin role
  const authCheck = await requireAdmin();
  if (!authCheck.success) {
    return {
      hasChunks: false,
      chunkCount: 0,
      documentStats: [],
      dbConnected: false,
      error: authCheck.error || 'Unauthorized',
    };
  }

  try {
    const supabase = createAdminClient();

    // Get total count
    const { count, error } = await supabase
      .from('dubai_code_chunks')
      .select('*', { count: 'exact', head: true });

    if (error) {
      return {
        hasChunks: false,
        chunkCount: 0,
        documentStats: [],
        dbConnected: false,
        error: `Database error: ${error.message}. Make sure to run the SQL migration.`,
      };
    }

    // F7: The get_document_stats RPC is seeded in 000_full_setup.sql, so we
    // trust it to exist in any environment where the rest of the app boots.
    // (Previously we kept an in-memory aggregation fallback; that branch was
    // dead in production and was hiding the real error when the RPC misfired.)
    const { data: statsData, error: statsError } = await supabase.rpc('get_document_stats');

    if (statsError) {
      console.error('get_document_stats RPC error:', statsError.message);
      return {
        hasChunks: (count || 0) > 0,
        chunkCount: count || 0,
        documentStats: [],
        dbConnected: true,
        error: `Per-document stats unavailable: ${statsError.message}`,
      };
    }

    const documentStats =
      (statsData as { document_name: string; chunk_count: number; min_page: number; max_page: number }[]) || [];

    return {
      hasChunks: (count || 0) > 0,
      chunkCount: count || 0,
      documentStats,
      dbConnected: true,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      hasChunks: false,
      chunkCount: 0,
      documentStats: [],
      dbConnected: false,
      error: `Database connection failed: ${errorMessage}`
    };
  }
}

// -----------------------------------------------------------------------------
// Test RAG Function — Multi-Document
// -----------------------------------------------------------------------------

export async function testRAGQuery(): Promise<{
  success: boolean;
  chunksFound: number;
  sampleChunk?: {
    page: number;
    startPage?: number;
    endPage?: number;
    section?: string;
    documentName?: string;
    preview: string;
  };
  error?: string;
}> {
  // SECURITY: Verify admin role
  const authCheck = await requireAdmin();
  if (!authCheck.success) {
    return {
      success: false,
      chunksFound: 0,
      error: authCheck.error || 'Unauthorized',
    };
  }

  try {
    const supabase = createAdminClient();

    const { count, error: countError } = await supabase
      .from('dubai_code_chunks')
      .select('*', { count: 'exact', head: true });

    if (countError) {
      return {
        success: false,
        chunksFound: 0,
        error: `Table access error: ${countError.message}. Make sure to run the SQL migration.`,
      };
    }

    if (!count || count === 0) {
      return {
        success: true,
        chunksFound: 0,
        error: 'No chunks in database. Please ingest documents first.',
      };
    }

    // Try hybrid search RPC to verify it works
    const { error: rpcError } = await supabase.rpc('match_dubai_code_hybrid', {
      query_text: 'test',
      query_embedding: new Array(768).fill(0),
      match_count: 1,
      keyword_weight: 0.3,
      vector_weight: 0.7,
      rrf_k: 60,
      filter_document: null,
    });

    if (rpcError) {
      return {
        success: false,
        chunksFound: count,
        error: `Hybrid search RPC error: ${rpcError.message}. Run migration 004 for multi-document support.`,
      };
    }

    const { data: sampleData, error: sampleError } = await supabase
      .from('dubai_code_chunks')
      .select('content, metadata, document_name')
      .limit(1)
      .single();

    if (sampleError) {
      return {
        success: false,
        chunksFound: 0,
        error: `Sample query error: ${sampleError.message}`,
      };
    }

    const metadata = sampleData?.metadata as ChunkMetadata;

    return {
      success: true,
      chunksFound: count,
      sampleChunk: sampleData ? {
        page: metadata?.page || 0,
        startPage: metadata?.startPage,
        endPage: metadata?.endPage,
        section: metadata?.section,
        documentName: (sampleData as { document_name?: string }).document_name || metadata?.documentName,
        preview: (sampleData.content as string).slice(0, 100) + '...',
      } : undefined,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'RAG test failed';
    return {
      success: false,
      chunksFound: 0,
      error: `RAG test failed: ${errorMessage}`,
    };
  }
}
