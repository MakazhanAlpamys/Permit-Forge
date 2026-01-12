'use server';

// ============================================================================
// PDF Ingestion Server Action (Enhanced with Precise Page Tracking)
// ============================================================================

import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';
import { createServerClient } from '@/lib/supabase';
import { generateEmbedding } from '@/lib/gemini';
import type { IngestionResult, ChunkMetadata, EnhancedChunkMetadata } from '@/types';
import fs from 'fs';
import path from 'path';

// -----------------------------------------------------------------------------
// PDF Parsing with Page-by-Page Extraction
// -----------------------------------------------------------------------------

interface PDFPage {
  pageNumber: number;
  text: string;
}

interface PDFData {
  pages: PDFPage[];
  totalPages: number;
}

/**
 * Parse PDF with page-by-page text extraction for accurate page tracking
 */
async function parsePDFWithPages(buffer: Buffer): Promise<PDFData> {
  // Dynamic import to avoid the test file issue
  const pdfParse = await import('pdf-parse/lib/pdf-parse.js');
  
  // Custom page renderer to track page boundaries
  const pages: PDFPage[] = [];
  let currentPage = 0;

  // First pass: get total pages and full text
  const pdfData = await pdfParse.default(buffer, {
    // Custom page renderer that tracks page content
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

  // If page-by-page extraction failed, fall back to splitting by heuristics
  if (pages.length === 0 && pdfData.text) {
    // Estimate ~3000 chars per page as fallback
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
// Configuration
// -----------------------------------------------------------------------------

const CHUNK_SIZE = 800;      // Smaller chunks for more precision
const CHUNK_OVERLAP = 150;   // Overlap to preserve context
const BATCH_SIZE = 10;
const PDF_PATH = 'public/dubai-code.pdf';

// -----------------------------------------------------------------------------
// Enhanced Metadata Extraction
// -----------------------------------------------------------------------------

/**
 * Extract rich metadata from chunk content with page info
 */
function extractEnhancedMetadata(
  content: string, 
  pageNumber: number,
  chunkIndex: number
): EnhancedChunkMetadata {
  // Extract chapter
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

  // Extract section number (like 4.2.1)
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

  // Extract table information
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

  // Detect if content is primarily a table
  const isTable = /\|.*\|/m.test(content) || 
                  tableId !== undefined ||
                  (content.match(/\t/g) || []).length > 5;

  // Extract headings (lines that look like headers)
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
    headings: headings.slice(0, 3), // Max 3 headings
    paragraph: chunkIndex,
  };
}

// -----------------------------------------------------------------------------
// Smart Text Splitting (Preserves Structure)
// -----------------------------------------------------------------------------

interface ChunkWithPageInfo {
  content: string;
  pageNumber: number;
  metadata: EnhancedChunkMetadata;
}

/**
 * Split text while preserving page boundaries and structure
 */
async function splitTextWithPageTracking(pages: PDFPage[]): Promise<ChunkWithPageInfo[]> {
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

  const chunksWithPages: ChunkWithPageInfo[] = [];
  let globalChunkIndex = 0;

  for (const page of pages) {
    if (!page.text || page.text.trim().length === 0) continue;

    // Split this page's content
    const pageChunks = await textSplitter.splitText(page.text);

    for (const chunkContent of pageChunks) {
      if (chunkContent.trim().length < 50) continue; // Skip tiny chunks
      
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
// Main Ingestion Action (Enhanced)
// -----------------------------------------------------------------------------

export async function ingestPDF(): Promise<IngestionResult> {
  try {
    // Step 1: Read and parse PDF with page tracking
    const pdfPath = path.join(process.cwd(), PDF_PATH);
    
    if (!fs.existsSync(pdfPath)) {
      throw new Error(`PDF file not found at ${pdfPath}`);
    }

    const pdfBuffer = fs.readFileSync(pdfPath);
    const pdfData = await parsePDFWithPages(pdfBuffer);

    // Step 2: Split text with page tracking
    const chunksWithPages = await splitTextWithPageTracking(pdfData.pages);

    // Step 3: Generate embeddings and upsert to database
    const supabase = createServerClient();
    
    let processedCount = 0;

    for (let i = 0; i < chunksWithPages.length; i += BATCH_SIZE) {
      const batch = chunksWithPages.slice(i, i + BATCH_SIZE);

      // Generate embeddings for batch
      const embeddingsPromises = batch.map(chunk => 
        generateEmbedding(chunk.content)
      );
      const embeddings = await Promise.all(embeddingsPromises);

      // Prepare records for upsert with enhanced metadata
      const records = batch.map((chunk, idx) => ({
        content: chunk.content,
        metadata: chunk.metadata,
        embedding: embeddings[idx],
      }));

      // Upsert to Supabase
      const { error } = await supabase
        .from('dubai_code_chunks')
        .insert(records);

      if (error) {
        throw new Error(`Failed to upsert batch: ${error.message}`);
      }

      processedCount += batch.length;

      // Small delay between batches to avoid rate limits
      if (i + BATCH_SIZE < chunksWithPages.length) {
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }
    
    return {
      success: true,
      chunksProcessed: processedCount,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    console.error('PDF ingestion error:', errorMessage);
    return {
      success: false,
      chunksProcessed: 0,
      error: `PDF ingestion failed: ${errorMessage}`,
    };
  }
}

// -----------------------------------------------------------------------------
// Clear Database Action
// -----------------------------------------------------------------------------

export async function clearChunks(): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = createServerClient();
    
    // First, check if table exists and we have access
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
    
    // If no chunks, return success
    if (count === 0) {
      return { success: true };
    }
    
    // Delete all rows
    const { error } = await supabase
      .from('dubai_code_chunks')
      .delete()
      .gte('id', 0); // Delete all rows (gte 0 matches all positive IDs)

    if (error) {
      console.error('Clear chunks - delete error:', error);
      return { 
        success: false, 
        error: `Delete error: ${error.message}` 
      };
    }

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
  error?: string;
}> {
  try {
    const supabase = createServerClient();
    
    // Test connection with a simple query
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

    // Get page range from metadata if there are chunks
    let minPage = 1;
    let maxPage = 1;
    
    if (count && count > 0) {
      const { data: pageData, error: pageError } = await supabase
        .from('dubai_code_chunks')
        .select('metadata')
        .limit(1000);

      if (!pageError && pageData && pageData.length > 0) {
        const pages = pageData
          .map(d => (d.metadata as { page?: number })?.page)
          .filter((p): p is number => typeof p === 'number');
        
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
  sampleChunk?: { page: number; section?: string; preview: string };
  error?: string;
}> {
  try {
    const supabase = createServerClient();
    
    // First check if table has data
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
    
    // If no chunks, the RPC will work but return nothing
    if (!count || count === 0) {
      return {
        success: true,
        chunksFound: 0,
        error: 'No chunks in database. Please ingest the PDF first.',
      };
    }
    
    // Create a simple test embedding (768 zeros - just for connectivity test)
    const testEmbedding = new Array(768).fill(0);
    
    const { data, error } = await supabase.rpc('match_dubai_code', {
      query_embedding: testEmbedding,
      match_count: 1,
      filter: {},
    });

    if (error) {
      console.error('RAG test - RPC error:', error);
      return {
        success: false,
        chunksFound: 0,
        error: `RPC Error: ${error.message}. Make sure to run the SQL migration first.`,
      };
    }

    const sampleChunk = data?.[0];
    
    return {
      success: true,
      chunksFound: data?.length || 0,
      sampleChunk: sampleChunk ? {
        page: (sampleChunk.metadata as { page?: number })?.page || 0,
        section: (sampleChunk.metadata as { section?: string })?.section,
        preview: (sampleChunk.content as string).slice(0, 100) + '...',
      } : undefined,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'RPC test failed';
    console.error('RAG test query error:', errorMessage);
    return {
      success: false,
      chunksFound: 0,
      error: `RAG test failed: ${errorMessage}`,
    };
  }
}
