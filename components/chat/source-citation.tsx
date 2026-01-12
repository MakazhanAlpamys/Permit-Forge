'use client';

// ============================================================================
// Source Citation Component
// ============================================================================

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { 
  ChevronDown, 
  ChevronUp, 
  FileText 
} from 'lucide-react';
import type { Citation } from '@/types';

interface SourceCitationProps {
  citation: Citation;
  index: number;
}

function SourceCitation({ citation, index }: SourceCitationProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className="border border-border rounded-lg overflow-hidden bg-card/50">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-3 py-2 flex items-center justify-between hover:bg-muted/50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="flex items-center justify-center w-5 h-5 rounded-full bg-primary/20 text-primary text-xs font-medium">
            {index + 1}
          </span>
          <FileText className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-sm text-foreground">
            Page {citation.page}
            {citation.section && ` • ${citation.section}`}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {isExpanded ? (
            <ChevronUp className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
      </button>
      
      {isExpanded && (
        <div className="px-3 py-3 border-t border-border bg-muted/30">
          <p className="text-sm text-muted-foreground leading-relaxed">
            {citation.excerpt}
          </p>
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

  const displayedCitations = showAll ? citations : citations.slice(0, 2);
  const hasMore = citations.length > 2;

  return (
    <div className="mt-3 space-y-2">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <FileText className="h-3 w-3" />
        <span>Sources ({citations.length})</span>
      </div>
      <div className="space-y-1.5">
        {displayedCitations.map((citation, index) => (
          <SourceCitation 
            key={`${citation.chunkId}-${index}`} 
            citation={citation} 
            index={index} 
          />
        ))}
      </div>
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
