// ============================================================================
// PDF Parser with PDF.js - Precise Page Tracking & TOC Extraction
// ============================================================================

// Use legacy build for Node.js environment (no DOM required)
// @ts-expect-error - pdfjs-dist types don't match the legacy build exactly
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf';
import type { 
  TOCEntry, 
  DocumentStructure, 
  PDFPageContent, 
  TextItem
} from '@/types';

// Disable worker for Node.js environment
pdfjsLib.GlobalWorkerOptions.workerSrc = '';

// -----------------------------------------------------------------------------
// Types for PDF.js internal structures
// -----------------------------------------------------------------------------

interface PDFOutlineItem {
  title: string;
  dest: string | unknown[] | null;
  items?: PDFOutlineItem[];
}

interface PDFTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  fontName?: string;
}

// -----------------------------------------------------------------------------
// Main PDF Parser Class
// -----------------------------------------------------------------------------

export class PDFParser {
  private pdfPath: string;
  private document: pdfjsLib.PDFDocumentProxy | null = null;
  private structure: DocumentStructure | null = null;

  constructor(pdfPath: string) {
    this.pdfPath = pdfPath;
  }

  /**
   * Load and parse the PDF document
   */
  async load(): Promise<void> {
    const data = await this.loadPDFData();
    this.document = await pdfjsLib.getDocument({ data }).promise;
  }

  /**
   * Load PDF data from file system
   */
  private async loadPDFData(): Promise<Uint8Array> {
    const fs = await import('fs');
    const buffer = fs.readFileSync(this.pdfPath);
    return new Uint8Array(buffer);
  }

  /**
   * Get total number of pages
   */
  get totalPages(): number {
    return this.document?.numPages ?? 0;
  }

  // ---------------------------------------------------------------------------
  // TOC (Table of Contents) Extraction
  // ---------------------------------------------------------------------------

  /**
   * Extract Table of Contents from PDF bookmarks/outlines
   * Returns hierarchical structure with page numbers
   */
  async extractTOC(): Promise<DocumentStructure> {
    if (!this.document) {
      throw new Error('PDF not loaded. Call load() first.');
    }

    const outline = await this.document.getOutline();
    const toc: TOCEntry[] = [];
    const flatTOC: TOCEntry[] = [];

    if (outline) {
      await this.processOutline(outline, toc, flatTOC, 0);
    }

    // If no bookmarks, try to detect sections from content
    if (toc.length === 0) {
      console.log('No PDF bookmarks found. Attempting to detect sections from content...');
      const detectedTOC = await this.detectSectionsFromContent();
      toc.push(...detectedTOC);
      flatTOC.push(...this.flattenTOC(detectedTOC));
    }

    this.structure = {
      totalPages: this.totalPages,
      toc,
      flatTOC: flatTOC.sort((a, b) => a.pageNumber - b.pageNumber),
    };

    return this.structure;
  }

  /**
   * Process PDF outline recursively
   */
  private async processOutline(
    items: PDFOutlineItem[],
    toc: TOCEntry[],
    flatTOC: TOCEntry[],
    level: number
  ): Promise<void> {
    for (const item of items) {
      let pageNumber = 1;

      // Resolve destination to page number
      if (item.dest) {
        try {
          pageNumber = await this.resolveDestination(item.dest);
        } catch (e) {
          console.warn(`Could not resolve destination for "${item.title}":`, e);
        }
      }

      // Extract section number from title (e.g., "3.2.1 Fire Safety" -> "3.2.1")
      const sectionMatch = item.title.match(/^(\d+(?:\.\d+)*)/);
      const section = sectionMatch ? sectionMatch[1] : undefined;

      const entry: TOCEntry = {
        title: item.title.trim(),
        pageNumber,
        level,
        section,
        children: [],
      };

      toc.push(entry);
      flatTOC.push(entry);

      // Process children recursively
      if (item.items && item.items.length > 0) {
        await this.processOutline(item.items, entry.children!, flatTOC, level + 1);
      }
    }
  }

  /**
   * Resolve PDF destination to page number
   */
  private async resolveDestination(dest: string | unknown[]): Promise<number> {
    if (!this.document) return 1;

    try {
      let resolvedDest: unknown[] | null = null;
      
      // If dest is a named destination, resolve it
      if (typeof dest === 'string') {
        resolvedDest = await this.document.getDestination(dest);
      } else if (Array.isArray(dest)) {
        resolvedDest = dest;
      }

      if (resolvedDest && Array.isArray(resolvedDest) && resolvedDest.length > 0) {
        const ref = resolvedDest[0];
        if (ref && typeof ref === 'object' && 'num' in ref && 'gen' in ref) {
          const pageIndex = await this.document.getPageIndex(ref as { num: number; gen: number });
          return pageIndex + 1; // Convert to 1-based
        }
      }
    } catch (e) {
      console.warn('Error resolving destination:', e);
    }

    return 1;
  }

