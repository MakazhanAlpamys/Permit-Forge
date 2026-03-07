// ============================================================================
// Centralized PDF Ingestion Logic (Shared between Server Action and API Route)
// ============================================================================

import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';
import { createAdminClient } from '@/lib/supabase-server';
import { generateEmbedding, DailyQuotaExhaustedError } from '@/lib/gemini';
import { createPDFParser, PDFParser } from '@/lib/pdf-parser';
import { extractKeywords } from '@/lib/keyword-extractor';
import { invalidateRegistryCache } from '@/lib/document-registry';
import { invalidateProfileCache } from '@/lib/document-selector';
import type {
  ChunkMetadata,
  PDFPageContent,
  ChunkWithPageRange,
  TreeNode,
  TOCEntry,
  IngestionResult
} from '@/types';
import path from 'path';
import fs from 'fs';

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

export const PDF_INGESTION_CONFIG = {
  // v2: Parent-child chunking
  CHILD_CHUNK_SIZE: 400,   // Child chunks for embedding + search (higher precision)
  PARENT_CHUNK_SIZE: 2000, // Parent chunks for LLM context (richer information)
  CHUNK_OVERLAP: 100,      // Overlap between child chunks
  BATCH_SIZE: 3,           // Chunks per database batch
  MIN_CHUNK_LENGTH: 50,    // Minimum chunk length to include
  BATCH_DELAY_MS: 2000,    // Delay between batches
  EMBED_DELAY_MS: 350,     // Delay between individual embedding requests
} as const;

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface PageTextSegment {
  text: string;
  pageNumber: number;
}

export interface IngestionProgress {
  stage: string;
  progress: number;
  total: number;
  message: string;
  done?: boolean;
  error?: string;
  chunksProcessed?: number;
}

export type ProgressCallback = (progress: IngestionProgress) => Promise<void>;

// -----------------------------------------------------------------------------
// Text Splitter with Page Tracking
// -----------------------------------------------------------------------------

/**
 * Split text while tracking which pages each chunk spans
 * This ensures accurate page range attribution
 */
export async function splitWithPageTracking(
  pages: PDFPageContent[],
  parser: PDFParser
): Promise<ChunkWithPageRange[]> {
  const { CHILD_CHUNK_SIZE, CHUNK_OVERLAP, MIN_CHUNK_LENGTH } = PDF_INGESTION_CONFIG;

  const textSplitter = new RecursiveCharacterTextSplitter({
    chunkSize: CHILD_CHUNK_SIZE,
    chunkOverlap: CHUNK_OVERLAP,
    separators: [
      '\n\n\n',   // Major section breaks
      '\n\n',      // Paragraph breaks
      '\n',        // Line breaks
      '. ',        // Sentence breaks
      '; ',        // Clause breaks
      ', ',        // List items
      ' ',         // Words
      '',          // Characters
    ],
  });

  // Build a map of character positions to page numbers
  const segments: PageTextSegment[] = [];
  let fullText = '';

  for (const page of pages) {
    if (page.text.trim().length === 0) continue;

    fullText += page.text + '\n\n';
    segments.push({
      text: page.text,
      pageNumber: page.pageNumber,
    });
  }

  // Split the full text
  const rawChunks = await textSplitter.splitText(fullText);

  // For each chunk, determine which pages it spans
  const chunksWithPages: ChunkWithPageRange[] = [];
  let currentPosition = 0;

  for (const chunkContent of rawChunks) {
    if (chunkContent.trim().length < MIN_CHUNK_LENGTH) continue;

    const chunkStart = fullText.indexOf(chunkContent, currentPosition);
    const chunkEnd = chunkStart + chunkContent.length;

    let position = 0;
    let startPage = 1;
    let endPage = 1;
    let foundStart = false;

    for (const segment of segments) {
      const segmentEnd = position + segment.text.length + 2; // +2 for '\n\n'

      if (!foundStart && chunkStart < segmentEnd) {
        startPage = segment.pageNumber;
        foundStart = true;
      }

      if (chunkEnd <= segmentEnd) {
        endPage = segment.pageNumber;
        break;
      }

      if (foundStart) {
        endPage = segment.pageNumber;
      }

      position = segmentEnd;
    }

    const sectionInfo = parser.findSectionForPage(startPage);
    const contentType = parser.detectContentType(chunkContent);
    const isTable = contentType === 'table';

    chunksWithPages.push({
      content: chunkContent.trim(),
      startPage,
      endPage,
      section: sectionInfo.section,
      sectionTitle: sectionInfo.sectionTitle,
      sectionPath: sectionInfo.sectionPath,
      isTable,
      contentType,
    });

    currentPosition = chunkStart + 1;
  }

  return chunksWithPages;
}

