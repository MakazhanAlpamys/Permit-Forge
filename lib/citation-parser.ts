// ============================================================================
// Citation Parser - Extract and Match Citations from AI Responses
// ============================================================================

import { createServerClient } from '@/lib/supabase-server';
import type { Citation, MatchedChunk, ChunkMetadata } from '@/types';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface ParsedCitation {
  page: number;
  section?: string;
  originalText: string;  // Original citation text from AI response
  position: number;      // Position in the response text
}

export interface MatchedCitation extends Citation {
  isVerified: boolean;
  matchScore: number;
  confidence: number;      // 0-100 verification confidence
}

// -----------------------------------------------------------------------------
// Citation Patterns
// -----------------------------------------------------------------------------

// Patterns to match citations in AI responses
const CITATION_PATTERNS = [
  // [Page 45, Section 3.2.1]
  /\[Page\s+(\d+)(?:\s*[-–,]\s*(\d+))?,?\s*Section\s+([\d.]+)\]/gi,
  // [Page 45, §3.2.1]
  /\[Page\s+(\d+)(?:\s*[-–,]\s*(\d+))?,?\s*§\s*([\d.]+)\]/gi,
  // [Page 45-46, Section 3.2]
  /\[Pages?\s+(\d+)\s*[-–]\s*(\d+),?\s*Section\s+([\d.]+)\]/gi,
  // [Page 45]
  /\[Page\s+(\d+)(?:\s*[-–]\s*(\d+))?\]/gi,
  // [Pages 45-46]
  /\[Pages\s+(\d+)\s*[-–]\s*(\d+)\]/gi,
  // (Page 45, Section 3.2.1)
  /\(Page\s+(\d+)(?:\s*[-–,]\s*(\d+))?,?\s*Section\s+([\d.]+)\)/gi,
  // (Page 45)
  /\(Page\s+(\d+)(?:\s*[-–]\s*(\d+))?\)/gi,
  // Page 45, Section 3.2.1 (without brackets, at sentence end)
  /Page\s+(\d+),?\s*Section\s+([\d.]+)(?=[.;,\s]|$)/gi,
  // Section 3.2.1, Page 45 (reversed order)
  /Section\s+([\d.]+),?\s*Page\s+(\d+)/gi,
];

// -----------------------------------------------------------------------------
// Parse Citations from AI Response
// -----------------------------------------------------------------------------

/**
 * Extract all citations from an AI response text
 * Returns array of parsed citations with page numbers and optional sections
 */
export function parseCitationsFromResponse(responseText: string): ParsedCitation[] {
  const citations: ParsedCitation[] = [];
  const seenCitations = new Set<string>(); // Avoid duplicates

  for (const pattern of CITATION_PATTERNS) {
    // Reset regex lastIndex for each pattern
    pattern.lastIndex = 0;
    
    let match;
    while ((match = pattern.exec(responseText)) !== null) {
      let page: number;
      let endPage: number | undefined;
      let section: string | undefined;

      // Handle different pattern groups
      if (pattern.source.includes('Section\\s+([\\d.]+),?\\s*Page')) {
        // Reversed order: Section first, then Page
        section = match[1];
        page = parseInt(match[2], 10);
      } else if (match[3]) {
        // Pattern with section: [Page X, Section Y]
        page = parseInt(match[1], 10);
        endPage = match[2] ? parseInt(match[2], 10) : undefined;
        section = match[3];
      } else if (match[2] && !match[3]) {
        // Pattern with page range: [Page X-Y] or [Pages X-Y]
        page = parseInt(match[1], 10);
        endPage = parseInt(match[2], 10);
      } else {
        // Simple pattern: [Page X]
        page = parseInt(match[1], 10);
      }

      // Create unique key to avoid duplicates
      const key = `${page}-${endPage || page}-${section || ''}`;
      
      if (!seenCitations.has(key) && page > 0) {
        seenCitations.add(key);
        citations.push({
          page,
          section,
          originalText: match[0],
          position: match.index,
        });
      }
    }
  }

  // Sort by position in text
  return citations.sort((a, b) => a.position - b.position);
}

