// ============================================================================
// Document Selector — Keyword-based document scoring (v2 Pipeline, 0 API)
// Scores query against each document's keywords to narrow search scope
// ============================================================================

import { DOCUMENT_REGISTRY, type DocumentInfo } from '@/lib/document-registry';

// -----------------------------------------------------------------------------
// Document Keywords & Categories
// -----------------------------------------------------------------------------

interface DocumentSearchProfile {
  keywords: string[];
  categories: string[];
}

const DOCUMENT_PROFILES: Record<string, DocumentSearchProfile> = {
  'dubai-building-code-2021': {
    keywords: [
      'building', 'code', 'construction', 'parking', 'height', 'setback',
      'floor', 'area', 'ratio', 'plot', 'structural', 'foundation',
      'concrete', 'steel', 'load', 'seismic', 'occupancy', 'classification',
      'permit', 'inspection', 'glazing', 'facade', 'cladding', 'roofing',
      'insulation', 'waterproofing', 'balcony', 'basement', 'podium',
      'tower', 'corridor', 'stairway', 'ramp', 'high-rise', 'low-rise',
      'residential', 'commercial', 'industrial', 'mixed-use', 'villa',
      'apartment', 'office', 'retail', 'hotel', 'warehouse',
    ],
    categories: ['structural', 'general', 'parking', 'construction'],
  },
  'code-of-safety': {
    keywords: [
      'safety', 'fire', 'egress', 'exit', 'stair', 'alarm', 'smoke',
      'sprinkler', 'detector', 'extinguisher', 'evacuation', 'emergency',
      'firewall', 'fire-resistance', 'fire-rated', 'fire-separation',
      'escape', 'refuge', 'hazard', 'flammable', 'combustible',
      'fire-fighting', 'hydrant', 'hose', 'suppression', 'compartment',
    ],
    categories: ['safety', 'fire', 'emergency'],
  },
  'al-safat-green-building': {
    keywords: [
      'green', 'safat', 'sa\'fat', 'energy', 'efficiency', 'solar',
      'renewable', 'sustainability', 'environment', 'carbon', 'emission',
      'water', 'conservation', 'recycling', 'waste', 'landscape',
      'vegetation', 'thermal', 'insulation', 'hvac', 'cooling',
      'lighting', 'daylight', 'silver', 'gold', 'platinum', 'rating',
      'tier', 'indoor', 'air quality', 'material', 'leed',
    ],
    categories: ['environmental', 'energy', 'green'],
  },
  'universal-design-code': {
    keywords: [
      'accessibility', 'universal', 'design', 'disability', 'wheelchair',
      'ramp', 'handrail', 'tactile', 'braille', 'signage', 'elevator',
      'lift', 'restroom', 'toilet', 'washroom', 'door', 'width',
      'clearance', 'reach', 'grab bar', 'accessible', 'determination',
      'inclusive', 'mobility', 'visual', 'hearing', 'impairment',
    ],
    categories: ['accessibility', 'universal-design'],
  },
  'sewerage-stormwater-guidelines': {
    keywords: [
      'sewerage', 'sewer', 'stormwater', 'drainage', 'plumbing',
      'pipe', 'manhole', 'pumping', 'station', 'wastewater', 'effluent',
      'grease', 'trap', 'interceptor', 'backflow', 'valve', 'vent',
      'fixture', 'sanitary', 'rainwater', 'runoff', 'catchment',
      'flood', 'retention', 'infiltration', 'outfall', 'tss',
    ],
    categories: ['mep', 'plumbing', 'drainage'],
  },
};

// -----------------------------------------------------------------------------
// Document Selection
// -----------------------------------------------------------------------------

interface DocumentScore {
  documentId: string;
  score: number;
  matchedKeywords: string[];
}

/**
 * Score query against each document's keyword profile.
 * Returns selected document IDs (or all if scores are close).
 *
 * - If top score >> others (>20% gap) → filter to top 1-3 docs
 * - If scores are close → search all (safe fallback)
 * - 0 API calls, runs in ~1ms
 */
export function selectDocuments(query: string): string[] {
  const queryLower = query.toLowerCase();
  const queryTokens = queryLower.split(/\s+/).filter(w => w.length > 2);

  const scores: DocumentScore[] = [];

  for (const [docId, profile] of Object.entries(DOCUMENT_PROFILES)) {
    let score = 0;
    const matched: string[] = [];

    for (const keyword of profile.keywords) {
      if (queryLower.includes(keyword)) {
        score += keyword.length > 5 ? 3 : 2;  // Longer keywords = stronger signal
        matched.push(keyword);
      }
    }

    // Token overlap bonus
    for (const token of queryTokens) {
      for (const keyword of profile.keywords) {
        if (keyword.includes(token) && !matched.includes(keyword)) {
          score += 1;
        }
      }
    }

    scores.push({ documentId: docId, score, matchedKeywords: matched });
  }

  // Sort by score descending
  scores.sort((a, b) => b.score - a.score);

  const topScore = scores[0]?.score || 0;

  // No matches → search all documents
  if (topScore === 0) {
    return getAllDocumentIds();
  }

  // Check if there's a clear winner (>20% gap to second)
  const threshold = topScore * 0.8;
  const selected = scores.filter(s => s.score >= threshold && s.score > 0);

  // If too many docs selected, just search all
  if (selected.length >= 4) {
    return getAllDocumentIds();
  }

  return selected.map(s => s.documentId);
}

/**
 * Get all document IDs from registry
 */
function getAllDocumentIds(): string[] {
  return Object.keys(DOCUMENT_REGISTRY);
}

/**
 * Get display names for selected documents (for logging)
 */
export function getSelectedDocumentNames(docIds: string[]): string[] {
  return docIds.map(id => {
    const doc = DOCUMENT_REGISTRY[id] as DocumentInfo | undefined;
    return doc?.shortName || id;
  });
}
