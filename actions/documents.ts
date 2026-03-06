'use server';

// ============================================================================
// Document Registry Server Actions (Admin Only)
// ============================================================================

import { createAdminClient } from '@/lib/supabase-server';
import { requireAdmin } from '@/lib/security';
import { logAuditEvent, getRequestMetadata } from '@/lib/auth';
import { clearDocumentTreeCache } from '@/lib/tree-cache';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface DocumentRecord {
  id: string;
  displayName: string;
  shortName: string;
  fileName: string;
  sourceUrl: string;
  authority: string;
  description: string;
  badgeColor: string;
  keywords: string[];
  categories: string[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface DocumentInput {
  id: string;
  displayName: string;
  shortName: string;
  fileName: string;
  sourceUrl?: string;
  authority?: string;
  description?: string;
  badgeColor?: string;
  keywords?: string[];
  categories?: string[];
}

// -----------------------------------------------------------------------------
// Get All Documents (including inactive)
// -----------------------------------------------------------------------------

export async function getAllRegisteredDocuments(): Promise<{
  data: DocumentRecord[];
  error?: string;
}> {
  const authCheck = await requireAdmin();
  if (!authCheck.success) {
    return { data: [], error: authCheck.error || 'Unauthorized' };
  }

  try {
    const supabase = createAdminClient();

    // Try RPC first
    const { data, error } = await supabase.rpc('get_all_documents');

    if (error) {
      // Fallback: direct query
      const { data: directData, error: directError } = await supabase
        .from('document_registry')
        .select('*')
        .order('created_at');

      if (directError) {
        return { data: [], error: directError.message };
      }

      return {
        data: (directData || []).map(mapDbRow),
      };
    }

    return {
      data: (data || []).map(mapDbRow),
    };
  } catch (error) {
    return {
      data: [],
      error: error instanceof Error ? error.message : 'Failed to fetch documents',
    };
  }
}

// -----------------------------------------------------------------------------
// Upsert Document (Create or Update)
// -----------------------------------------------------------------------------

export async function upsertDocument(
  input: DocumentInput
): Promise<{ success: boolean; error?: string }> {
  const authCheck = await requireAdmin();
  if (!authCheck.success || !authCheck.user) {
    return { success: false, error: authCheck.error || 'Unauthorized' };
  }

  if (!input.id || !input.displayName || !input.shortName || !input.fileName) {
    return { success: false, error: 'Missing required fields: id, displayName, shortName, fileName' };
  }

  // Sanitize document ID: lowercase, alphanumeric + hyphens only
  const sanitizedId = input.id.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');

  try {
    const supabase = createAdminClient();

    const { error } = await supabase.rpc('upsert_document', {
      p_id: sanitizedId,
      p_display_name: input.displayName,
      p_short_name: input.shortName,
      p_file_name: input.fileName,
      p_source_url: input.sourceUrl || '',
      p_authority: input.authority || 'Dubai Municipality',
      p_description: input.description || '',
      p_badge_color: input.badgeColor || 'bg-gray-500/20 text-gray-400 border-gray-500/30',
      p_keywords: input.keywords || [],
      p_categories: input.categories || [],
    });

    if (error) {
      // Fallback: direct upsert
      const { error: directError } = await supabase
        .from('document_registry')
        .upsert({
          id: sanitizedId,
          display_name: input.displayName,
          short_name: input.shortName,
          file_name: input.fileName,
          source_url: input.sourceUrl || '',
          authority: input.authority || 'Dubai Municipality',
          description: input.description || '',
          badge_color: input.badgeColor || 'bg-gray-500/20 text-gray-400 border-gray-500/30',
          keywords: input.keywords || [],
          categories: input.categories || [],
          is_active: true,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'id' });

      if (directError) {
        return { success: false, error: directError.message };
      }
    }

    const metadata = await getRequestMetadata();
    await logAuditEvent({
      userId: authCheck.user.id,
      action: 'pdf_ingested', // reuse existing action type
      metadata: { stage: 'document_registered', documentId: sanitizedId, displayName: input.displayName },
      ...metadata,
    });

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to save document',
    };
  }
}

// -----------------------------------------------------------------------------
// Delete Document (soft delete + optionally clear chunks)
// -----------------------------------------------------------------------------

export async function deleteDocument(
  documentId: string,
  clearChunks: boolean = false
): Promise<{ success: boolean; error?: string }> {
  const authCheck = await requireAdmin();
  if (!authCheck.success || !authCheck.user) {
    return { success: false, error: authCheck.error || 'Unauthorized' };
  }

  if (!documentId) {
    return { success: false, error: 'Missing documentId' };
  }

  try {
    const supabase = createAdminClient();

    // Soft delete
    const { error } = await supabase.rpc('delete_document', { p_id: documentId });

    if (error) {
      // Fallback: direct update
      const { error: directError } = await supabase
        .from('document_registry')
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq('id', documentId);

      if (directError) {
        return { success: false, error: directError.message };
      }
    }

    // Optionally clear chunks
    if (clearChunks) {
      const { error: clearError } = await supabase.rpc('clear_document_chunks', {
        target_document: documentId,
      });

      if (clearError) {
        // Fallback
        await supabase
          .from('dubai_code_chunks')
          .delete()
          .eq('document_name', documentId);
      }

      // Also clear document tree
      await supabase
        .from('document_trees')
        .delete()
        .eq('document_name', documentId);

      clearDocumentTreeCache(documentId);
    }

    const metadata = await getRequestMetadata();
    await logAuditEvent({
      userId: authCheck.user.id,
      action: 'chunks_cleared',
      metadata: { documentId, action: 'document_deleted', chunksCleared: clearChunks },
      ...metadata,
    });

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to delete document',
    };
  }
}

// -----------------------------------------------------------------------------
// Restore (re-activate) a soft-deleted document
// -----------------------------------------------------------------------------

export async function restoreDocument(
  documentId: string
): Promise<{ success: boolean; error?: string }> {
  const authCheck = await requireAdmin();
  if (!authCheck.success || !authCheck.user) {
    return { success: false, error: authCheck.error || 'Unauthorized' };
  }

  try {
    const supabase = createAdminClient();

    const { error } = await supabase
      .from('document_registry')
      .update({ is_active: true, updated_at: new Date().toISOString() })
      .eq('id', documentId);

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to restore document',
    };
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function mapDbRow(row: Record<string, unknown>): DocumentRecord {
  return {
    id: row.id as string,
    displayName: (row.display_name as string) || '',
    shortName: (row.short_name as string) || '',
    fileName: (row.file_name as string) || '',
    sourceUrl: (row.source_url as string) || '',
    authority: (row.authority as string) || '',
    description: (row.description as string) || '',
    badgeColor: (row.badge_color as string) || '',
    keywords: (row.keywords as string[]) || [],
    categories: (row.categories as string[]) || [],
    isActive: row.is_active !== false,
    createdAt: (row.created_at as string) || '',
    updatedAt: (row.updated_at as string) || '',
  };
}