// -----------------------------------------------------------------------------
// Match Parsed Citations to Database Chunks
// -----------------------------------------------------------------------------

/**
 * Match parsed citations to actual chunks in the database
 * Uses the match_citation RPC function for efficient matching
 */
export async function matchCitationsToChunks(
  parsedCitations: ParsedCitation[],
  fallbackChunks: MatchedChunk[],
  verificationConfidence: number = 50  // Global confidence from verifyAnswer
): Promise<MatchedCitation[]> {
  if (parsedCitations.length === 0) {
    // No citations parsed - fallback to top chunks but mark as unverified
    return fallbackChunks.slice(0, 5).map(chunk => ({
      chunkId: chunk.id,
      page: chunk.metadata.page || 0,
      startPage: chunk.metadata.startPage,
      endPage: chunk.metadata.endPage,
      section: chunk.metadata.section,
      sectionTitle: chunk.metadata.sectionTitle,
      excerpt: truncateExcerpt(chunk.content, 200),
      similarity: chunk.similarity,
      isVerified: false,
      matchScore: 0,
      confidence: Math.round(chunk.similarity * 40), // Low confidence for fallback
    }));
  }

  const supabase = createServerClient();
  const matchedCitations: MatchedCitation[] = [];
  const seenChunkIds = new Set<number>();

  // Match each parsed citation
  for (const citation of parsedCitations) {
    try {
      const { data, error } = await supabase.rpc('match_citation', {
        citation_page: citation.page,
        citation_section: citation.section || null,
        match_count: 3,
      });

      if (error) {
        console.error('Citation match error:', error);
        continue;
      }

      if (data && data.length > 0) {
        // Take the best match for this citation
        const bestMatch = data[0] as {
          id: number;
          content: string;
          metadata: ChunkMetadata;
          match_score: number;
        };

        // Avoid duplicate chunks
        if (!seenChunkIds.has(bestMatch.id)) {
          seenChunkIds.add(bestMatch.id);

          // Calculate confidence: combine match_score with verification confidence
          // match_score is 0-100 (page/section match quality)
          // verificationConfidence is 0-100 (how well AI answer is supported)
          const citationConfidence = Math.round(
            (bestMatch.match_score * 0.6) + (verificationConfidence * 0.4)
          );

          matchedCitations.push({
            chunkId: bestMatch.id,
            page: bestMatch.metadata.page || citation.page,
            startPage: bestMatch.metadata.startPage,
            endPage: bestMatch.metadata.endPage,
            section: bestMatch.metadata.section || citation.section,
            sectionTitle: bestMatch.metadata.sectionTitle,
            excerpt: truncateExcerpt(bestMatch.content, 200),
            similarity: bestMatch.match_score / 100, // Normalize to 0-1
            isVerified: true, // This citation was found in AI response
            matchScore: bestMatch.match_score,
            confidence: citationConfidence,
            contentType: bestMatch.metadata.contentType,
          });
        }
      }
    } catch (error) {
      console.error('Error matching citation:', error);
    }
  }

  // If we found verified citations, return them
  if (matchedCitations.length > 0) {
    // Sort by match score (highest first)
    return matchedCitations.sort((a, b) => b.matchScore - a.matchScore);
  }

  // Fallback: return top chunks as unverified
  return fallbackChunks.slice(0, 5).map(chunk => ({
    chunkId: chunk.id,
    page: chunk.metadata.page || 0,
    startPage: chunk.metadata.startPage,
    endPage: chunk.metadata.endPage,
    section: chunk.metadata.section,
    sectionTitle: chunk.metadata.sectionTitle,
    excerpt: truncateExcerpt(chunk.content, 200),
    similarity: chunk.similarity,
    isVerified: false,
    matchScore: 0,
    confidence: Math.round(chunk.similarity * 40), // Low confidence for fallback
    contentType: chunk.metadata.contentType,
  }));
}

// -----------------------------------------------------------------------------
// Create Smart Citations from Response and Chunks
// -----------------------------------------------------------------------------

