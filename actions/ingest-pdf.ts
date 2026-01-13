'use server';

// ============================================================================
// PDF Ingestion Server Action (Enhanced with PDF.js & TOC Extraction)
// ============================================================================

import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';
import { createServerClient } from '@/lib/supabase';
import { generateEmbedding } from '@/lib/gemini';
import { createPDFParser, PDFParser } from '@/lib/pdf-parser';
import type { 
  IngestionResult, 
  ChunkMetadata,
  PDFPageContent,
  DocumentStructure,
  ChunkWithPageRange
} from '@/types';
import path from 'path';
import fs from 'fs';

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const CHUNK_SIZE = 800;      // Characters per chunk
const CHUNK_OVERLAP = 150;   // Overlap between chunks
const BATCH_SIZE = 10;       // Chunks per database batch
const PDF_PATH = 'public/dubai-code.pdf';

// -----------------------------------------------------------------------------
// Enhanced Text Splitter with Page Tracking
// -----------------------------------------------------------------------------

interface PageTextSegment {
  text: string;
  pageNumber: number;
}

/**
 * Split text while tracking which pages each chunk spans
 * This ensures accurate page range attribution
 */
async function splitWithPageTracking(
  pages: PDFPageContent[],
  parser: PDFParser
): Promise<ChunkWithPageRange[]> {
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
    
    const startPos = fullText.length;
    fullText += page.text + '\n\n'; // Add separator between pages
    
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
    if (chunkContent.trim().length < 50) continue; // Skip tiny chunks

    // Find the chunk position in full text
    const chunkStart = fullText.indexOf(chunkContent, currentPosition);
    const chunkEnd = chunkStart + chunkContent.length;
    
    // Determine which pages this chunk spans
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

    // Get section info from TOC
    const sectionInfo = parser.findSectionForPage(startPage);
    
    // Detect content type
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
// Build Enhanced Metadata
// -----------------------------------------------------------------------------

function buildChunkMetadata(chunk: ChunkWithPageRange, index: number): ChunkMetadata {
  // Extract chapter from section path
  const chapter = chunk.sectionPath?.find(p => /chapter/i.test(p));
  
  // Try to extract table ID from content
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
    page: chunk.startPage,          // Primary page (backwards compatibility)
    startPage: chunk.startPage,     // NEW: Start of page range
    endPage: chunk.endPage,         // NEW: End of page range
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
// Main Ingestion Action (Enhanced)
// -----------------------------------------------------------------------------

export async function ingestPDF(): Promise<IngestionResult> {
  let parser: PDFParser | null = null;
  
  try {
    const pdfPath = path.join(process.cwd(), PDF_PATH);
    
    if (!fs.existsSync(pdfPath)) {
      throw new Error(`PDF file not found at ${pdfPath}`);
    }

    console.log('📄 Starting PDF ingestion with PDF.js...');

    // Step 1: Load PDF with PDF.js
    parser = await createPDFParser(pdfPath);
    console.log(`✅ Loaded PDF with ${parser.totalPages} pages`);

    // Step 2: Extract Table of Contents
    console.log('📑 Extracting Table of Contents...');
    const structure = await parser.extractTOC();
    console.log(`✅ Found ${structure.flatTOC.length} TOC entries`);
    
    // Log some TOC entries for verification
    if (structure.flatTOC.length > 0) {
      console.log('📋 Sample TOC entries:');
      structure.flatTOC.slice(0, 5).forEach(entry => {
        console.log(`   - ${entry.section || '?'}: ${entry.title} (Page ${entry.pageNumber})`);
      });
    }

    // Step 3: Extract text from all pages
    console.log('📝 Extracting text from pages...');
    const pages = await parser.getAllPagesText();
    console.log(`✅ Extracted text from ${pages.length} pages`);

    // Step 4: Split into chunks with page tracking
    console.log('✂️ Splitting into chunks with page tracking...');
    const chunksWithPages = await splitWithPageTracking(pages, parser);
    console.log(`✅ Created ${chunksWithPages.length} chunks`);

    // Log chunk statistics
    const multiPageChunks = chunksWithPages.filter(c => c.startPage !== c.endPage);
    console.log(`📊 Chunks spanning multiple pages: ${multiPageChunks.length}`);
    
    const tableChunks = chunksWithPages.filter(c => c.isTable);
    console.log(`📊 Table chunks: ${tableChunks.length}`);

    // Step 5: Generate embeddings and store in database
    const supabase = createServerClient();
    let processedCount = 0;

    console.log('🔄 Generating embeddings and storing...');

    for (let i = 0; i < chunksWithPages.length; i += BATCH_SIZE) {
      const batch = chunksWithPages.slice(i, i + BATCH_SIZE);

      // Generate embeddings for batch
      const embeddingsPromises = batch.map(chunk => 
        generateEmbedding(chunk.content)
      );
      const embeddings = await Promise.all(embeddingsPromises);

      // Build records with enhanced metadata
      const records = batch.map((chunk, idx) => ({
        content: chunk.content,
        metadata: buildChunkMetadata(chunk, i + idx),
        embedding: embeddings[idx],
      }));

      // Insert to Supabase
      const { error } = await supabase
        .from('dubai_code_chunks')
        .insert(records);

      if (error) {
        throw new Error(`Failed to insert batch: ${error.message}`);
      }

      processedCount += batch.length;
      
      // Progress logging
      if (processedCount % 50 === 0) {
        console.log(`   Processed ${processedCount}/${chunksWithPages.length} chunks...`);
      }

      // Small delay between batches to avoid rate limits
      if (i + BATCH_SIZE < chunksWithPages.length) {
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }

    console.log('✅ PDF ingestion complete!');
    
    return {
      success: true,
      chunksProcessed: processedCount,
      pagesProcessed: parser.totalPages,
      tocExtracted: structure.flatTOC.length > 0,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    console.error('❌ PDF ingestion error:', errorMessage);
    return {
      success: false,
      chunksProcessed: 0,
      error: `PDF ingestion failed: ${errorMessage}`,
    };
  } finally {
    // Clean up
    if (parser) {
      await parser.close();
    }
  }
}

// -----------------------------------------------------------------------------
// Clear Database Action
// -----------------------------------------------------------------------------

export async function clearChunks(): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = createServerClient();
    
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
// Get Ingestion Status (Enhanced)
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
  try {
    const supabase = createServerClient();
    
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
          
          // Check for startPage/endPage
          if (metadata?.startPage && metadata?.endPage) {
            hasPageRanges = true;
            pages.push(metadata.startPage, metadata.endPage);
          } else if (metadata?.page) {
            pages.push(metadata.page);
          }
          
          // Check for sectionPath (indicates TOC was extracted)
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
// Test RAG Function (Enhanced)
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
  try {
    const supabase = createServerClient();
    
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
    
    // Get a sample chunk to verify metadata structure
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
