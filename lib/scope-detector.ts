// ============================================================================
// Scope Detector — Regex-based page/section range detection (0 API)
// Replaces the two-path Tree Reasoning classifier with a simpler filter approach
// ============================================================================

import type { PageRange } from '@/lib/rag';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface ScopeFilter {
  hasScope: boolean;
  pageRanges: PageRange[];
  sections: string[];
}

// -----------------------------------------------------------------------------
// Scope Detection
// -----------------------------------------------------------------------------

/**
 * Detect if a query references specific sections, chapters, or page ranges.
 * Returns filter parameters that can be applied to hybrid search.
 *
 * Examples:
 *   "in chapter 3" → pageRanges from tree for chapter 3
 *   "section 4.2.1" → section filter
 *   "page 45" → page range 45-45
 *
 * 0 API calls, ~1ms
 */
export function detectScope(query: string): ScopeFilter {
  const sections: string[] = [];
  const pageRanges: PageRange[] = [];

  // Extract section numbers (e.g., "section 3.2.1", "3.2.1")
  const sectionMatches = query.matchAll(/\b(?:section|§)\s*([\d]+(?:\.[\d]+)*)\b/gi);
  for (const match of sectionMatches) {
    sections.push(match[1]);
  }

  // Standalone section numbers like "4.2.1" (3+ digits with dots)
  const standaloneSections = query.matchAll(/\b(\d+\.\d+(?:\.\d+)+)\b/g);
  for (const match of standaloneSections) {
    if (!sections.includes(match[1])) {
      sections.push(match[1]);
    }
  }

  // Extract explicit page references
  const pageMatches = query.matchAll(/\bpages?\s+(\d+)(?:\s*[-–to]\s*(\d+))?\b/gi);
  for (const match of pageMatches) {
    const start = parseInt(match[1], 10);
    const end = match[2] ? parseInt(match[2], 10) : start;
    pageRanges.push({ startPage: start, endPage: end });
  }

  // Chapter references → will be resolved to page ranges via tree later
  const chapterMatches = query.matchAll(/\bchapter\s+(\d+)\b/gi);
  for (const match of chapterMatches) {
    sections.push(match[1]);
  }

  const hasScope = sections.length > 0 || pageRanges.length > 0;

  return { hasScope, pageRanges, sections };
}
