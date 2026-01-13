// ============================================================================
// PDF Ingestion API Route with Progress Streaming (Enhanced with PDF.js)
// ============================================================================

import { NextRequest } from 'next/server';
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';
import { createServerClient } from '@/lib/supabase';
import { generateEmbedding } from '@/lib/gemini';
import { getQuickSession } from '@/lib/auth';
import { createPDFParser, PDFParser } from '@/lib/pdf-parser';
import type { ChunkMetadata, PDFPageContent, ChunkWithPageRange } from '@/types';
import fs from 'fs';
import path from 'path';

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 150;
const BATCH_SIZE = 10;
const PDF_PATH = 'public/dubai-code.pdf';

// -----------------------------------------------------------------------------
// Enhanced Text Splitting with Page Tracking
// -----------------------------------------------------------------------------

interface PageTextSegment {
  text: string;
  pageNumber: number;
}

async function splitWithPageTracking(
  pages: PDFPageContent[],
  parser: PDFParser
): Promise<ChunkWithPageRange[]> {
  const textSplitter = new RecursiveCharacterTextSplitter({
    chunkSize: CHUNK_SIZE,
    chunkOverlap: CHUNK_OVERLAP,
    separators: ['\n\n\n', '\n\n', '\n', '. ', '; ', ', ', ' ', ''],
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
    if (chunkContent.trim().length < 50) continue;

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

function buildChunkMetadata(chunk: ChunkWithPageRange): ChunkMetadata {
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
  const sendProgress = async (data: {
    stage: string;
    progress: number;
    total: number;
    message: string;
    done?: boolean;
    error?: string;
    chunksProcessed?: number;
  }) => {
    await writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
  };

  // Start processing in background
  (async () => {
    let parser: PDFParser | null = null;
    
    try {
      // Stage 1: Reading PDF
      await sendProgress({
        stage: 'reading',
        progress: 0,
        total: 100,
        message: 'Reading PDF file...',
      });

      const pdfPath = path.join(process.cwd(), PDF_PATH);
      
      if (!fs.existsSync(pdfPath)) {
        await sendProgress({
          stage: 'error',
          progress: 0,
          total: 100,
          message: 'PDF file not found',
          done: true,
          error: `PDF file not found at ${pdfPath}`,
        });
        await writer.close();
        return;
      }

      // Stage 2: Loading with PDF.js
      await sendProgress({
        stage: 'parsing',
        progress: 5,
        total: 100,
        message: 'Loading PDF with PDF.js...',
      });

      parser = await createPDFParser(pdfPath);
      
      await sendProgress({
        stage: 'toc',
        progress: 8,
        total: 100,
        message: 'Extracting Table of Contents...',
      });

      // Stage 3: Extract TOC
      const structure = await parser.extractTOC();
      
      await sendProgress({
        stage: 'extracting',
        progress: 10,
        total: 100,
        message: `Extracting text from ${parser.totalPages} pages...`,
      });

      // Stage 4: Extract all pages
      const pages = await parser.getAllPagesText();
      
      await sendProgress({
        stage: 'splitting',
        progress: 15,
        total: 100,
        message: `Splitting into chunks with page tracking...`,
      });

      // Stage 5: Split with page tracking
      const chunksWithPages = await splitWithPageTracking(pages, parser);
      const totalChunks = chunksWithPages.length;
      
      await sendProgress({
        stage: 'embedding',
        progress: 20,
        total: 100,
        message: `Processing ${totalChunks} chunks (TOC: ${structure.flatTOC.length} entries)...`,
      });

      // Stage 6: Generate embeddings and insert
      const supabase = createServerClient();
      let processedCount = 0;
      const totalBatches = Math.ceil(totalChunks / BATCH_SIZE);

      for (let i = 0; i < chunksWithPages.length; i += BATCH_SIZE) {
        const batch = chunksWithPages.slice(i, i + BATCH_SIZE);
        const batchNumber = Math.floor(i / BATCH_SIZE) + 1;

        // Calculate progress (20% for reading/parsing, 80% for embedding/inserting)
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

        // Prepare records with enhanced metadata
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
          await sendProgress({
            stage: 'error',
            progress: progressPercent,
            total: 100,
            message: `Failed at batch ${batchNumber}`,
            done: true,
            error: error.message,
            chunksProcessed: processedCount,
          });
          await writer.close();
          return;
        }

        processedCount += batch.length;

        // Small delay between batches
        if (i + BATCH_SIZE < chunksWithPages.length) {
          await new Promise(resolve => setTimeout(resolve, 200));
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
      if (parser) {
        await parser.close();
      }
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
