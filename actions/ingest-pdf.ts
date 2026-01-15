'use server';

// ============================================================================
// PDF Ingestion Server Actions (Admin Only)
// ============================================================================

import { createAdminClient } from '@/lib/supabase-server';
import { requireAdmin } from '@/lib/security';
import { runIngestionPipeline } from '@/lib/pdf-ingestion';
import { logAuditEvent, getRequestMetadata } from '@/lib/auth';
import type { ChunkMetadata, IngestionResult } from '@/types';

// -----------------------------------------------------------------------------
// Main Ingestion Action (Uses centralized pipeline)
// -----------------------------------------------------------------------------

export async function ingestPDF(): Promise<IngestionResult> {
  // SECURITY: Verify admin role
  const authCheck = await requireAdmin();
  if (!authCheck.success || !authCheck.user) {
    return {
      success: false,
      chunksProcessed: 0,
      error: authCheck.error || 'Unauthorized',
    };
  }

  console.log('📄 Starting PDF ingestion...');
  
  // Log admin action
  const metadata = await getRequestMetadata();
  await logAuditEvent({
    userId: authCheck.user.id,
    action: 'pdf_ingested',
    metadata: { stage: 'started' },
    ...metadata,
  });
  
  const result = await runIngestionPipeline();
  
  // Log completion
  await logAuditEvent({
    userId: authCheck.user.id,
    action: 'pdf_ingested',
    metadata: { 
      stage: 'completed',
      success: result.success,
      chunksProcessed: result.chunksProcessed,
    },
    ...metadata,
  });
  
  return result;
}

// -----------------------------------------------------------------------------
// Clear Database Action
// -----------------------------------------------------------------------------

export async function clearChunks(): Promise<{ success: boolean; error?: string }> {
  // SECURITY: Verify admin role
  const authCheck = await requireAdmin();
  if (!authCheck.success || !authCheck.user) {
    return { success: false, error: authCheck.error || 'Unauthorized' };
  }

  try {
    const supabase = createAdminClient();
    
    // Check if table exists and has data
    const { count, error: countError } = await supabase
      .from('dubai_code_chunks')
      .select('*', { count: 'exact', head: true });
    
    if (countError) {
      console.error('Clear chunks - access check error:', countError);
      return { 
        success: false, 
        error: `Access error: ${countError.message}. Please ensure the SQL migration has been run.` 
      };
    }
    
    if (count === 0) {
      return { success: true };
    }
    
    // Delete all rows
    const { error } = await supabase
      .from('dubai_code_chunks')
      .delete()
      .gte('id', 0);

    if (error) {
      console.error('Clear chunks - delete error:', error);
      return { 
        success: false, 
        error: `Delete error: ${error.message}` 
      };
    }

    console.log(`✅ Cleared ${count} chunks from database`);
    
    // Log admin action
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
    console.error('Clear chunks error:', errorMessage);
    return { 
      success: false, 
      error: `Failed to clear chunks: ${errorMessage}` 
    };
  }
}

// -----------------------------------------------------------------------------
// Get Ingestion Status
// -----------------------------------------------------------------------------

export async function getIngestionStatus(): Promise<{
  hasChunks: boolean;
  chunkCount: number;
  lastUpdated?: string;
  dbConnected: boolean;
  pageRange?: { min: number; max: number };
  hasTOC?: boolean;
  hasPageRanges?: boolean;
  error?: string;
}> {
  // SECURITY: Verify admin role
  const authCheck = await requireAdmin();
  if (!authCheck.success) {
    return {
      hasChunks: false,
      chunkCount: 0,
      dbConnected: false,
      error: authCheck.error || 'Unauthorized',
    };
  }

  try {
    const supabase = createAdminClient();
    
    const { count, error } = await supabase
      .from('dubai_code_chunks')
      .select('*', { count: 'exact', head: true });

    if (error) {
      console.error('Ingestion status - DB error:', error);
      return {
        hasChunks: false,
        chunkCount: 0,
        dbConnected: false,
        error: `Database error: ${error.message}. Make sure to run the SQL migration.`,
      };
    }

    // Get page range and check for new metadata fields
    let minPage = 1;
    let maxPage = 1;
    let hasTOC = false;
    let hasPageRanges = false;
    
    if (count && count > 0) {
      const { data: sampleData, error: sampleError } = await supabase
        .from('dubai_code_chunks')
        .select('metadata')
        .limit(100);

      if (!sampleError && sampleData && sampleData.length > 0) {
        const pages: number[] = [];
        
        for (const d of sampleData) {
          const metadata = d.metadata as ChunkMetadata;
          
          if (metadata?.startPage && metadata?.endPage) {
            hasPageRanges = true;
            pages.push(metadata.startPage, metadata.endPage);
          } else if (metadata?.page) {
            pages.push(metadata.page);
          }
          
          if (metadata?.sectionPath && metadata.sectionPath.length > 0) {
            hasTOC = true;
          }
        }
        
        if (pages.length > 0) {
          minPage = Math.min(...pages);
          maxPage = Math.max(...pages);
        }
      }
    }

    return {
      hasChunks: (count || 0) > 0,
      chunkCount: count || 0,
      dbConnected: true,
      pageRange: { min: minPage, max: maxPage },
      hasTOC,
      hasPageRanges,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Ingestion status check failed:', errorMessage);
    return { 
      hasChunks: false, 
      chunkCount: 0, 
      dbConnected: false,
      error: `Database connection failed: ${errorMessage}`
    };
  }
}

// -----------------------------------------------------------------------------
// Test RAG Function
// -----------------------------------------------------------------------------

export async function testRAGQuery(): Promise<{
  success: boolean;
  chunksFound: number;
  sampleChunk?: { 
    page: number;
    startPage?: number;
    endPage?: number;
    section?: string;
    sectionTitle?: string;
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
      console.error('RAG test - count error:', countError);
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
        error: 'No chunks in database. Please ingest the PDF first.',
      };
    }
    
    const { data: sampleData, error: sampleError } = await supabase
      .from('dubai_code_chunks')
      .select('content, metadata')
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
        sectionTitle: metadata?.sectionTitle,
        preview: (sampleData.content as string).slice(0, 100) + '...',
      } : undefined,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'RAG test failed';
    console.error('RAG test query error:', errorMessage);
    return {
      success: false,
      chunksFound: 0,
      error: `RAG test failed: ${errorMessage}`,
    };
  }
}