// -----------------------------------------------------------------------------
// Build Chunk Metadata
// -----------------------------------------------------------------------------

export function buildChunkMetadata(chunk: ChunkWithPageRange): ChunkMetadata {
  const chapter = chunk.sectionPath?.find(p => /chapter/i.test(p));

  let tableId: string | undefined;
  let tableName: string | undefined;

  if (chunk.isTable) {
    const tableMatch = chunk.content.match(/Table\s+(\d+[-.]?\d*)[:\s]*([^\n]*)/i);
    if (tableMatch) {
      tableId = `Table ${tableMatch[1]}`;
      tableName = tableMatch[2]?.trim() || undefined;
    }
  }

  return {
    page: chunk.startPage,
    startPage: chunk.startPage,
    endPage: chunk.endPage,
    chapter,
    section: chunk.section,
    sectionTitle: chunk.sectionTitle,
    sectionPath: chunk.sectionPath,
    tableId,
    tableName,
    isTable: chunk.isTable,
    contentType: chunk.contentType,
  };
}

// -----------------------------------------------------------------------------
// Main Ingestion Pipeline
// -----------------------------------------------------------------------------

export interface IngestionOptions {
  /** Document ID from the document registry */
  documentId: string;
  /** PDF file path relative to project root (e.g., 'public/document.pdf') */
  pdfPath: string;
  /** Optional callback for progress updates (for streaming) */
  onProgress?: ProgressCallback;
}

/**
 * Main PDF ingestion pipeline
 * @param options - Ingestion options including documentId and pdfPath
 */
