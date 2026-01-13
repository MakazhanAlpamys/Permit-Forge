'use client';

// ============================================================================
// Source Citation Component (Enhanced with Page Ranges)
// ============================================================================

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { 
  ChevronDown, 
  ChevronUp, 
  FileText,
  CheckCircle2,
  BookOpen
} from 'lucide-react';
import type { Citation } from '@/types';

// -----------------------------------------------------------------------------
// Helper Functions
// -----------------------------------------------------------------------------

/**
 * Format page display - handles single page and page ranges
 * @example formatPageDisplay(45, 45) => "Page 45"
 * @example formatPageDisplay(45, 46) => "Pages 45-46"
 */
function formatPageDisplay(citation: Citation): string {
  const startPage = citation.startPage ?? citation.page;
  const endPage = citation.endPage ?? citation.page;
  
  if (startPage === endPage) {
    return `Page ${startPage}`;
  }
  return `Pages ${startPage}-${endPage}`;
}

/**
 * Format section display with optional title
 */
function formatSectionDisplay(citation: Citation): string | null {
  if (!citation.section) return null;
  
  if (citation.sectionTitle) {
    // Truncate long titles
    const title = citation.sectionTitle.length > 40 
      ? citation.sectionTitle.slice(0, 37) + '...'
      : citation.sectionTitle;
    return `§${citation.section}: ${title}`;
  }
  
  return `§${citation.section}`;
}

// -----------------------------------------------------------------------------
// Source Citation Component
// -----------------------------------------------------------------------------

interface SourceCitationProps {
  citation: Citation;
  index: number;
}

function SourceCitation({ citation, index }: SourceCitationProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  
  const pageDisplay = formatPageDisplay(citation);
  const sectionDisplay = formatSectionDisplay(citation);
  const isPageRange = (citation.startPage ?? citation.page) !== (citation.endPage ?? citation.page);

  return (
    <div className="border border-border rounded-lg overflow-hidden bg-card/50">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-3 py-2 flex items-center justify-between hover:bg-muted/50 transition-colors"
      >
        <div className="flex items-center gap-2 flex-1 min-w-0">
          {/* Index badge */}
          <span className="flex items-center justify-center w-5 h-5 rounded-full bg-primary/20 text-primary text-xs font-medium shrink-0">
            {index + 1}
          </span>
          
          {/* Icon */}
          <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          
          {/* Page info */}
          <span className="text-sm text-foreground font-medium">
            {pageDisplay}
          </span>
          
          {/* Page range indicator */}
          {isPageRange && (
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 bg-blue-500/10 text-blue-600 border-blue-500/20">
              <BookOpen className="h-2.5 w-2.5 mr-0.5" />
              range
            </Badge>
          )}
          
          {/* Section info */}
          {sectionDisplay && (
            <span className="text-xs text-muted-foreground truncate">
              • {sectionDisplay}
            </span>
          )}
          
          {/* Verified badge */}
          {citation.isVerified && (
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 bg-green-500/10 text-green-600 border-green-500/20 shrink-0">
              <CheckCircle2 className="h-2.5 w-2.5 mr-0.5" />
              verified
            </Badge>
          )}
        </div>
        
        {/* Expand/Collapse icon */}
        <div className="flex items-center gap-2 shrink-0 ml-2">
          {isExpanded ? (
            <ChevronUp className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
      </button>
      
      {/* Expanded content */}
      {isExpanded && (
        <div className="px-3 py-3 border-t border-border bg-muted/30 space-y-2">
          {/* Section title if present */}
          {citation.sectionTitle && (
            <div className="text-xs text-muted-foreground">
              <span className="font-medium">Section:</span> {citation.sectionTitle}
            </div>
          )}
          
          {/* Excerpt */}
          <p className="text-sm text-muted-foreground leading-relaxed">
            {citation.excerpt}
          </p>
          
          {/* Similarity score (for debugging/transparency) */}
          {citation.similarity !== undefined && citation.similarity > 0 && (
            <div className="flex items-center gap-2 pt-1 border-t border-border/50">
              <span className="text-[10px] text-muted-foreground/70">
                Relevance: {Math.round(citation.similarity * 100)}%
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Citations List Component
// ============================================================================

interface CitationsListProps {
  citations: Citation[];
}

export function CitationsList({ citations }: CitationsListProps) {
  const [showAll, setShowAll] = useState(false);
  
  if (!citations || citations.length === 0) {
    return null;
  }

  // Sort by verified first, then by page number
  const sortedCitations = [...citations].sort((a, b) => {
    if (a.isVerified && !b.isVerified) return -1;
    if (!a.isVerified && b.isVerified) return 1;
    return (a.startPage ?? a.page) - (b.startPage ?? b.page);
  });

  const displayedCitations = showAll ? sortedCitations : sortedCitations.slice(0, 2);
  const hasMore = sortedCitations.length > 2;
  const verifiedCount = sortedCitations.filter(c => c.isVerified).length;

  return (
    <div className="mt-3 space-y-2">
      {/* Header */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <FileText className="h-3 w-3" />
        <span>Sources ({citations.length})</span>
        {verifiedCount > 0 && (
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 bg-green-500/10 text-green-600 border-green-500/20">
            <CheckCircle2 className="h-2.5 w-2.5 mr-0.5" />
            {verifiedCount} verified
          </Badge>
        )}
      </div>
      
      {/* Citations list */}
      <div className="space-y-1.5">
        {displayedCitations.map((citation, index) => (
          <SourceCitation 
            key={`${citation.chunkId}-${index}`} 
            citation={citation} 
            index={index} 
          />
        ))}
      </div>
      
      {/* Show more/less button */}
      {hasMore && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowAll(!showAll)}
          className="w-full h-8 text-xs text-muted-foreground"
        >
          {showAll ? (
            <>
              <ChevronUp className="h-3 w-3 mr-1" />
              Show less
            </>
          ) : (
            <>
              <ChevronDown className="h-3 w-3 mr-1" />
              Show {citations.length - 2} more sources
            </>
          )}
        </Button>
      )}
    </div>
  );
}
