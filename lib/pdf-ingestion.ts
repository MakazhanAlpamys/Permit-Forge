// ============================================================================
// Centralized PDF Ingestion Logic (Shared between Server Action and API Route)
// ============================================================================

import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';
import { createServerClient } from '@/lib/supabase';
import { generateEmbedding } from '@/lib/gemini';
import { createPDFParser, PDFParser } from '@/lib/pdf-parser';
import type { 
  ChunkMetadata,
  PDFPageContent,
  ChunkWithPageRange
} from '@/types';
import path from 'path';
import fs from 'fs';

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

export const PDF_INGESTION_CONFIG = {
  CHUNK_SIZE: 800,         // Characters per chunk
  CHUNK_OVERLAP: 150,      // Overlap between chunks
  BATCH_SIZE: 10,          // Chunks per database batch
  PDF_PATH: 'public/dubai-code.pdf',
  MIN_CHUNK_LENGTH: 50,    // Minimum chunk length to include
  BATCH_DELAY_MS: 300,     // Delay between batches for rate limiting
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
  const { CHUNK_SIZE, CHUNK_OVERLAP, MIN_CHUNK_LENGTH } = PDF_INGESTION_CONFIG;
  
  const textSplitter = new RecursiveCharacterTextSplitter({
    chunkSize: CHUNK_SIZE,
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

export interface IngestionResult {
  success: boolean;
  chunksProcessed: number;
  pagesProcessed?: number;
  tocExtracted?: boolean;
  error?: string;
}

/**
 * Main PDF ingestion pipeline
 * @param onProgress - Optional callback for progress updates (for streaming)
 */
export async function runIngestionPipeline(
  onProgress?: ProgressCallback
): Promise<IngestionResult> {
  const { PDF_PATH, BATCH_SIZE, BATCH_DELAY_MS } = PDF_INGESTION_CONFIG;
  let parser: PDFParser | null = null;
  
  const sendProgress = async (progress: IngestionProgress) => {
    if (onProgress) {
      await onProgress(progress);
    }
  };

  try {
    const pdfPath = path.join(process.cwd(), PDF_PATH);
    
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
      message: 'Loading PDF with PDF.js...',
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

    // Stage 3: Extract text
    await sendProgress({
      stage: 'extracting',
      progress: 10,
      total: 100,
      message: `Extracting text from ${parser.totalPages} pages...`,
    });

    const pages = await parser.getAllPagesText();

    // Stage 4: Split into chunks
    await sendProgress({
      stage: 'splitting',
      progress: 15,
      total: 100,
      message: 'Splitting into chunks with page tracking...',
    });

    const chunksWithPages = await splitWithPageTracking(pages, parser);
    const totalChunks = chunksWithPages.length;

    // Stage 5: Generate embeddings and store
    await sendProgress({
      stage: 'embedding',
      progress: 20,
      total: 100,
      message: `Processing ${totalChunks} chunks (TOC: ${structure.flatTOC.length} entries)...`,
    });

    const supabase = createServerClient();
    let processedCount = 0;
    const totalBatches = Math.ceil(totalChunks / BATCH_SIZE);

    for (let i = 0; i < chunksWithPages.length; i += BATCH_SIZE) {
      const batch = chunksWithPages.slice(i, i + BATCH_SIZE);
      const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
      const progressPercent = 20 + Math.round((batchNumber / totalBatches) * 80);

      await sendProgress({
        stage: 'embedding',
        progress: progressPercent,
        total: 100,
        message: `Batch ${batchNumber}/${totalBatches}: Generating embeddings...`,
        chunksProcessed: processedCount,
      });

      // Generate embeddings for batch
      const embeddingsPromises = batch.map(chunk => generateEmbedding(chunk.content));
      const embeddings = await Promise.all(embeddingsPromises);

      // Prepare records
      const records = batch.map((chunk, idx) => ({
        content: chunk.content,
        metadata: buildChunkMetadata(chunk),
        embedding: embeddings[idx],
      }));

      // Insert to database
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

      // Rate limiting delay
      if (i + BATCH_SIZE < chunksWithPages.length) {
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
