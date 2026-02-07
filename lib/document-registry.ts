// ============================================================================
// Document Registry - Central registry of all ingested documents
// ============================================================================

export interface DocumentInfo {
  /** Unique identifier used in database (document_name column) */
  id: string;
  /** Human-readable display name */
  displayName: string;
  /** Short abbreviation for UI badges */
  shortName: string;
  /** Filename in public/ folder */
  fileName: string;
  /** Original source URL for attribution */
  sourceUrl: string;
  /** Publishing authority */
  authority: string;
  /** Brief description */
  description: string;
  /** Color for UI badges (tailwind class) */
  badgeColor: string;
}

// -----------------------------------------------------------------------------
// Document Registry
// -----------------------------------------------------------------------------

export const DOCUMENT_REGISTRY: Record<string, DocumentInfo> = {
  'dubai-building-code-2021': {
    id: 'dubai-building-code-2021',
    displayName: 'Dubai Building Code 2021',
    shortName: 'DBC',
    fileName: 'dubai-code.pdf',
    sourceUrl: 'https://dm.gov.ae/wp-content/uploads/2021/12/Dubai%20Building%20Code_English_2021%20Edition_compressed.pdf',
    authority: 'Dubai Municipality',
    description: 'Comprehensive building regulations for construction in Dubai',
    badgeColor: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  },
  'code-of-safety': {
    id: 'code-of-safety',
    displayName: 'Dubai Code of Safety',
    shortName: 'Safety',
    fileName: 'code_of_safety_EN.pdf',
    sourceUrl: 'https://www.dm.gov.ae/wp-content/uploads/2022/04/code_of_safety_EN.pdf',
    authority: 'Dubai Municipality',
    description: 'Safety regulations and requirements for buildings in Dubai',
    badgeColor: 'bg-red-500/20 text-red-400 border-red-500/30',
  },
  'al-safat-green-building': {
    id: 'al-safat-green-building',
    displayName: 'Al Sa\'fat Green Building System (2nd Ed, 2023)',
    shortName: 'Al Sa\'fat',
    fileName: 'Al-Safat-–-Dubai-Green-Building-System-2nd-editionJan2023.pdf',
    sourceUrl: 'https://www.dm.gov.ae/wp-content/uploads/2023/01/Al-Safat-%E2%80%93-Dubai-Green-Building-System-2nd-editionJan2023.pdf',
    authority: 'Dubai Municipality',
    description: 'Mandatory green building rating system with Silver, Gold, and Platinum tiers',
    badgeColor: 'bg-green-500/20 text-green-400 border-green-500/30',
  },
  'universal-design-code': {
    id: 'universal-design-code',
    displayName: 'Dubai Universal Design Code',
    shortName: 'UDC',
    fileName: 'Dubai-Guide-for-Built-Environment-Universal-Design-1_compressed.pdf',
    sourceUrl: 'https://www.dm.gov.ae/wp-content/uploads/2020/11/Dubai-Guide-for-Built-Environment-Universal-Design-1_compressed.pdf',
    authority: 'Dubai Municipality',
    description: 'Accessibility and universal design requirements for the built environment',
    badgeColor: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
  },
  'sewerage-stormwater-guidelines': {
    id: 'sewerage-stormwater-guidelines',
    displayName: 'Sewerage & Stormwater Design Guidelines (2025)',
    shortName: 'Sewerage',
    fileName: 'comp-DM_Sewerage-Guidelines-F.24.01.25.pdf',
    sourceUrl: 'https://www.dm.gov.ae/wp-content/uploads/2025/01/comp-DM_Sewerage-Guidelines-F.24.01.25.pdf',
    authority: 'Dubai Municipality',
    description: 'Technical guidelines for sewerage and stormwater drainage design',
    badgeColor: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30',
  },
};

// -----------------------------------------------------------------------------
// Helper Functions
// -----------------------------------------------------------------------------

/** Get all registered documents as array */
export function getAllDocuments(): DocumentInfo[] {
  return Object.values(DOCUMENT_REGISTRY);
}

/** Get document info by ID */
export function getDocumentById(id: string): DocumentInfo | undefined {
  return DOCUMENT_REGISTRY[id];
}

/** Get document info by filename */
export function getDocumentByFileName(fileName: string): DocumentInfo | undefined {
  return Object.values(DOCUMENT_REGISTRY).find(doc => doc.fileName === fileName);
}

/** Get PDF path for a document */
export function getDocumentPdfPath(docId: string): string {
  const doc = DOCUMENT_REGISTRY[docId];
  if (!doc) throw new Error(`Unknown document: ${docId}`);
  return `public/${doc.fileName}`;
}

/** Get all document IDs */
export function getAllDocumentIds(): string[] {
  return Object.keys(DOCUMENT_REGISTRY);
}

/** Build a display string listing all available documents */
export function getDocumentListForPrompt(): string {
  return Object.values(DOCUMENT_REGISTRY)
    .map(doc => `- ${doc.displayName} (${doc.authority})`)
    .join('\n');
}
