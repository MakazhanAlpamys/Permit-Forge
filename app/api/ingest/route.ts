// ============================================================================
// PDF Ingestion API Route with Progress Streaming
// ============================================================================

import { NextRequest } from 'next/server';
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';
import { createServerClient } from '@/lib/supabase';
import { generateEmbedding } from '@/lib/gemini';
import { getQuickSession } from '@/lib/auth';
import type { EnhancedChunkMetadata } from '@/types';
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
// PDF Parsing
// -----------------------------------------------------------------------------

interface PDFPage {
  pageNumber: number;
  text: string;
}

async function parsePDFWithPages(buffer: Buffer): Promise<{ pages: PDFPage[]; totalPages: number }> {
  const pdfParse = await import('pdf-parse/lib/pdf-parse.js');
  
  const pages: PDFPage[] = [];
  let currentPage = 0;

  const pdfData = await pdfParse.default(buffer, {
    pagerender: async function(pageData: { pageIndex: number; getTextContent: () => Promise<{ items: Array<{ str: string }> }> }) {
      currentPage = pageData.pageIndex + 1;
      
      const textContent = await pageData.getTextContent();
      const pageText = textContent.items
        .map((item: { str: string }) => item.str)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      
      if (pageText.length > 0) {
        pages.push({
          pageNumber: currentPage,
          text: pageText,
        });
      }
      
      return pageText;
    }
  });

  if (pages.length === 0 && pdfData.text) {
    const CHARS_PER_PAGE = 3000;
    const fullText = pdfData.text;
    const estimatedPages = Math.ceil(fullText.length / CHARS_PER_PAGE);
    
    for (let i = 0; i < estimatedPages; i++) {
      const start = i * CHARS_PER_PAGE;
      const end = Math.min(start + CHARS_PER_PAGE, fullText.length);
      const pageText = fullText.slice(start, end).trim();
      
      if (pageText.length > 0) {
        pages.push({
          pageNumber: i + 1,
          text: pageText,
        });
      }
    }
  }

  return {
    pages: pages.length > 0 ? pages : [{ pageNumber: 1, text: pdfData.text }],
    totalPages: pdfData.numpages || pages.length,
  };
}

// -----------------------------------------------------------------------------
// Metadata Extraction
// -----------------------------------------------------------------------------

function extractEnhancedMetadata(
  content: string, 
  pageNumber: number,
  chunkIndex: number
): EnhancedChunkMetadata {
  const chapterPatterns = [
    /Chapter\s+(\d+)[:\s]+([^\n]+)/i,
    /CHAPTER\s+(\d+)[:\s]*([^\n]*)/i,
  ];
  let chapter: string | undefined;
  for (const pattern of chapterPatterns) {
    const match = content.match(pattern);
    if (match) {
      chapter = `Chapter ${match[1]}${match[2] ? ': ' + match[2].trim() : ''}`;
      break;
    }
  }

  const sectionPatterns = [
    /\b(\d+\.\d+(?:\.\d+)?(?:\.\d+)?)\s+/,
    /Section\s+(\d+\.\d+(?:\.\d+)?)/i,
  ];
  let section: string | undefined;
  for (const pattern of sectionPatterns) {
    const match = content.match(pattern);
    if (match) {
      section = match[1];
      break;
    }
  }

  const tablePatterns = [
    /Table\s+(\d+[-.]?\d*)[:\s]*([^\n]*)/i,
    /TABLE\s+(\d+[-.]?\d*)/i,
  ];
  let tableId: string | undefined;
  let tableName: string | undefined;
  for (const pattern of tablePatterns) {
    const match = content.match(pattern);
    if (match) {
      tableId = `Table ${match[1]}`;
      tableName = match[2]?.trim() || undefined;
      break;
    }
  }

  const isTable = /\|.*\|/m.test(content) || 
                  tableId !== undefined ||
                  (content.match(/\t/g) || []).length > 5;

  const headings: string[] = [];
  const headingPattern = /^([A-Z][A-Z\s]{5,})/gm;
  let headingMatch;
  while ((headingMatch = headingPattern.exec(content)) !== null) {
    const heading = headingMatch[1].trim();
    if (heading.length > 5 && heading.length < 100) {
      headings.push(heading);
    }
  }

  return {
    page: pageNumber,
    chapter,
    section,
    tableId,
    tableName,
    isTable,
    headings: headings.slice(0, 3),
    paragraph: chunkIndex,
  };
}

// -----------------------------------------------------------------------------
// Text Splitting
// -----------------------------------------------------------------------------

interface ChunkWithPageInfo {
  content: string;
  pageNumber: number;
  metadata: EnhancedChunkMetadata;
}

async function splitTextWithPageTracking(pages: PDFPage[]): Promise<ChunkWithPageInfo[]> {
  const textSplitter = new RecursiveCharacterTextSplitter({
    chunkSize: CHUNK_SIZE,
    chunkOverlap: CHUNK_OVERLAP,
    separators: ['\n\n\n', '\n\n', '\n', '. ', '; ', ', ', ' ', ''],
  });

  const chunksWithPages: ChunkWithPageInfo[] = [];
  let globalChunkIndex = 0;

  for (const page of pages) {
    if (!page.text || page.text.trim().length === 0) continue;

    const pageChunks = await textSplitter.splitText(page.text);

    for (const chunkContent of pageChunks) {
      if (chunkContent.trim().length < 50) continue;
      
      const metadata = extractEnhancedMetadata(
        chunkContent, 
        page.pageNumber, 
        globalChunkIndex
      );

      chunksWithPages.push({
        content: chunkContent.trim(),
        pageNumber: page.pageNumber,
        metadata,
      });

      globalChunkIndex++;
    }
  }

  return chunksWithPages;
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

      const pdfBuffer = fs.readFileSync(pdfPath);
      
      await sendProgress({
        stage: 'parsing',
        progress: 5,
        total: 100,
        message: 'Parsing PDF pages...',
      });

      // Stage 2: Parsing PDF
      const pdfData = await parsePDFWithPages(pdfBuffer);
      
      await sendProgress({
        stage: 'splitting',
        progress: 10,
        total: 100,
        message: `Splitting ${pdfData.totalPages} pages into chunks...`,
      });

      // Stage 3: Splitting into chunks
      const chunksWithPages = await splitTextWithPageTracking(pdfData.pages);
      const totalChunks = chunksWithPages.length;
      
      await sendProgress({
        stage: 'embedding',
        progress: 15,
        total: 100,
        message: `Processing ${totalChunks} chunks...`,
      });

      // Stage 4: Generate embeddings and insert
      const supabase = createServerClient();
      let processedCount = 0;
      const totalBatches = Math.ceil(totalChunks / BATCH_SIZE);

      for (let i = 0; i < chunksWithPages.length; i += BATCH_SIZE) {
        const batch = chunksWithPages.slice(i, i + BATCH_SIZE);
        const batchNumber = Math.floor(i / BATCH_SIZE) + 1;

        // Calculate progress (15% for reading/parsing, 85% for embedding/inserting)
        const progressPercent = 15 + Math.round((batchNumber / totalBatches) * 85);

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
          metadata: chunk.metadata,
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
        message: `Successfully ingested ${processedCount} chunks!`,
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