export async function runIngestionPipeline(
  options: IngestionOptions
): Promise<IngestionResult> {
  const { documentId, pdfPath: relativePdfPath, onProgress } = options;
  const { BATCH_SIZE, BATCH_DELAY_MS } = PDF_INGESTION_CONFIG;
  let parser: PDFParser | null = null;

  const sendProgress = async (progress: IngestionProgress) => {
    if (onProgress) {
      await onProgress(progress);
    }
  };

  try {
    const pdfPath = path.join(process.cwd(), relativePdfPath);

    if (!fs.existsSync(pdfPath)) {
      const error = `PDF file not found at ${pdfPath}`;
      await sendProgress({
        stage: 'error',
        progress: 0,
        total: 100,
        message: 'PDF file not found',
        done: true,
        error,
      });
      return { success: false, chunksProcessed: 0, error };
    }

    // Stage 1: Loading PDF
    await sendProgress({
      stage: 'parsing',
      progress: 5,
      total: 100,
      message: `Loading PDF (${documentId})...`,
    });

    parser = await createPDFParser(pdfPath);

    // Stage 2: Extract TOC
    await sendProgress({
      stage: 'toc',
      progress: 8,
      total: 100,
      message: 'Extracting Table of Contents...',
    });

    const structure = await parser.extractTOC();

    const supabase = createAdminClient();

    // Stage 2.5: Save document tree for Tree Reasoning
    await sendProgress({
      stage: 'tree',
      progress: 9,
      total: 100,
      message: 'Saving document tree for structure-aware search...',
    });

    const treeNodes = convertTOCToTreeNodes(structure.flatTOC, parser.totalPages);
    await saveDocumentTree(supabase, documentId, parser.totalPages, treeNodes);

    // Stage 3: Extract text
    await sendProgress({
      stage: 'extracting',
      progress: 10,
      total: 100,
      message: `Extracting text from ${parser.totalPages} pages...`,
    });

    const pages = await parser.getAllPagesText();

    // Stage 3.5: Auto-extract keywords from PDF text (0 API calls)
    await sendProgress({
      stage: 'keywords',
      progress: 12,
      total: 100,
      message: 'Extracting keywords from document text...',
    });

    const { keywords, categories } = extractKeywords(pages);
    if (keywords.length > 0) {
      // Update keywords in DB only if they were auto-generated (don't overwrite manual edits)
      const { data: docRecord } = await supabase
        .from('document_registry')
        .select('keywords_auto_generated')
        .eq('id', documentId)
        .single();

      if (docRecord?.keywords_auto_generated !== false) {
        await supabase
          .from('document_registry')
          .update({
            keywords,
            categories,
            keywords_auto_generated: true,
            updated_at: new Date().toISOString(),
          })
          .eq('id', documentId);

        invalidateRegistryCache();
        invalidateProfileCache();
      }
    }

    // Stage 4: Split into chunks
    await sendProgress({
      stage: 'splitting',
      progress: 15,
      total: 100,
      message: 'Splitting into chunks with page tracking...',
    });

    const chunksWithPages = await splitWithPageTracking(pages, parser);
    const totalChunks = chunksWithPages.length;

    // Stage 5: Check for existing chunks (resume support)
    // SECURITY FIX: Instead of trusting the count, check which chunks actually exist
    // based on content hash to handle partial batch failures safely
    const { data: existingChunks } = await supabase
      .from('dubai_code_chunks')
      .select('content')
      .eq('document_name', documentId);

    const existingContents = new Set((existingChunks || []).map(c => c.content));
    const chunksToProcess = chunksWithPages.filter(
      chunk => !existingContents.has(chunk.content)
    );

    if (existingContents.size > 0 && chunksToProcess.length > 0) {
      await sendProgress({
        stage: 'embedding',
        progress: 20,
        total: 100,
        message: `Resuming: ${existingContents.size} chunks already ingested, ${chunksToProcess.length} remaining...`,
      });
    } else if (chunksToProcess.length === 0) {
      await sendProgress({
        stage: 'complete',
        progress: 100,
        total: 100,
        message: `All ${totalChunks} chunks already ingested — nothing to do!`,
        done: true,
        chunksProcessed: totalChunks,
      });
      return {
        success: true,
        chunksProcessed: totalChunks,
        pagesProcessed: parser.totalPages,
        tocExtracted: structure.flatTOC.length > 0,
      };
    }

    // Stage 5.5: Create parent chunks (v2 — larger chunks for LLM context)
    await sendProgress({
      stage: 'parents',
      progress: 17,
      total: 100,
      message: 'Creating parent chunks for richer LLM context...',
    });

    const parentChunks = await createParentChunks(pages, parser);
    const parentIdMap = await insertParentChunks(supabase, parentChunks, documentId);

    // Stage 6: Generate embeddings and store child chunks
    await sendProgress({
      stage: 'embedding',
      progress: 20,
      total: 100,
      message: `Processing ${chunksToProcess.length} child chunks (TOC: ${structure.flatTOC.length} entries)...`,
    });

    let processedCount = existingContents.size;
    const totalBatches = Math.ceil(chunksToProcess.length / BATCH_SIZE);
    const { EMBED_DELAY_MS } = PDF_INGESTION_CONFIG;

    for (let i = 0; i < chunksToProcess.length; i += BATCH_SIZE) {
      const batch = chunksToProcess.slice(i, i + BATCH_SIZE);
      const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
      const progressPercent = 20 + Math.round((batchNumber / totalBatches) * 80);

      await sendProgress({
        stage: 'embedding',
        progress: progressPercent,
        total: 100,
        message: `Batch ${batchNumber}/${totalBatches}: Generating embeddings (${processedCount}/${totalChunks})...`,
        chunksProcessed: processedCount,
      });

      // Generate embeddings SEQUENTIALLY
      const embeddings: number[][] = [];
      for (let j = 0; j < batch.length; j++) {
        try {
          const embedding = await generateEmbedding(batch[j].content);
          embeddings.push(embedding);
          if (j < batch.length - 1) {
            await new Promise(resolve => setTimeout(resolve, EMBED_DELAY_MS));
          }
        } catch (error) {
          if (error instanceof DailyQuotaExhaustedError) {
            const errorMsg = `${error.message} (${processedCount}/${totalChunks} chunks saved — will resume on next attempt)`;
            await sendProgress({
              stage: 'error',
              progress: progressPercent,
              total: 100,
              message: errorMsg,
              done: true,
              error: errorMsg,
              chunksProcessed: processedCount,
            });
            return { success: false, chunksProcessed: processedCount, error: errorMsg };
          }
          throw error;
        }
      }

      // Find parent_id for each child chunk by page overlap
      const records = batch.map((chunk, idx) => ({
        content: chunk.content,
        metadata: { ...buildChunkMetadata(chunk), documentName: documentId },
        embedding: embeddings[idx],
        document_name: documentId,
        parent_id: findParentForChild(chunk, parentIdMap),
      }));

      const { error } = await supabase
        .from('dubai_code_chunks')
        .insert(records);

      if (error) {
        const errorMsg = `Failed at batch ${batchNumber}: ${error.message}`;
        await sendProgress({
          stage: 'error',
          progress: progressPercent,
          total: 100,
          message: errorMsg,
          done: true,
          error: error.message,
          chunksProcessed: processedCount,
        });
        return { success: false, chunksProcessed: processedCount, error: errorMsg };
      }

      processedCount += batch.length;

      if (i + BATCH_SIZE < chunksToProcess.length) {
        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }

    // Done!
    await sendProgress({
      stage: 'complete',
      progress: 100,
      total: 100,
      message: `Successfully ingested ${processedCount} chunks with page ranges!`,
      done: true,
      chunksProcessed: processedCount,
    });

    return {
      success: true,
      chunksProcessed: processedCount,
      pagesProcessed: parser.totalPages,
      tocExtracted: structure.flatTOC.length > 0,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    await sendProgress({
      stage: 'error',
      progress: 0,
      total: 100,
      message: 'Ingestion failed',
      done: true,
      error: errorMessage,
    });
    return {
      success: false,
      chunksProcessed: 0,
      error: `PDF ingestion failed: ${errorMessage}`,
    };
  } finally {
    if (parser) {
      await parser.close();
    }
  }
}

// -----------------------------------------------------------------------------
// Parent-Child Chunking Support (v2)
// -----------------------------------------------------------------------------

interface ParentChunkData {
  content: string;
  startPage: number;
  endPage: number;
  section?: string;
  sectionTitle?: string;
}

/**
 * Create larger parent chunks (2000 chars) for richer LLM context.
 * Parent chunks don't get embeddings — only child chunks do.
 */
async function createParentChunks(
  pages: PDFPageContent[],
  parser: PDFParser
): Promise<ParentChunkData[]> {
  const { PARENT_CHUNK_SIZE, MIN_CHUNK_LENGTH } = PDF_INGESTION_CONFIG;

  const textSplitter = new RecursiveCharacterTextSplitter({
    chunkSize: PARENT_CHUNK_SIZE,
    chunkOverlap: 200,
    separators: ['\n\n\n', '\n\n', '\n', '. ', '; ', ', ', ' ', ''],
  });

  let fullText = '';
  const segments: Array<{ text: string; pageNumber: number }> = [];

  for (const page of pages) {
    if (page.text.trim().length === 0) continue;
    fullText += page.text + '\n\n';
    segments.push({ text: page.text, pageNumber: page.pageNumber });
  }

  const rawChunks = await textSplitter.splitText(fullText);
  const parentChunks: ParentChunkData[] = [];
  let currentPosition = 0;

  for (const chunkContent of rawChunks) {
    if (chunkContent.trim().length < MIN_CHUNK_LENGTH) continue;

    const chunkStart = fullText.indexOf(chunkContent, currentPosition);
    const chunkEnd = chunkStart + chunkContent.length;

    let position = 0;
    let startPage = 1;
    let endPage = 1;
    let foundStart = false;

    for (const segment of segments) {
      const segmentEnd = position + segment.text.length + 2;

      if (!foundStart && chunkStart < segmentEnd) {
        startPage = segment.pageNumber;
        foundStart = true;
      }

      if (chunkEnd <= segmentEnd) {
        endPage = segment.pageNumber;
        break;
      }

      if (foundStart) {
        endPage = segment.pageNumber;
      }

      position = segmentEnd;
    }

    const sectionInfo = parser.findSectionForPage(startPage);

    parentChunks.push({
      content: chunkContent.trim(),
      startPage,
      endPage,
      section: sectionInfo.section,
      sectionTitle: sectionInfo.sectionTitle,
    });

    currentPosition = chunkStart + 1;
  }

  return parentChunks;
}

/**
 * Insert parent chunks into the database and return a map for linking child chunks.
 */
async function insertParentChunks(
  supabase: ReturnType<typeof createAdminClient>,
  parentChunks: ParentChunkData[],
  documentId: string
): Promise<Array<{ id: number; startPage: number; endPage: number }>> {
  if (parentChunks.length === 0) return [];

  // Clear existing parent chunks for this document
  await supabase
    .from('parent_chunks')
    .delete()
    .eq('document_name', documentId);

  const records = parentChunks.map(chunk => ({
    content: chunk.content,
    metadata: {
      page: chunk.startPage,
      startPage: chunk.startPage,
      endPage: chunk.endPage,
      section: chunk.section,
      sectionTitle: chunk.sectionTitle,
      documentName: documentId,
    },
    document_name: documentId,
  }));

  const { data, error } = await supabase
    .from('parent_chunks')
    .insert(records)
    .select('id, metadata');

  if (error) {
    console.error('Failed to insert parent chunks:', error);
    return [];
  }

  return (data || []).map(row => ({
    id: row.id,
    startPage: (row.metadata as { startPage?: number })?.startPage || 0,
    endPage: (row.metadata as { endPage?: number })?.endPage || 0,
  }));
}

/**
 * Find the best parent chunk for a child chunk based on page overlap.
 */
function findParentForChild(
  child: ChunkWithPageRange,
  parents: Array<{ id: number; startPage: number; endPage: number }>
): number | null {
  if (parents.length === 0) return null;

  for (const parent of parents) {
    if (child.startPage >= parent.startPage && child.endPage <= parent.endPage) {
      return parent.id;
    }
  }

  // Partial overlap fallback
  for (const parent of parents) {
    if (child.startPage <= parent.endPage && child.endPage >= parent.startPage) {
      return parent.id;
    }
  }

  return null;
}

// -----------------------------------------------------------------------------
// Tree Reasoning Support Functions
// -----------------------------------------------------------------------------

/**
 * Convert TOC entries to TreeNode format for Tree Reasoning
 * Calculates page ranges for each section
 */
function convertTOCToTreeNodes(flatTOC: TOCEntry[], totalPages: number): TreeNode[] {
  if (flatTOC.length === 0) {
    return [];
  }

  const nodes: TreeNode[] = [];
  const sortedTOC = [...flatTOC].sort((a, b) => a.pageNumber - b.pageNumber);

  for (let i = 0; i < sortedTOC.length; i++) {
    const entry = sortedTOC[i];
    // nextEntry not needed - page calculation uses loop below

    // Calculate end page (next section's start - 1, or total pages)
    let endPage = totalPages;

    // Find next entry at same or higher level
    for (let j = i + 1; j < sortedTOC.length; j++) {
      if (sortedTOC[j].level <= entry.level) {
        endPage = sortedTOC[j].pageNumber - 1;
        break;
      }
    }

    // Don't let end page exceed total pages
    endPage = Math.min(endPage, totalPages);

    // Don't let end page be less than start page
    if (endPage < entry.pageNumber) {
      endPage = entry.pageNumber;
    }

    // Generate node ID (4-digit padded)
    const nodeId = String(i + 1).padStart(4, '0');

    // Build path from ancestors
    const path = buildPathForEntry(entry, sortedTOC.slice(0, i));

    nodes.push({
      id: nodeId,
      title: entry.title,
      section: entry.section,
      level: entry.level,
      startPage: entry.pageNumber,
      endPage: endPage,
      parentId: findParentId(entry, sortedTOC.slice(0, i), nodes),
      path: path,
    });
  }

  return nodes;
}

/**
 * Build path string for a TOC entry based on its ancestors
 */
function buildPathForEntry(entry: TOCEntry, previousEntries: TOCEntry[]): string {
  const pathParts: string[] = [];

  // Find ancestors by looking at entries with lower level numbers
  let currentLevel = entry.level;

  for (let i = previousEntries.length - 1; i >= 0; i--) {
    const prev = previousEntries[i];
    if (prev.level < currentLevel) {
      pathParts.unshift(prev.title);
      currentLevel = prev.level;
    }
    if (prev.level === 0) break;
  }

  pathParts.push(entry.title);
  return pathParts.join(' > ');
}

/**
 * Find parent node ID for a TOC entry
 */
function findParentId(
  entry: TOCEntry,
  previousEntries: TOCEntry[],
  existingNodes: TreeNode[]
): string | undefined {
  if (entry.level === 0) return undefined;

  // Find the most recent entry with a lower level
  for (let i = previousEntries.length - 1; i >= 0; i--) {
    if (previousEntries[i].level < entry.level) {
      // Return the corresponding node ID
      return existingNodes[i]?.id;
    }
  }

  return undefined;
}

/**
 * Save document tree to database
 */
async function saveDocumentTree(
  supabase: ReturnType<typeof createAdminClient>,
  documentName: string,
  totalPages: number,
  treeNodes: TreeNode[]
): Promise<void> {
  try {
    const { error } = await supabase.rpc('save_document_tree', {
      p_document_name: documentName,
      p_total_pages: totalPages,
      p_tree_data: treeNodes,
    });

    if (error) {
      // If RPC doesn't exist, try direct insert/upsert
      if (error.message.includes('does not exist')) {
        console.warn('save_document_tree RPC not found, using direct insert');
        await saveDocumentTreeDirect(supabase, documentName, totalPages, treeNodes);
      } else {
        console.error('Error saving document tree:', error);
      }
    } else {
      console.log(`✅ Saved document tree with ${treeNodes.length} nodes`);
    }
  } catch (err) {
    console.error('Failed to save document tree:', err);
  }
}

/**
 * Direct insert/upsert for document tree (fallback)
 */
async function saveDocumentTreeDirect(
  supabase: ReturnType<typeof createAdminClient>,
  documentName: string,
  totalPages: number,
  treeNodes: TreeNode[]
): Promise<void> {
  const { error } = await supabase
    .from('document_trees')
    .upsert({
      document_name: documentName,
      total_pages: totalPages,
      tree_data: treeNodes,
      updated_at: new Date().toISOString(),
    }, {
      onConflict: 'document_name',
    });

  if (error) {
    console.error('Direct save document tree error:', error);
  } else {
    console.log(`✅ Saved document tree directly with ${treeNodes.length} nodes`);
  }
}

// -----------------------------------------------------------------------------
// Export helper for loading document tree
// -----------------------------------------------------------------------------

/**
 * Load document tree from database
 */
export async function loadDocumentTree(
  documentName: string
): Promise<TreeNode[]> {
  const supabase = createAdminClient();

  try {
    // Try RPC first
    const { data, error } = await supabase.rpc('get_document_tree', {
      p_document_name: documentName,
    });

    if (!error && data) {
      return data as TreeNode[];
    }

    // Fallback to direct query
    const { data: treeData, error: queryError } = await supabase
      .from('document_trees')
      .select('tree_data')
      .eq('document_name', documentName)
      .single();

    if (queryError) {
      console.warn('Document tree not found:', queryError.message);
      return [];
    }

    return (treeData?.tree_data || []) as TreeNode[];
  } catch (err) {
    console.error('Error loading document tree:', err);
    return [];
  }
}
