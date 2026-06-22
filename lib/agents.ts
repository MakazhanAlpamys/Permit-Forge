// ============================================================================
// AI Agents for RAG Pipeline
// Removed: expandQuery, rerankChunks, verifyAnswer (replaced by heuristic/CRAG)
// Kept: classifyTopic, detectQueryType, classifyQueryStructure, treeReasoner
// ============================================================================

import { getChatModel } from '@/lib/gemini';
import { HumanMessage } from '@langchain/core/messages';
import type { TreeNode, TreeReasoningResult, QueryClassification } from '@/types';

// -----------------------------------------------------------------------------
// 0. TOPIC CLASSIFIER - Check if query is about building codes
// -----------------------------------------------------------------------------

const TOPIC_CLASSIFIER_PROMPT = `You are a query classifier for a building code compliance assistant.

Determine if the user's message is related to:
- Building codes, construction, architecture
- Parking requirements, fire safety, structural requirements
- Building permits, regulations, compliance
- Construction standards and building regulations
- Greetings or questions about what you can help with

The user may write in any language (English, Russian, Arabic, etc.). Classify based on meaning, not language.

OUTPUT FORMAT: Return ONLY one word:
- "ON_TOPIC" if the query is about building codes, construction, or asking what you can help with
- "OFF_TOPIC" if it's completely unrelated (cooking, sports, movies, personal questions, etc.)

Examples:
- "What are parking requirements?" → ON_TOPIC
- "Какие требования к парковке?" → ON_TOPIC
- "Hello" → ON_TOPIC
- "Привет" → ON_TOPIC
- "What can you help with?" → ON_TOPIC
- "How to make pasta?" → OFF_TOPIC
- "Who won the world cup?" → OFF_TOPIC

USER MESSAGE: `;

export interface TopicClassification {
  isOnTopic: boolean;
  shouldUseRAG: boolean;
}

/**
 * Quickly classify if the query is related to building codes
 * This saves API calls by skipping RAG for off-topic queries
 */
export async function classifyTopic(userQuery: string): Promise<TopicClassification> {
  // Quick patterns that are obviously on-topic (skip LLM call)
  const onTopicPatterns = [
    /parking/i, /fire\s*safety/i, /building/i, /floor/i, /height/i,
    /setback/i, /structure/i, /foundation/i, /permit/i, /code/i,
    /section\s*\d/i, /chapter\s*\d/i, /requirement/i, /regulation/i,
    /compliance/i, /construct/i, /architect/i, /MEP/i,
    /elevator/i, /stair/i, /exit/i, /egress/i, /ventilation/i,
    /plumbing/i, /electrical/i, /load/i, /concrete/i, /steel/i,
  ];

  for (const pattern of onTopicPatterns) {
    if (pattern.test(userQuery)) {
      return { isOnTopic: true, shouldUseRAG: true };
    }
  }

  // Greetings - on-topic but don't use RAG (EN / RU / KK)
  const greetingPatterns = [
    // English
    /^(hi+|hello+|hey+|hiya|yo|sup|greetings|good\s*(morning|afternoon|evening|day))[\s!?.,]*$/i,
    /^(what can you|how can you|what do you|can you help)/i,
    /^help[\s!?.]*$/i,
    // Russian
    /^(привет(ик|ствую|ики)?|здравствуй(те)?|здаров(а|о)?|здорово|хай|салют|добр(ый|ое|ой)\s*(день|утро|вечер|ночи)|доброго\s+времени\s+суток)[\s!?.,]*$/i,
    /^(что\s+ты\s+(можешь|умеешь)|чем\s+(ты\s+)?(можешь\s+)?(мне\s+)?помочь|кто\s+ты)[\s!?.,]*$/i,
    // Kazakh
    /^(сәлем(етсіз)?(дер)?(\s*бе)?(\s*ме)?|ассалаумағалейкум|ассалам|салам|сәлеметсіз\s*бе|қайырлы\s*(таң|күн|кеш))[\s!?.,]*$/i,
    /^(не(ні)?\s+(істей|жасай)\s+аласы[нң]|немен\s+көмектесе\s+аласы[нң]|сен\s+кімсің|кімсің)[\s!?.,]*$/i,
  ];

  for (const pattern of greetingPatterns) {
    if (pattern.test(userQuery.trim())) {
      return { isOnTopic: true, shouldUseRAG: false };
    }
  }

  // Use LLM for ambiguous cases
  try {
    const response = await getChatModel().invoke([
      new HumanMessage(TOPIC_CLASSIFIER_PROMPT + userQuery),
    ]);

    const rawContent = response.content;
    const content = (typeof rawContent === 'string'
      ? rawContent
      : Array.isArray(rawContent)
        ? rawContent.map(c => (typeof c === 'string' ? c : 'text' in c ? c.text : '')).join('')
        : String(rawContent)
    ).trim().toUpperCase();
    const isOnTopic = content.includes('ON_TOPIC');

    return { isOnTopic, shouldUseRAG: isOnTopic };
  } catch (error) {
    console.error('Topic classification error:', error);
    return { isOnTopic: true, shouldUseRAG: true };
  }
}

