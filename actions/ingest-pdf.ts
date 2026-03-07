'use server';

// ============================================================================
// PDF Ingestion Server Actions (Admin Only) — Multi-Document Support
// ============================================================================

import { createAdminClient } from '@/lib/supabase-server';
import { requireAdmin } from '@/lib/security';
import { runIngestionPipeline } from '@/lib/pdf-ingestion';
import { clearDocumentTreeCache } from '@/lib/tree-cache';
import { logAuditEvent, getRequestMetadata } from '@/lib/auth';
import type { ChunkMetadata, IngestionResult } from '@/types';

// -----------------------------------------------------------------------------
// Main Ingestion Action — Per-Document
// -----------------------------------------------------------------------------

export async function ingestPDF(
  documentId: string
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
    .select('file_name, is_active')
    .eq('id', documentId)
    .single();

  if (!dbDoc || !dbDoc.is_active) {
    return {
      success: false,
      chunksProcessed: 0,
      error: 'Unknown document ID',
    };
  }

  // SECURITY: strict filename validation — only allow safe PDF filenames
  const rawName = dbDoc.file_name as string;
  const fileName = rawName.split(/[\/\\]/).pop() || '';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.pdf$/i.test(fileName)) {
    return {
      success: false,
      chunksProcessed: 0,
      error: 'Invalid file name in document registry',
    };
  }
  const pdfPath = `public/${fileName}`;

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
    pdfPath,
  });

  // Invalidate the tree cache for this document
  if (result.success) {
    clearDocumentTreeCache(documentId);
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
  documentId: string
): Promise<{ success: boolean; deletedCount?: number; error?: string }> {
  // SECURITY: Verify admin role
  const authCheck = await requireAdmin();
  if (!authCheck.success || !authCheck.user) {
    return { success: false, error: authCheck.error || 'Unauthorized' };
  }

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

export async function clearChunks(): Promise<{ success: boolean; error?: string }> {
  // SECURITY: Verify admin role
  const authCheck = await requireAdmin();
  if (!authCheck.success || !authCheck.user) {
    return { success: false, error: authCheck.error || 'Unauthorized' };
  }

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

    // Try to get per-document stats via RPC
    let documentStats: { document_name: string; chunk_count: number; min_page: number; max_page: number }[] = [];

    const { data: statsData, error: statsError } = await supabase.rpc('get_document_stats');

    if (!statsError && statsData) {
      documentStats = (statsData as { document_name: string; chunk_count: number; min_page: number; max_page: number }[]);
    } else if (statsError) {
      // Fallback: basic aggregation via direct query
      console.warn('get_document_stats RPC not available:', statsError.message);

      // Get unique document names and counts manually
      if (count && count > 0) {
        const { data: sampleData } = await supabase
          .from('dubai_code_chunks')
          .select('metadata')
          .limit(500);

        if (sampleData) {
          const docMap = new Map<string, { count: number; minPage: number; maxPage: number }>();

          for (const row of sampleData) {
            const meta = row.metadata as ChunkMetadata;
            const docName = meta?.documentName || 'dubai-building-code-2021';
            const page = meta?.page || 0;

            const existing = docMap.get(docName);
            if (existing) {
              existing.count++;
              existing.minPage = Math.min(existing.minPage, page);
              existing.maxPage = Math.max(existing.maxPage, page);
            } else {
              docMap.set(docName, { count: 1, minPage: page, maxPage: page });
            }
          }

          documentStats = Array.from(docMap.entries()).map(([name, stats]) => ({
            document_name: name,
            chunk_count: stats.count,
            min_page: stats.minPage,
            max_page: stats.maxPage,
          }));
        }
      }
    }

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
