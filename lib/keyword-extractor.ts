// ============================================================================
// Keyword Extractor — TF-IDF based keyword extraction from PDF text (0 API)
// Used during ingestion to auto-populate document_registry.keywords
// ============================================================================

import type { PDFPageContent } from '@/types';

// -----------------------------------------------------------------------------
// Stopwords — common English words + PDF noise
// -----------------------------------------------------------------------------

const STOPWORDS = new Set([
  // Common English
  'the', 'be', 'to', 'of', 'and', 'a', 'in', 'that', 'have', 'i',
  'it', 'for', 'not', 'on', 'with', 'he', 'as', 'you', 'do', 'at',
  'this', 'but', 'his', 'by', 'from', 'they', 'we', 'say', 'her', 'she',
  'or', 'an', 'will', 'my', 'one', 'all', 'would', 'there', 'their',
  'what', 'so', 'up', 'out', 'if', 'about', 'who', 'get', 'which',
  'go', 'me', 'when', 'make', 'can', 'like', 'time', 'no', 'just',
  'him', 'know', 'take', 'people', 'into', 'year', 'your', 'good',
  'some', 'could', 'them', 'see', 'other', 'than', 'then', 'now',
  'look', 'only', 'come', 'its', 'over', 'think', 'also', 'back',
  'after', 'use', 'two', 'how', 'our', 'work', 'first', 'well',
  'way', 'even', 'new', 'want', 'because', 'any', 'these', 'give',
  'day', 'most', 'us', 'are', 'is', 'was', 'were', 'been', 'has',
  'had', 'did', 'does', 'may', 'must', 'shall', 'should', 'such',
  'each', 'every', 'both', 'few', 'more', 'many', 'much', 'own',
  'same', 'per', 'via', 'etc', 'where', 'when', 'here', 'very',
  'being', 'those', 'between', 'through', 'during', 'before',
  'above', 'below', 'under', 'again', 'further', 'once',
  // PDF noise
  'page', 'table', 'figure', 'chapter', 'section', 'part', 'annex',
  'appendix', 'contents', 'index', 'note', 'notes', 'reference',
  'references', 'amendment', 'edition', 'version', 'date', 'issued',
  'revised', 'document', 'number', 'item', 'items', 'list', 'type',
  'types', 'class', 'group', 'category', 'general', 'specific',
  'following', 'based', 'including', 'included', 'within', 'without',
  'using', 'used', 'according', 'applicable', 'apply', 'applied',
  'related', 'required', 'requirement', 'requirements', 'provided',
  'provide', 'provides', 'ensure', 'case', 'cases', 'conditions',
  'condition', 'accordance', 'comply', 'compliance', 'considered',
  'necessary', 'appropriate', 'minimum', 'maximum', 'less', 'greater',
  'equal', 'total', 'area', 'areas', 'level', 'levels',
]);

// -----------------------------------------------------------------------------
// Category Detection Rules
// -----------------------------------------------------------------------------

const CATEGORY_RULES: Array<{ category: string; triggers: string[] }> = [
  { category: 'structural', triggers: ['structural', 'foundation', 'concrete', 'steel', 'load', 'seismic', 'beam', 'column'] },
  { category: 'safety', triggers: ['fire', 'safety', 'egress', 'evacuation', 'alarm', 'sprinkler', 'smoke', 'emergency'] },
  { category: 'fire', triggers: ['fire', 'fire-resistance', 'firewall', 'fire-rated', 'combustible', 'flammable'] },
  { category: 'environmental', triggers: ['green', 'energy', 'solar', 'renewable', 'sustainability', 'carbon', 'emission'] },
  { category: 'energy', triggers: ['energy', 'efficiency', 'hvac', 'cooling', 'thermal', 'insulation', 'lighting'] },
  { category: 'accessibility', triggers: ['accessibility', 'wheelchair', 'disability', 'ramp', 'tactile', 'braille', 'inclusive'] },
  { category: 'mep', triggers: ['plumbing', 'electrical', 'mechanical', 'hvac', 'piping', 'ductwork', 'wiring'] },
  { category: 'plumbing', triggers: ['sewerage', 'sewer', 'drainage', 'plumbing', 'pipe', 'wastewater', 'stormwater'] },
  { category: 'parking', triggers: ['parking', 'garage', 'vehicle', 'car park', 'ramp'] },
  { category: 'construction', triggers: ['construction', 'building', 'permit', 'inspection', 'contractor'] },
  { category: 'general', triggers: ['building', 'code', 'regulation', 'standard', 'guideline'] },
];

// -----------------------------------------------------------------------------
// TF-IDF Extraction
// -----------------------------------------------------------------------------

interface ExtractionResult {
  keywords: string[];
  categories: string[];
}

/**
 * Extract keywords from parsed PDF pages using TF-IDF scoring.
 * Returns top 40 keywords and detected categories.
 * 0 API calls — pure text analysis.
 */
export function extractKeywords(pages: PDFPageContent[], maxKeywords: number = 40): ExtractionResult {
  // Concatenate all page text
  const fullText = pages.map(p => p.text).join(' ');

  // Tokenize
  const tokens = tokenize(fullText);

  if (tokens.length === 0) {
    return { keywords: [], categories: [] };
  }

  // Calculate term frequency
  const tf = new Map<string, number>();
  for (const token of tokens) {
    tf.set(token, (tf.get(token) || 0) + 1);
  }

  // Calculate TF-IDF-like score
  // Since we have a single document, we use term frequency + length bonus
  // Longer, more specific terms get higher scores
  const scores = new Map<string, number>();

  for (const [term, count] of tf) {
    // Minimum frequency threshold — must appear at least 3 times
    if (count < 3) continue;

    // TF component: log-normalized
    const tfScore = 1 + Math.log(count);

    // Length bonus: longer terms are more specific/meaningful
    const lengthBonus = term.length > 7 ? 1.5 : term.length > 5 ? 1.2 : 1.0;

    // Hyphenated compound terms get a bonus (e.g., "fire-resistance")
    const compoundBonus = term.includes('-') ? 1.3 : 1.0;

    // Penalize very high frequency terms (likely generic)
    const frequencyPenalty = count > tokens.length * 0.05 ? 0.5 : 1.0;

    scores.set(term, tfScore * lengthBonus * compoundBonus * frequencyPenalty);
  }

  // Sort by score descending and take top N
  const sorted = Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxKeywords)
    .map(([term]) => term);

  // Detect categories
  const categories = detectCategories(sorted);

  return { keywords: sorted, categories };
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    // Keep hyphens within words (e.g., "fire-resistance")
    .replace(/[^a-z0-9\s-]/g, ' ')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .split(' ')
    .map(t => t.replace(/^-+|-+$/g, '')) // trim leading/trailing hyphens
    .filter(t =>
      t.length >= 3 &&
      t.length <= 30 &&
      !STOPWORDS.has(t) &&
      !/^\d+$/.test(t) // no pure numbers
    );
}

function detectCategories(keywords: string[]): string[] {
  const matched = new Set<string>();

  for (const rule of CATEGORY_RULES) {
    const hits = rule.triggers.filter(t => keywords.some(k => k.includes(t) || t.includes(k)));
    if (hits.length >= 2) {
      matched.add(rule.category);
    }
  }

  return Array.from(matched);
}
