'use server';

// ============================================================================
// PDF Ingestion Server Action
// ============================================================================

import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';
import { createServerClient } from '@/lib/supabase';
import { generateEmbedding } from '@/lib/gemini';
import type { IngestionResult, ChunkMetadata } from '@/types';
import fs from 'fs';
import path from 'path';

// -----------------------------------------------------------------------------
// PDF Parsing with pdf-parse fix
// -----------------------------------------------------------------------------

// pdf-parse has a bug where it tries to load a test file on import
// We need to use a workaround
async function parsePDF(buffer: Buffer): Promise<{ text: string; numpages: number }> {
  // Dynamic import to avoid the test file issue
  const pdf = await import('pdf-parse/lib/pdf-parse.js');
  return pdf.default(buffer);
}

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 200;
const BATCH_SIZE = 10; // Process embeddings in batches to avoid rate limits
const PDF_PATH = 'public/dubai-code.pdf';

// -----------------------------------------------------------------------------
// Main Ingestion Action
// -----------------------------------------------------------------------------

export async function ingestPDF(): Promise<IngestionResult> {
  try {
    console.log('Starting PDF ingestion...');

    // Step 1: Read PDF file
    console.log('Step 1: Reading PDF file...');
    const pdfPath = path.join(process.cwd(), PDF_PATH);
    
    if (!fs.existsSync(pdfPath)) {
      throw new Error(`PDF file not found at ${pdfPath}`);
    }

    const pdfBuffer = fs.readFileSync(pdfPath);
    const pdfData = await parsePDF(pdfBuffer);
    
    console.log(`PDF loaded: ${pdfData.numpages} pages`);

    // Step 2: Split text into chunks
    console.log('Step 2: Splitting text into chunks...');
    const textSplitter = new RecursiveCharacterTextSplitter({
      chunkSize: CHUNK_SIZE,
      chunkOverlap: CHUNK_OVERLAP,
      separators: ['\n\n', '\n', '. ', ' ', ''],
    });

    const rawChunks = await textSplitter.splitText(pdfData.text);
    console.log(`Created ${rawChunks.length} chunks`);

    // Step 3: Create chunks with metadata
    console.log('Step 3: Adding metadata to chunks...');
    const chunksWithMetadata = rawChunks.map((content, index) => {
      // Attempt to extract page number and section from content
      const metadata = extractMetadata(content, index, pdfData.numpages);
      return { content, metadata };
    });

    // Step 4: Generate embeddings and upsert to database
    console.log('Step 4: Generating embeddings and upserting to database...');
    const supabase = createServerClient();
    
    let processedCount = 0;
    const totalBatches = Math.ceil(chunksWithMetadata.length / BATCH_SIZE);

    for (let i = 0; i < chunksWithMetadata.length; i += BATCH_SIZE) {
      const batch = chunksWithMetadata.slice(i, i + BATCH_SIZE);
      const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
      
      console.log(`Processing batch ${batchNumber}/${totalBatches}...`);

      // Generate embeddings for batch
      const embeddingsPromises = batch.map(chunk => 
        generateEmbedding(chunk.content)
      );
      const embeddings = await Promise.all(embeddingsPromises);

      // Prepare records for upsert
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
        console.error(`Error upserting batch ${batchNumber}:`, error);
        throw new Error(`Failed to upsert batch ${batchNumber}: ${error.message}`);
      }

      processedCount += batch.length;
      console.log(`Processed ${processedCount}/${chunksWithMetadata.length} chunks`);

      // Small delay between batches to avoid rate limits
      if (i + BATCH_SIZE < chunksWithMetadata.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    console.log('PDF ingestion complete!');
    
    return {
      success: true,
      chunksProcessed: processedCount,
    };
  } catch (error) {
    console.error('PDF ingestion error:', error);
    return {
      success: false,
      chunksProcessed: 0,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    };
  }
}

// -----------------------------------------------------------------------------
// Clear Database Action
// -----------------------------------------------------------------------------

export async function clearChunks(): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = createServerClient();
    
    const { error } = await supabase
      .from('dubai_code_chunks')
      .delete()
      .neq('id', 0); // Delete all rows

    if (error) {
      throw new Error(error.message);
    }

    return { success: true };
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error' 
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
  error?: string;
}> {
  try {
    const supabase = createServerClient();
    
    const { count, error } = await supabase
      .from('dubai_code_chunks')
      .select('*', { count: 'exact', head: true });

    if (error) {
      return {
        hasChunks: false,
        chunkCount: 0,
        dbConnected: false,
        error: error.message,
      };
    }

    return {
      hasChunks: (count || 0) > 0,
      chunkCount: count || 0,
      dbConnected: true,
    };
  } catch (error) {
    console.error('Get ingestion status error:', error);
    return { 
      hasChunks: false, 
      chunkCount: 0, 
      dbConnected: false,
      error: error instanceof Error ? error.message : 'Connection failed'
    };
  }
}

// -----------------------------------------------------------------------------
// Test RAG Function
// -----------------------------------------------------------------------------

export async function testRAGQuery(): Promise<{
  success: boolean;
  chunksFound: number;
  error?: string;
}> {
  try {
    const supabase = createServerClient();
    
    // Create a simple test embedding (768 zeros - just for connectivity test)
    const testEmbedding = new Array(768).fill(0);
    
    const { data, error } = await supabase.rpc('match_dubai_code', {
      query_embedding: testEmbedding,
      match_count: 1,
      filter: {},
    });

    if (error) {
      return {
        success: false,
        chunksFound: 0,
        error: `RPC Error: ${error.message}. Make sure to run the SQL migration first.`,
      };
    }

    return {
      success: true,
      chunksFound: data?.length || 0,
    };
  } catch (error) {
    return {
      success: false,
      chunksFound: 0,
      error: error instanceof Error ? error.message : 'RPC test failed',
    };
  }
}

// -----------------------------------------------------------------------------
// Metadata Extraction Helper
// -----------------------------------------------------------------------------

function extractMetadata(content: string, index: number, totalPages: number): ChunkMetadata {
  // Estimate page number based on chunk index and total pages
  // This is an approximation - actual page numbers would require more sophisticated parsing
  const estimatedPage = Math.floor((index / totalPages) * totalPages) + 1;
  
  // Try to extract chapter information
  const chapterMatch = content.match(/Chapter\s+(\d+)[:\s]+([^\n]+)/i);
  const chapter = chapterMatch ? `Chapter ${chapterMatch[1]}: ${chapterMatch[2].trim()}` : undefined;
  
  // Try to extract section information
  const sectionMatch = content.match(/(\d+\.\d+(?:\.\d+)?)\s+([^\n]+)/);
  const section = sectionMatch ? sectionMatch[1] : undefined;
  
  // Try to extract table information
  const tableMatch = content.match(/Table\s+(\d+-\d+)[:\s]*([^\n]*)/i);
  const tableId = tableMatch ? `Table ${tableMatch[1]}` : undefined;
  const tableName = tableMatch && tableMatch[2] ? tableMatch[2].trim() : undefined;

  return {
    page: estimatedPage,
    chapter,
    section,
    tableId,
    tableName,
  };
}