/**
 * Main function: Extract citations from AI response and match to database
 * Returns dynamic number of citations (1-10) based on what AI actually used
 * @param aiResponse - The AI generated response text
 * @param retrievedChunks - Chunks retrieved from RAG search
 * @param verificationConfidence - Overall confidence from verifyAnswer (0-100)
 * @param minConfidenceThreshold - Minimum confidence to include citation (default 30)
 */
export async function createSmartCitations(
  aiResponse: string,
  retrievedChunks: MatchedChunk[],
  verificationConfidence: number = 50,
  minConfidenceThreshold: number = 30
): Promise<Citation[]> {
  // Step 1: Parse citations from AI response
  const parsedCitations = parseCitationsFromResponse(aiResponse);
  
  console.log(`📑 Parsed ${parsedCitations.length} citations from AI response`);
  if (parsedCitations.length > 0) {
    console.log('   Citations:', parsedCitations.map(c => 
      `Page ${c.page}${c.section ? `, Section ${c.section}` : ''}`
    ).join('; '));
  }

  // Step 2: Match to database chunks with verification confidence
  const matchedCitations = await matchCitationsToChunks(
    parsedCitations, 
    retrievedChunks,
    verificationConfidence
  );

  // Step 3: Add any high-relevance chunks that weren't cited but might be useful
  const verifiedIds = new Set(
    matchedCitations.filter(c => c.isVerified).map(c => c.chunkId)
  );

  // If AI cited sources, supplement with unused high-relevance chunks (max 2)
  if (parsedCitations.length > 0 && matchedCitations.length < 10) {
    const additionalChunks = retrievedChunks
      .filter(chunk => !verifiedIds.has(chunk.id))
      .filter(chunk => chunk.similarity > 0.7) // Only very relevant
      .slice(0, 2);

    for (const chunk of additionalChunks) {
      // Lower confidence for supplemental chunks
      const supplementalConfidence = Math.round(
        (chunk.similarity * 50) + (verificationConfidence * 0.2)
      );
      
      matchedCitations.push({
        chunkId: chunk.id,
        page: chunk.metadata.page || 0,
        startPage: chunk.metadata.startPage,
        endPage: chunk.metadata.endPage,
        section: chunk.metadata.section,
        sectionTitle: chunk.metadata.sectionTitle,
        excerpt: truncateExcerpt(chunk.content, 200),
        similarity: chunk.similarity,
        isVerified: false, // Not directly cited by AI
        matchScore: Math.round(chunk.similarity * 50), // Lower score for supplemental
        confidence: supplementalConfidence,
        contentType: chunk.metadata.contentType,
      });
    }
  }

  // Step 4: Filter out low-confidence citations
  const filteredCitations = matchedCitations.filter(
    c => (c.confidence ?? 0) >= minConfidenceThreshold || c.isVerified
  );

  // Limit to 10 citations max
  const finalCitations = filteredCitations.slice(0, 10);

  console.log(`✅ Returning ${finalCitations.length} citations (${
    finalCitations.filter(c => c.isVerified).length
  } verified, min confidence: ${minConfidenceThreshold})`);

  return finalCitations;
}

// -----------------------------------------------------------------------------
// Utility Functions
// -----------------------------------------------------------------------------

function truncateExcerpt(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  // Try to truncate at a sentence boundary
  const truncated = text.substring(0, maxLength);
  const lastPeriod = truncated.lastIndexOf('.');
  if (lastPeriod > maxLength * 0.7) {
    return truncated.substring(0, lastPeriod + 1);
  }
  return truncated.trim() + '...';
}

/**
 * Get citation count statistics for logging/debugging
 */
export function getCitationStats(citations: Citation[]): {
  total: number;
  verified: number;
  unverified: number;
  uniquePages: number;
  uniqueSections: number;
} {
  const verifiedCount = citations.filter(c => c.isVerified).length;
  const pages = new Set(citations.map(c => c.page));
  const sections = new Set(citations.filter(c => c.section).map(c => c.section));

  return {
    total: citations.length,
    verified: verifiedCount,
    unverified: citations.length - verifiedCount,
    uniquePages: pages.size,
    uniqueSections: sections.size,
  };
}