  /**
   * Detect sections from content when no bookmarks available
   * Uses pattern matching for section headers
   */
  private async detectSectionsFromContent(): Promise<TOCEntry[]> {
    const entries: TOCEntry[] = [];
    
    // Patterns for section detection
    const sectionPatterns = [
      /^(Chapter\s+\d+)[:\s]+(.+)/i,
      /^(\d+\.\d+(?:\.\d+)?(?:\.\d+)?)\s+([A-Z][^.]+)/m,
      /^(CHAPTER\s+\d+)/i,
      /^(SECTION\s+\d+(?:\.\d+)*)/i,
    ];

    for (let pageNum = 1; pageNum <= Math.min(this.totalPages, 50); pageNum++) {
      const pageContent = await this.getPageText(pageNum);
      const lines = pageContent.text.split('\n');

      for (const line of lines) {
        const trimmedLine = line.trim();
        
        for (const pattern of sectionPatterns) {
          const match = trimmedLine.match(pattern);
          if (match) {
            const title = match[2] ? `${match[1]} ${match[2]}` : match[1];
            const sectionMatch = match[1].match(/\d+(?:\.\d+)*/);
            
            entries.push({
              title: title.trim(),
              pageNumber: pageNum,
              level: this.getSectionLevel(match[1]),
              section: sectionMatch ? sectionMatch[0] : undefined,
            });
            break;
          }
        }
      }
    }

    return entries;
  }

  /**
   * Determine section level from section number
   */
  private getSectionLevel(sectionStr: string): number {
    if (/chapter/i.test(sectionStr)) return 0;
    const dotCount = (sectionStr.match(/\./g) || []).length;
    return dotCount + 1;
  }

  /**
   * Flatten TOC hierarchy for easy lookup
   */
  private flattenTOC(toc: TOCEntry[]): TOCEntry[] {
    const flat: TOCEntry[] = [];
    
    const flatten = (entries: TOCEntry[]) => {
      for (const entry of entries) {
        flat.push(entry);
        if (entry.children) {
          flatten(entry.children);
        }
      }
    };
    
    flatten(toc);
    return flat;
  }

  // ---------------------------------------------------------------------------
  // Page Content Extraction
  // ---------------------------------------------------------------------------

  /**
   * Extract text from a specific page with position info
   */
  async getPageText(pageNumber: number): Promise<PDFPageContent> {
    if (!this.document) {
      throw new Error('PDF not loaded. Call load() first.');
    }

    const page = await this.document.getPage(pageNumber);
    const textContent = await page.getTextContent();
    
    const textItems: TextItem[] = [];
    let fullText = '';
    let lastY: number | null = null;

    for (const item of textContent.items) {
      const textItem = item as PDFTextItem;
      
      // Add newline if Y position changed significantly (new line)
      if (lastY !== null && Math.abs(textItem.transform[5] - lastY) > 5) {
        fullText += '\n';
      }
      
      fullText += textItem.str;
      lastY = textItem.transform[5];

      textItems.push({
        text: textItem.str,
        x: textItem.transform[4],
        y: textItem.transform[5],
        width: textItem.width,
        height: textItem.height,
        fontName: textItem.fontName,
      });
    }

    return {
      pageNumber,
      text: fullText.trim(),
      textItems,
    };
  }

  /**
   * Extract text from all pages
   */
  async getAllPagesText(): Promise<PDFPageContent[]> {
    const pages: PDFPageContent[] = [];
    
    for (let i = 1; i <= this.totalPages; i++) {
      const pageContent = await this.getPageText(i);
      if (pageContent.text.length > 0) {
        pages.push(pageContent);
      }
    }
    
    return pages;
  }

  // ---------------------------------------------------------------------------
  // Section Mapping
  // ---------------------------------------------------------------------------

