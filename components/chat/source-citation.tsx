'use client';

// ============================================================================
// Source Citation Component (Enhanced with Page Ranges, Confidence & Rich Excerpt)
// ============================================================================

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  ChevronDown,
  ChevronUp,
  FileText,
  CheckCircle2,
  BookOpen,
  AlertCircle,
  ShieldCheck,
  Table2,
  List
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
function formatPageDisplay(citation: Citation, t: (k: string, opts?: Record<string, unknown>) => string): string {
  const startPage = citation.startPage ?? citation.page;
  const endPage = citation.endPage ?? citation.page;

  if (startPage === endPage) {
    return t('dashboard.chat.page', { page: startPage });
  }
  return t('dashboard.chat.pages', { start: startPage, end: endPage });
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

/**
 * Get confidence level and color
 */
function getConfidenceLevel(confidence: number | undefined): {
  level: 'high' | 'medium' | 'low';
  color: string;
  bgColor: string;
  borderColor: string;
} {
  const conf = confidence ?? 0;

  if (conf >= 70) {
    return {
      level: 'high',
      color: 'text-violet-600',
      bgColor: 'bg-violet-500/10',
      borderColor: 'border-violet-500/20',
    };
  } else if (conf >= 40) {
    return {
      level: 'medium',
      color: 'text-yellow-600',
      bgColor: 'bg-yellow-500/10',
      borderColor: 'border-yellow-500/20',
    };
  } else {
    return {
      level: 'low',
      color: 'text-orange-600',
      bgColor: 'bg-orange-500/10',
      borderColor: 'border-orange-500/20',
    };
  }
}

/**
 * Get content type icon and label
 */
function getContentTypeInfo(contentType: Citation['contentType']): {
  icon: React.ReactNode;
  labelKey: string;
  color: string;
} | null {
  switch (contentType) {
    case 'table':
      return {
        icon: <Table2 className="h-2.5 w-2.5" />,
        labelKey: 'dashboard.chat.contentTable',
        color: 'text-purple-600 bg-purple-500/10 border-purple-500/20',
      };
    case 'list':
      return {
        icon: <List className="h-2.5 w-2.5" />,
        labelKey: 'dashboard.chat.contentList',
        color: 'text-cyan-600 bg-cyan-500/10 border-cyan-500/20',
      };
    default:
      return null;
  }
}

/**
 * Render excerpt with basic formatting
 * - Detects table-like content and renders as simple table
 * - Handles lists
 */
function RichExcerpt({ excerpt, contentType }: { excerpt: string; contentType?: Citation['contentType'] }) {
  // Try to detect and render table content
  if (contentType === 'table' || detectTableContent(excerpt)) {
    const tableRows = parseTableContent(excerpt);
    if (tableRows.length > 0) {
      return (
        <div className="overflow-x-auto">
          <table className="text-xs w-full border-collapse">
            <tbody>
              {tableRows.map((row, i) => (
                <tr key={i} className={i === 0 ? 'font-medium bg-muted/50' : ''}>
                  {row.map((cell, j) => (
                    <td key={j} className="px-2 py-1 border border-border/50 text-muted-foreground">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
  }

  // Handle lists
  if (contentType === 'list' || /^[\s]*(?:\d+\.|[•\-\*])\s+/m.test(excerpt)) {
    const lines = excerpt.split('\n').filter(l => l.trim());
    return (
      <ul className="text-sm text-muted-foreground leading-relaxed space-y-1 list-disc list-inside">
        {lines.map((line, i) => {
          // Remove bullet/number prefix
          const cleanLine = line.replace(/^[\s]*(?:\d+\.|[•\-\*])\s+/, '');
          return <li key={i}>{cleanLine || line}</li>;
        })}
      </ul>
    );
  }

  // Default text rendering
  return (
    <p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap">
      {excerpt}
    </p>
  );
}

/**
 * Detect if text looks like a table
 */
function detectTableContent(text: string): boolean {
  // Check for multiple columns with consistent spacing or tabs
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length < 2) return false;

  // Check for tab-separated or multiple-space-separated values
  const hasTabular = lines.filter(line =>
    /\t/.test(line) || /\s{3,}/.test(line)
  ).length >= 2;

  return hasTabular;
}

/**
 * Parse text as table rows/columns
 */
function parseTableContent(text: string): string[][] {
  const lines = text.split('\n').filter(l => l.trim());
  const rows: string[][] = [];

  for (const line of lines) {
    // Split by tabs or multiple spaces
    const cells = line.split(/\t|\s{3,}/).map(c => c.trim()).filter(c => c);
    if (cells.length >= 2) {
      rows.push(cells);
    } else if (line.trim()) {
      // Single cell - might be a header or continuation
      rows.push([line.trim()]);
    }
  }

  return rows.slice(0, 10); // Limit to 10 rows for display
}

const DOC_SHORT_NAMES: Record<string, { name: string; color: string }> = {};

// -----------------------------------------------------------------------------
// Source Citation Component
// -----------------------------------------------------------------------------

interface SourceCitationProps {
  citation: Citation;
  index: number;
}

function SourceCitation({ citation, index }: SourceCitationProps) {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(false);

  const pageDisplay = formatPageDisplay(citation, t);
  const sectionDisplay = formatSectionDisplay(citation);
  const isPageRange = (citation.startPage ?? citation.page) !== (citation.endPage ?? citation.page);
  const confidenceInfo = getConfidenceLevel(citation.confidence);
  const contentTypeInfo = getContentTypeInfo(citation.contentType);
  const docInfo = citation.documentName ? DOC_SHORT_NAMES[citation.documentName] : undefined;

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

          {/* Document badge */}
          {docInfo && (
            <Badge variant="outline" className={`text-[10px] px-1.5 py-0 h-4 shrink-0 ${docInfo.color}`}>
              {docInfo.name}
            </Badge>
          )}

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
              {t('dashboard.chat.range')}
            </Badge>
          )}

          {/* Content type badge (table/list) */}
          {contentTypeInfo && (
            <Badge variant="outline" className={`text-[10px] px-1.5 py-0 h-4 ${contentTypeInfo.color}`}>
              {contentTypeInfo.icon}
              <span className="ml-0.5">{t(contentTypeInfo.labelKey)}</span>
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
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 bg-violet-500/10 text-violet-600 border-violet-500/20 shrink-0">
              <CheckCircle2 className="h-2.5 w-2.5 mr-0.5" />
              {t('dashboard.chat.verified')}
            </Badge>
          )}

          {/* Confidence badge (show only if not verified) */}
          {!citation.isVerified && citation.confidence !== undefined && (
            <Badge
              variant="outline"
              className={`text-[10px] px-1.5 py-0 h-4 shrink-0 ${confidenceInfo.bgColor} ${confidenceInfo.color} ${confidenceInfo.borderColor}`}
            >
              {confidenceInfo.level === 'high' ? (
                <ShieldCheck className="h-2.5 w-2.5 mr-0.5" />
              ) : confidenceInfo.level === 'low' ? (
                <AlertCircle className="h-2.5 w-2.5 mr-0.5" />
              ) : null}
              {citation.confidence}%
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
        <div className="px-3 py-3 border-t border-border bg-muted/30 space-y-3">
          {/* Section title if present */}
          {citation.sectionTitle && (
            <div className="text-xs text-muted-foreground">
              <span className="font-medium">{t('dashboard.chat.section', { section: '' }).replace(/[:：\s]+$/, '')}:</span> {citation.sectionTitle}
            </div>
          )}

          {/* Rich Excerpt - renders tables/lists with formatting */}
          <RichExcerpt excerpt={citation.excerpt} contentType={citation.contentType} />

          {/* Footer with confidence and relevance */}
          <div className="flex items-center justify-between gap-4 pt-2 border-t border-border/50">
            <div className="flex items-center gap-4 flex-1">
              {/* Confidence bar */}
              {citation.confidence !== undefined && (
                <div className="flex items-center gap-2 flex-1">
                  <span className="text-[10px] text-muted-foreground/70 shrink-0">
                    {t('permits.compliance.overall')}:
                  </span>
                  <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden max-w-[100px]">
                    <div
                      className={`h-full rounded-full transition-all ${citation.confidence >= 70 ? 'bg-violet-500' :
                          citation.confidence >= 40 ? 'bg-yellow-500' : 'bg-orange-500'
                        }`}
                      style={{ width: `${citation.confidence}%` }}
                    />
                  </div>
                  <span className={`text-[10px] font-medium ${confidenceInfo.color}`}>
                    {citation.confidence}%
                  </span>
                </div>
              )}

              {/* Relevance score */}
              {citation.similarity !== undefined && citation.similarity > 0 && (
                <span className="text-[10px] text-muted-foreground/70">
                  {Math.round(citation.similarity * 100)}%
                </span>
              )}
            </div>
          </div>
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
  const { t } = useTranslation();
  const [showAll, setShowAll] = useState(false);

  if (!citations || citations.length === 0) {
    return null;
  }

  // Sort by verified first, then by confidence, then by page number
  const sortedCitations = [...citations].sort((a, b) => {
    // Verified first
    if (a.isVerified && !b.isVerified) return -1;
    if (!a.isVerified && b.isVerified) return 1;
    // Then by confidence
    const confA = a.confidence ?? 0;
    const confB = b.confidence ?? 0;
    if (confA !== confB) return confB - confA;
    // Then by page
    return (a.startPage ?? a.page) - (b.startPage ?? b.page);
  });

  const displayedCitations = showAll ? sortedCitations : sortedCitations.slice(0, 3);
  const hasMore = sortedCitations.length > 3;
  const verifiedCount = sortedCitations.filter(c => c.isVerified).length;
  const highConfidenceCount = sortedCitations.filter(c => (c.confidence ?? 0) >= 70).length;

  return (
    <div className="mt-3 space-y-2">
      {/* Sources Header with border */}
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-card/80 border border-border/60">
        <div className="flex items-center justify-center w-5 h-5 rounded-md bg-violet-500/15">
          <BookOpen className="h-3 w-3 text-violet-500" />
        </div>
        <span className="text-xs font-medium text-foreground">{t('dashboard.chat.sources')}</span>
        <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 bg-muted text-muted-foreground border-border">
          {citations.length}
        </Badge>
        {verifiedCount > 0 && (
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 bg-violet-500/10 text-violet-600 border-violet-500/20 ml-auto">
            <CheckCircle2 className="h-2.5 w-2.5 mr-0.5" />
            {t('dashboard.chat.verifiedCount', { count: verifiedCount })}
          </Badge>
        )}
        {highConfidenceCount > 0 && !verifiedCount && (
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 bg-blue-500/10 text-blue-600 border-blue-500/20 ml-auto">
            <ShieldCheck className="h-2.5 w-2.5 mr-0.5" />
            {t('dashboard.chat.highConfidenceCount', { count: highConfidenceCount })}
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
              {t('dashboard.chat.showLess')}
            </>
          ) : (
            <>
              <ChevronDown className="h-3 w-3 mr-1" />
              {t('dashboard.chat.showMoreSources', { count: citations.length - 3 })}
            </>
          )}
        </Button>
      )}
    </div>
  );
}
