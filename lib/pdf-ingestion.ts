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
  // Parent-child chunking
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
 * Shared text-splitting + page-attribution worker (F12 / Simplify #12).
 * Both `splitWithPageTracking` (child chunks) and `createParentChunks`
 * (parent chunks) need the same algorithm:
 *   1. Concatenate non-empty pages, recording char-offset → pageNumber boundaries.
 *   2. Run the RecursiveCharacterTextSplitter at the requested chunkSize.
 *   3. For each chunk, locate it in the fullText and map start/end offsets
 *      back to start/end page numbers using the precomputed boundaries.
 *
 * Returns an array of { content, startPage, endPage } with raw page ranges
 * — callers attach their own section / contentType metadata.
 */
async function chunkPagesAtSize(
  pages: PDFPageContent[],
  chunkSize: number,
  chunkOverlap: number,
): Promise<Array<{ content: string; startPage: number; endPage: number }>> {
  const textSplitter = new RecursiveCharacterTextSplitter({
    chunkSize,
    chunkOverlap,
    separators: ['\n\n\n', '\n\n', '\n', '. ', '; ', ', ', ' ', ''],
  });

  const pageBoundaries: Array<{ start: number; end: number; pageNumber: number }> = [];
  let fullText = '';

  for (const page of pages) {
    if (page.text.trim().length === 0) continue;
    const start = fullText.length;
    fullText += page.text + '\n\n';
    pageBoundaries.push({ start, end: fullText.length, pageNumber: page.pageNumber });
  }

  const rawChunks = await textSplitter.splitText(fullText);
  const out: Array<{ content: string; startPage: number; endPage: number }> = [];
  let currentPosition = 0;

  for (const chunkContent of rawChunks) {
    if (chunkContent.trim().length < PDF_INGESTION_CONFIG.MIN_CHUNK_LENGTH) continue;

    const chunkStart = fullText.indexOf(chunkContent, currentPosition);
    if (chunkStart === -1) continue;
    const chunkEnd = chunkStart + chunkContent.length;

    let startPage = pageBoundaries[0]?.pageNumber ?? 1;
    for (const pb of pageBoundaries) {
      if (chunkStart < pb.end) { startPage = pb.pageNumber; break; }
    }

    let endPage = startPage;
    for (const pb of pageBoundaries) {
      if (pb.start < chunkEnd) endPage = pb.pageNumber;
      if (pb.end >= chunkEnd) break;
    }

    out.push({ content: chunkContent.trim(), startPage, endPage });
    currentPosition = chunkStart + 1;
  }

  return out;
}

/**
 * Split text while tracking which pages each chunk spans
 * This ensures accurate page range attribution
 */
export async function splitWithPageTracking(
  pages: PDFPageContent[],
  parser: PDFParser
): Promise<ChunkWithPageRange[]> {
  const { CHILD_CHUNK_SIZE, CHUNK_OVERLAP } = PDF_INGESTION_CONFIG;
  const sized = await chunkPagesAtSize(pages, CHILD_CHUNK_SIZE, CHUNK_OVERLAP);

  return sized.map(({ content, startPage, endPage }) => {
    const sectionInfo = parser.findSectionForPage(startPage);
    const contentType = parser.detectContentType(content);
    const isTable = contentType === 'table';
    return {
      content,
      startPage,
      endPage,
      section: sectionInfo.section,
      sectionTitle: sectionInfo.sectionTitle,
      sectionPath: sectionInfo.sectionPath,
      isTable,
      contentType,
    };
  });
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
  /** PDF file path relative to project root (e.g., 'public/document.pdf') — fallback for local dev */
  pdfPath?: string;
  /** PDF file buffer downloaded from Supabase Storage */
  pdfBuffer?: Buffer | Uint8Array;
  /** Optional callback for progress updates (for streaming) */
  onProgress?: ProgressCallback;
}

/**
 * Main PDF ingestion pipeline
 * @param options - Ingestion options including documentId and pdfPath
 */
// ----------------------------------------------------------------------------
// Pipeline stages (F13 / Simplify #13)
// ----------------------------------------------------------------------------
// runIngestionPipeline grew to ~250 lines of mixed I/O + progress reporting.
// Decomposing it into stage functions makes the orchestrator readable as a
// single page of code and keeps each stage independently testable.
// ----------------------------------------------------------------------------

type Supa = ReturnType<typeof createAdminClient>;

async function loadPdfStage(
  options: IngestionOptions,
  sendProgress: ProgressCallback,
): Promise<PDFParser> {
  const { documentId, pdfBuffer, pdfPath: relativePdfPath } = options;
  await sendProgress({
    stage: 'parsing', progress: 5, total: 100,
    message: `Loading PDF (${documentId})...`,
  });
  if (pdfBuffer) return createPDFParser(pdfBuffer);

  const pdfPath = path.join(process.cwd(), relativePdfPath!);
  if (!fs.existsSync(pdfPath)) {
    throw new Error(`PDF file not found at ${pdfPath}`);
  }
  return createPDFParser(pdfPath);
}

async function persistKeywordsStage(
  supabase: Supa,
  documentId: string,
  pages: PDFPageContent[],
  sendProgress: ProgressCallback,
): Promise<void> {
  await sendProgress({
    stage: 'keywords', progress: 12, total: 100,
    message: 'Extracting keywords from document text...',
  });

  const { keywords, categories } = extractKeywords(pages);
  if (keywords.length === 0) return;

  const { data: docRecord } = await supabase
    .from('document_registry')
    .select('keywords_auto_generated')
    .eq('id', documentId)
    .single();

  if (docRecord?.keywords_auto_generated === false) return;

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

async function planChunksStage(
  supabase: Supa,
  documentId: string,
  chunksWithPages: ChunkWithPageRange[],
  sendProgress: ProgressCallback,
): Promise<{ chunksToProcess: ChunkWithPageRange[]; alreadyIngested: number }> {
  const { data: existingChunks } = await supabase
    .from('dubai_code_chunks')
    .select('content')
    .eq('document_name', documentId);

  const existingContents = new Set((existingChunks || []).map((c) => c.content));
  const newContents = new Set(chunksWithPages.map((c) => c.content));
  const staleChunks = (existingChunks || []).filter((c) => !newContents.has(c.content));

  if (staleChunks.length > 0) {
    await sendProgress({
      stage: 'cleaning', progress: 16, total: 100,
      message: `PDF changed: clearing ${existingContents.size} old chunks before re-ingestion...`,
    });
    await supabase.from('dubai_code_chunks').delete().eq('document_name', documentId);
    existingContents.clear();
  }

  const chunksToProcess = chunksWithPages.filter((chunk) => !existingContents.has(chunk.content));
  return { chunksToProcess, alreadyIngested: existingContents.size };
}

async function embedAndInsertBatchesStage(
  supabase: Supa,
  documentId: string,
  chunksToProcess: ChunkWithPageRange[],
  parentIdMap: Array<{ id: number; startPage: number; endPage: number }>,
  totalChunks: number,
  startCount: number,
  sendProgress: ProgressCallback,
): Promise<{ ok: true; processed: number } | { ok: false; processed: number; error: string }> {
  const { BATCH_SIZE, BATCH_DELAY_MS, EMBED_DELAY_MS } = PDF_INGESTION_CONFIG;

  let processedCount = startCount;
  const totalBatches = Math.ceil(chunksToProcess.length / BATCH_SIZE);

  for (let i = 0; i < chunksToProcess.length; i += BATCH_SIZE) {
    const batch = chunksToProcess.slice(i, i + BATCH_SIZE);
    const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
    const progressPercent = 20 + Math.round((batchNumber / totalBatches) * 80);

    await sendProgress({
      stage: 'embedding', progress: progressPercent, total: 100,
      message: `Batch ${batchNumber}/${totalBatches}: Generating embeddings (${processedCount}/${totalChunks})...`,
      chunksProcessed: processedCount,
    });

    const embeddings: number[][] = [];
    for (let j = 0; j < batch.length; j++) {
      try {
        embeddings.push(await generateEmbedding(batch[j].content));
        if (j < batch.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, EMBED_DELAY_MS));
        }
      } catch (error) {
        if (error instanceof DailyQuotaExhaustedError) {
          const errorMsg = `${error.message} (${processedCount}/${totalChunks} chunks saved — will resume on next attempt)`;
          await sendProgress({
            stage: 'error', progress: progressPercent, total: 100,
            message: errorMsg, done: true, error: errorMsg, chunksProcessed: processedCount,
          });
          return { ok: false, processed: processedCount, error: errorMsg };
        }
        throw error;
      }
    }

    const records = batch.map((chunk, idx) => ({
      content: chunk.content,
      metadata: { ...buildChunkMetadata(chunk), documentName: documentId },
      embedding: embeddings[idx],
      document_name: documentId,
      parent_id: findParentForChild(chunk, parentIdMap),
    }));

    const { error } = await supabase.from('dubai_code_chunks').insert(records);
    if (error) {
      const errorMsg = `Failed at batch ${batchNumber}: ${error.message}`;
      await sendProgress({
        stage: 'error', progress: progressPercent, total: 100,
        message: errorMsg, done: true, error: error.message, chunksProcessed: processedCount,
      });
      return { ok: false, processed: processedCount, error: errorMsg };
    }

    processedCount += batch.length;

    if (i + BATCH_SIZE < chunksToProcess.length) {
      await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }

  return { ok: true, processed: processedCount };
}

export async function runIngestionPipeline(
  options: IngestionOptions
): Promise<IngestionResult> {
  const { documentId, pdfPath: relativePdfPath, pdfBuffer, onProgress } = options;
  let parser: PDFParser | null = null;

  const sendProgress: ProgressCallback = async (progress) => {
    if (onProgress) await onProgress(progress);
  };

  try {
    if (!pdfBuffer && !relativePdfPath) {
      const error = 'Either pdfBuffer or pdfPath must be provided';
      await sendProgress({ stage: 'error', progress: 0, total: 100, message: error, done: true, error });
      return { success: false, chunksProcessed: 0, error };
    }

    // Stage 1: load PDF (may throw on missing path)
    try {
      parser = await loadPdfStage(options, sendProgress);
    } catch (loadErr) {
      const error = loadErr instanceof Error ? loadErr.message : 'PDF load failed';
      await sendProgress({ stage: 'error', progress: 0, total: 100, message: 'PDF file not found', done: true, error });
      return { success: false, chunksProcessed: 0, error };
    }

    // Stage 2: TOC + document tree
    await sendProgress({ stage: 'toc', progress: 8, total: 100, message: 'Extracting Table of Contents...' });
    const structure = await parser.extractTOC();

    const supabase = createAdminClient();

    await sendProgress({ stage: 'tree', progress: 9, total: 100, message: 'Saving document tree for structure-aware search...' });
    const treeNodes = convertTOCToTreeNodes(structure.flatTOC, parser.totalPages);
    await saveDocumentTree(supabase, documentId, parser.totalPages, treeNodes);

    // Stage 3: extract text
    await sendProgress({ stage: 'extracting', progress: 10, total: 100, message: `Extracting text from ${parser.totalPages} pages...` });
    const pages = await parser.getAllPagesText();

    // Stage 3.5: persist keywords
    await persistKeywordsStage(supabase, documentId, pages, sendProgress);

    // Stage 4: split into chunks
    await sendProgress({ stage: 'splitting', progress: 15, total: 100, message: 'Splitting into chunks with page tracking...' });
    const chunksWithPages = await splitWithPageTracking(pages, parser);
    const totalChunks = chunksWithPages.length;

    // Stage 5: plan chunks (resume vs full-vs-stale)
    const { chunksToProcess, alreadyIngested } = await planChunksStage(supabase, documentId, chunksWithPages, sendProgress);

    if (alreadyIngested > 0 && chunksToProcess.length > 0) {
      await sendProgress({
        stage: 'embedding', progress: 20, total: 100,
        message: `Resuming: ${alreadyIngested} chunks already ingested, ${chunksToProcess.length} remaining...`,
      });
    } else if (chunksToProcess.length === 0) {
      await sendProgress({
        stage: 'complete', progress: 100, total: 100,
        message: `All ${totalChunks} chunks already ingested — nothing to do!`,
        done: true, chunksProcessed: totalChunks,
      });
      return { success: true, chunksProcessed: totalChunks, pagesProcessed: parser.totalPages, tocExtracted: structure.flatTOC.length > 0 };
    }

    // Stage 5.5: parent chunks (skip insertion-roundtrip when no new chunks)
    await sendProgress({ stage: 'parents', progress: 17, total: 100, message: 'Creating parent chunks for richer LLM context...' });
    const parentChunks = await createParentChunks(pages, parser);
    const parentIdMap = await insertParentChunks(supabase, parentChunks, documentId);

    // Stage 6: embed + insert in batches
    await sendProgress({
      stage: 'embedding', progress: 20, total: 100,
      message: `Processing ${chunksToProcess.length} child chunks (TOC: ${structure.flatTOC.length} entries)...`,
    });
    const result = await embedAndInsertBatchesStage(
      supabase, documentId, chunksToProcess, parentIdMap, totalChunks, alreadyIngested, sendProgress,
    );
    if (!result.ok) {
      return { success: false, chunksProcessed: result.processed, error: result.error };
    }

    await sendProgress({
      stage: 'complete', progress: 100, total: 100,
      message: `Successfully ingested ${result.processed} chunks with page ranges!`,
      done: true, chunksProcessed: result.processed,
    });

    return {
      success: true,
      chunksProcessed: result.processed,
      pagesProcessed: parser.totalPages,
      tocExtracted: structure.flatTOC.length > 0,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    await sendProgress({ stage: 'error', progress: 0, total: 100, message: 'Ingestion failed', done: true, error: errorMessage });
    return { success: false, chunksProcessed: 0, error: `PDF ingestion failed: ${errorMessage}` };
  } finally {
    if (parser) {
      await parser.close();
    }
  }
}

// -----------------------------------------------------------------------------
// Parent-Child Chunking Support
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
  const { PARENT_CHUNK_SIZE } = PDF_INGESTION_CONFIG;
  const sized = await chunkPagesAtSize(pages, PARENT_CHUNK_SIZE, 200);

  return sized.map(({ content, startPage, endPage }) => {
    const sectionInfo = parser.findSectionForPage(startPage);
    return {
      content,
      startPage,
      endPage,
      section: sectionInfo.section,
      sectionTitle: sectionInfo.sectionTitle,
    };
  });
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
 * Save document tree to database. The save_document_tree RPC is seeded by
 * the migration; we trust it to exist and surface errors instead of silently
 * falling back to a direct upsert (F15).
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
      console.error('Error saving document tree:', error);
    } else {
      console.log(`✅ Saved document tree with ${treeNodes.length} nodes`);
    }
  } catch (err) {
    console.error('Failed to save document tree:', err);
  }
}