// -----------------------------------------------------------------------------
// 1. DETECT QUERY TYPE
// -----------------------------------------------------------------------------

export type QueryType = 'exact' | 'semantic' | 'hybrid';

/**
 * Single source of truth for "does this query name a specific code reference"
 * (section, table, chapter, article, clause, requirement, page, or a dotted
 * numeric like 5.4.2). Used here by detectQueryType and by lib/rag.ts to gate
 * the exact-search branch. (F14 / Simplify #14)
 */
export const EXACT_REFERENCE_REGEX =
  /\bsection\s+[\d.]+|\btable\s+[\d-]+|\bchapter\s+\d+|\barticle\s+\d+|\bclause\s+[\d.]+|\brequirement\s+[\d.]+|\bpage\s+\d+|\b\d+\.\d+\.\d+\b/i;

export function detectQueryType(query: string): QueryType {
  if (EXACT_REFERENCE_REGEX.test(query)) return 'exact';
  return 'hybrid';
}

// -----------------------------------------------------------------------------
// 2. TREE REASONING - Structure-Aware Search
// -----------------------------------------------------------------------------

const TOPIC_KEYWORDS = [
  'parking', 'fire', 'safety', 'structural', 'electrical', 'plumbing',
  'egress', 'ventilation', 'elevator', 'stair', 'exit', 'accessibility',
  'foundation', 'seismic', 'load', 'concrete', 'steel', 'glazing',
  'facade', 'drainage', 'sanitary', 'hvac', 'mechanical', 'lighting',
  'insulation', 'waterproofing', 'cladding', 'roofing', 'setback',
  'height', 'occupancy', 'classification', 'permit', 'inspection',
  'mep', 'duct', 'sprinkler', 'alarm', 'smoke', 'corridor',
  'stairway', 'ramp', 'balcony', 'basement', 'podium', 'tower',
  'swimming', 'pool', 'generator', 'transformer', 'gas', 'lpg',
  'refrigerant', 'boiler', 'chiller', 'ahu', 'bms',
];

const BUILDING_TYPE_KEYWORDS = [
  'residential', 'commercial', 'industrial', 'high-rise', 'high rise',
  'low-rise', 'low rise', 'mid-rise', 'mid rise', 'mixed-use', 'mixed use',
  'office', 'retail', 'hotel', 'hospital', 'school', 'mosque',
  'warehouse', 'assembly', 'educational', 'institutional', 'mercantile',
  'storage', 'hazardous', 'business', 'factory', 'laboratory',
  'multi-storey', 'single-storey', 'villa', 'townhouse', 'apartment',
];

/**
 * Detect if a query would benefit from Tree Reasoning
 * Uses fast pattern matching - NO LLM call
 */