  /**
   * Find the section for a given page number using TOC
   * Returns the most specific (deepest) section that contains this page
   */
  findSectionForPage(pageNumber: number): {
    section?: string;
    sectionTitle?: string;
    sectionPath: string[];
    chapter?: string;
  } {
    if (!this.structure || this.structure.flatTOC.length === 0) {
      return { sectionPath: [] };
    }

    const flatTOC = this.structure.flatTOC;
    let currentSection: TOCEntry | null = null;

    // Find the section that starts on or before this page
    for (const entry of flatTOC) {
      if (entry.pageNumber <= pageNumber) {
        currentSection = entry;
      } else {
        break; // TOC is sorted, so we can stop
      }
    }

    if (!currentSection) {
      return { sectionPath: [] };
    }

    // Build section path by finding parent sections
    const buildPath = (targetPage: number): string[] => {
      const path: string[] = [];
      const lastEntryAtLevel: Map<number, TOCEntry> = new Map();

      for (const entry of flatTOC) {
        if (entry.pageNumber <= targetPage) {
          lastEntryAtLevel.set(entry.level, entry);
        } else {
          break;
        }
      }

      // Build path from level 0 upwards
      const levels = Array.from(lastEntryAtLevel.keys()).sort((a, b) => a - b);
      for (const level of levels) {
        const entry = lastEntryAtLevel.get(level);
        if (entry) {
          path.push(entry.title);
        }
      }

      return path;
    };

    const path = buildPath(pageNumber);
    const chapter = path.find(p => /chapter/i.test(p));

    return {
      section: currentSection.section,
      sectionTitle: currentSection.title,
      sectionPath: path,
      chapter,
    };
  }

  /**
   * Determine if text content contains a table
   */
  detectTable(text: string): boolean {
    // Multiple indicators of table content
    const tableIndicators = [
      /Table\s+\d+[-.]?\d*/i,           // "Table 4.1" or "Table 4-1"
      /\|[^|]+\|/,                       // Markdown-style table
      /\t[^\t]+\t/,                      // Tab-separated content
      /^\s*\d+\.\s+.+\s+\d+\.\s+/m,     // Numbered list columns
      /(?:\s{3,}|\t)\S+(?:\s{3,}|\t)\S+/m, // Multiple column spacing
    ];

    let score = 0;
    for (const indicator of tableIndicators) {
      if (indicator.test(text)) {
        score++;
      }
    }

    // Also check for multiple numeric values on same line (common in tables)
    const numericLines = text.split('\n').filter(line => 
      (line.match(/\d+\.?\d*/g) || []).length >= 3
    );
    if (numericLines.length >= 2) {
      score++;
    }

    return score >= 2;
  }

  /**
   * Detect content type (text, table, list, heading)
   */
  detectContentType(text: string): 'text' | 'table' | 'list' | 'heading' {
    // Check for table first
    if (this.detectTable(text)) {
      return 'table';
    }

    // Check for list (numbered or bulleted)
    const listPattern = /^[\s]*(?:\d+\.|[•\-\*])\s+/m;
    const listLines = text.split('\n').filter(line => listPattern.test(line));
    if (listLines.length >= 2) {
      return 'list';
    }

    // Check for heading (short, capitalized, may have section number)
    if (text.length < 200) {
      const lines = text.split('\n').filter(l => l.trim());
      if (lines.length <= 2) {
        const firstLine = lines[0] || '';
        if (/^(?:\d+\.)+\d*\s+[A-Z]/.test(firstLine) || /^[A-Z\s]{10,}$/.test(firstLine)) {
          return 'heading';
        }
      }
    }

    return 'text';
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Get document structure (must call extractTOC first)
   */
  getStructure(): DocumentStructure | null {
    return this.structure;
  }

  /**
   * Close the document and free resources
   */
  async close(): Promise<void> {
    if (this.document) {
      await this.document.destroy();
      this.document = null;
    }
  }
}

// -----------------------------------------------------------------------------
// Utility Functions
// -----------------------------------------------------------------------------

/**
 * Create a PDF parser instance and load the document
 */
export async function createPDFParser(pdfPath: string): Promise<PDFParser> {
  const parser = new PDFParser(pdfPath);
  await parser.load();
  return parser;
}

/**
 * Format page range for display
 * @example formatPageRange(45, 45) => "Page 45"
 * @example formatPageRange(45, 46) => "Pages 45-46"
 */
export function formatPageRange(startPage: number, endPage: number): string {
  if (startPage === endPage) {
    return `Page ${startPage}`;
  }
  return `Pages ${startPage}-${endPage}`;
}

/**
 * Extract section number from text
 * @example "3.2.1 Fire Safety" => "3.2.1"
 */
export function extractSectionNumber(text: string): string | undefined {
  const match = text.match(/^(\d+(?:\.\d+)+)/);
  return match ? match[1] : undefined;
}