export function classifyQueryStructure(query: string): QueryClassification {
  const structuralPatterns = [
    { pattern: /\b(in|from|within)\s+(chapter|section|part)\s+\d/i, hint: 'section_reference' },
    { pattern: /\bsummarize\s+(chapter|section|the\s+\w+\s+section)/i, hint: 'summarize_section' },
    { pattern: /\b(chapter|section)\s+\d+\s+(content|requirements|says|states)/i, hint: 'section_content' },
    { pattern: /\bwhat('s| is| are)\s+(in|under)\s+(chapter|section|the)/i, hint: 'whats_in_section' },
    { pattern: /\bcompare\s+.+\s+(and|with|to|vs)/i, hint: 'comparison' },
    { pattern: /\bdifference\s+between\s+.+\s+and/i, hint: 'comparison' },
    { pattern: /\bhow\s+(does|do)\s+.+\s+differ/i, hint: 'comparison' },
    { pattern: /\b(residential|commercial|industrial|high-rise|low-rise|mixed-use|hotel|hospital|school|warehouse|office|retail|assembly|villa|apartment)\s+.*(requirement|section|building|code|standard|regulation|rule|compliance)/i, hint: 'contextual' },
    { pattern: new RegExp(`\\b(${TOPIC_KEYWORDS.join('|')})\\b.*\\b(for|in)\\s+(${BUILDING_TYPE_KEYWORDS.join('|')})\\b`, 'i'), hint: 'contextual' },
    { pattern: new RegExp(`\\b(${BUILDING_TYPE_KEYWORDS.join('|')})\\b.*\\b(${TOPIC_KEYWORDS.join('|')})\\b`, 'i'), hint: 'contextual' },
    { pattern: /\brequirements?\s+for\s+\w+/i, hint: 'building_type' },
    { pattern: new RegExp(`\\b(${TOPIC_KEYWORDS.join('|')})\\s+(requirements?|rules?|regulations?|standards?|code|provisions?)\\s+(for|in)\\s+`, 'i'), hint: 'contextual' },
    { pattern: /\b(only|specifically|just)\s+(in|for|about)\s+(the\s+)?(chapter|section)/i, hint: 'scope_limited' },
    { pattern: /\baccording\s+to\s+(chapter|section)\s+\d/i, hint: 'section_reference' },
    { pattern: /\b(all|list|overview|outline)\s+(of\s+)?(the\s+)?(requirements?|rules?|regulations?|provisions?)\s+(for|about|regarding|related)/i, hint: 'overview' },
  ];

  const detectedHints: string[] = [];

  for (const { pattern, hint } of structuralPatterns) {
    if (pattern.test(query)) {
      detectedHints.push(hint);
    }
  }

  const isStructural = detectedHints.length > 0;

  let suggestedPath: 'tree' | 'standard' | 'exact' = 'standard';

  if (isStructural) {
    suggestedPath = 'tree';
  } else if (detectQueryType(query) === 'exact') {
    suggestedPath = 'exact';
  }

  return {
    isStructural,
    structuralHints: detectedHints,
    suggestedPath,
  };
}

/**
 * v1.10.0 Part A — module-level cache for section→regex compilation. A 1k-node
 * document tree was recompiling the same section regex on every call to
 * treeReasoner (which fires per chat query when classifyQueryStructure picks
 * the 'tree' path). Sections are stable identifiers so memoizing across calls
 * is safe. Bounded at 1000 entries with insertion-order eviction so a
 * pathological tree can't grow the cache unbounded.
 */
const sectionRegexCache = new Map<string, RegExp>();
const SECTION_REGEX_CACHE_MAX = 1000;

function getSectionRegex(section: string): RegExp {
  const cached = sectionRegexCache.get(section);
  if (cached) return cached;
  // v1.10.0 Part D re-audit (security Low): escape ALL regex special chars,
  // not just `.`. `node.section` is admin-controlled (sourced from
  // document_trees.tree_data JSONB written during PDF ingestion). A crafted
  // value like `1.(+.*)` would otherwise compile to an ambiguous regex.
  // Node ≥ 16 has linear-time regex engine mitigations so this is more of a
  // correctness fix than a ReDoS gate, but the cost of escaping is nil.
  const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const compiled = new RegExp(`\\b${escaped}\\b`);
  if (sectionRegexCache.size >= SECTION_REGEX_CACHE_MAX) {
    const firstKey = sectionRegexCache.keys().next().value;
    if (firstKey !== undefined) sectionRegexCache.delete(firstKey);
  }
  sectionRegexCache.set(section, compiled);
  return compiled;
}

/**
 * Tree Reasoner - Deterministic scoring algorithm (NO LLM call)
 */
export function treeReasoner(
  query: string,
  tree: TreeNode[]
): TreeReasoningResult {
  if (tree.length === 0) {
    return {
      selectedNodes: [],
      reasoning: 'No document tree available',
      confidence: 0,
      searchScope: 'wide',
    };
  }

  const queryLower = query.toLowerCase();
  const queryTokens = queryLower.split(/\s+/).filter(w => w.length > 2);

  const scored = tree.map(node => {
    const titleLower = node.title.toLowerCase();
    const pathLower = (node.path || '').toLowerCase();
    let score = 0;

    if (node.section) {
      if (getSectionRegex(node.section).test(query)) {
        score += 50;
      }
    }

    for (const token of queryTokens) {
      if (titleLower.includes(token)) score += 10;
      if (pathLower.includes(token)) score += 3;
    }

    for (const topic of TOPIC_KEYWORDS) {
      if (queryLower.includes(topic) && titleLower.includes(topic)) {
        score += 15;
      }
    }

    for (const btype of BUILDING_TYPE_KEYWORDS) {
      if (queryLower.includes(btype) && titleLower.includes(btype)) {
        score += 12;
      }
    }

    if (node.level >= 1) score += 2;
    if (node.level >= 2) score += 1;

    return { node, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const relevant = scored.filter(s => s.score >= 5);

  if (relevant.length === 0) {
    return {
      selectedNodes: [],
      reasoning: 'No matching sections found by keyword scoring',
      confidence: 0,
      searchScope: 'wide',
    };
  }

  const topScore = relevant[0].score;
  const threshold = topScore * 0.4;
  const selected = relevant
    .filter(s => s.score >= threshold)
    .slice(0, 5);

  const confidence = Math.min(100, Math.round((topScore / 50) * 100));

  let searchScope: 'narrow' | 'medium' | 'wide' = 'narrow';
  if (selected.length >= 4) {
    searchScope = 'wide';
  } else if (selected.length >= 2) {
    searchScope = 'medium';
  }

  const reasoning = `Keyword scoring selected ${selected.length} node(s): ${selected.map(s => `"${s.node.title}" (score=${s.score})`).join(', ')}`;

  return {
    selectedNodes: selected.map(s => s.node.id),
    reasoning,
    confidence,
    searchScope,
  };
}

/**
 * Get page ranges for selected tree nodes
 */
export function getPageRangesForNodes(
  selectedNodeIds: string[],
  tree: TreeNode[]
): Array<{ startPage: number; endPage: number; section?: string }> {
  const nodeMap = new Map(tree.map(n => [n.id, n]));
  const ranges: Array<{ startPage: number; endPage: number; section?: string }> = [];

  for (const nodeId of selectedNodeIds) {
    const node = nodeMap.get(nodeId);
    if (node) {
      ranges.push({
        startPage: node.startPage,
        endPage: node.endPage,
        section: node.section,
      });
    }
  }

  if (ranges.length > 1) {
    ranges.sort((a, b) => a.startPage - b.startPage);
    const merged: typeof ranges = [ranges[0]];

    for (let i = 1; i < ranges.length; i++) {
      const last = merged[merged.length - 1];
      const current = ranges[i];

      if (current.startPage <= last.endPage + 1) {
        last.endPage = Math.max(last.endPage, current.endPage);
      } else {
        merged.push(current);
      }
    }

    return merged;
  }

  return ranges;
}
