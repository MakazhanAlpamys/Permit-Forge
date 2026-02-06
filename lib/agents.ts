// ============================================================================
// AI Agents for Advanced RAG (Query Expansion, Re-ranking, Verification)
// ============================================================================

import { chatModel } from '@/lib/gemini';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { MatchedChunk, VerifiedAnswer, EnhancedCitation } from '@/types';

// -----------------------------------------------------------------------------
// 0. TOPIC CLASSIFIER - Check if query is about Dubai Building Code
// -----------------------------------------------------------------------------

const TOPIC_CLASSIFIER_PROMPT = `You are a query classifier for a Dubai Building Code 2021 assistant.

Determine if the user's message is related to:
- Building codes, construction, architecture
- Parking requirements, fire safety, structural requirements
- Building permits, regulations, compliance
- Dubai/UAE construction standards
- Greetings or questions about what you can help with

OUTPUT FORMAT: Return ONLY one word:
- "ON_TOPIC" if the query is about building codes, construction, or asking what you can help with
- "OFF_TOPIC" if it's completely unrelated (cooking, sports, movies, personal questions, etc.)

Examples:
- "What are parking requirements?" → ON_TOPIC
- "Hello" → ON_TOPIC
- "What can you help with?" → ON_TOPIC
- "How to make pasta?" → OFF_TOPIC
- "Who won the world cup?" → OFF_TOPIC

USER MESSAGE: `;

export interface TopicClassification {
  isOnTopic: boolean;
  shouldUseRAG: boolean;
}

/**
 * Quickly classify if the query is related to Dubai Building Code
 * This saves API calls by skipping RAG for off-topic queries
 */
export async function classifyTopic(userQuery: string): Promise<TopicClassification> {
  // Quick patterns that are obviously on-topic (skip LLM call)
  const onTopicPatterns = [
    /parking/i, /fire\s*safety/i, /building/i, /floor/i, /height/i,
    /setback/i, /structure/i, /foundation/i, /permit/i, /code/i,
    /section\s*\d/i, /chapter\s*\d/i, /requirement/i, /regulation/i,
    /dubai/i, /compliance/i, /construct/i, /architect/i, /MEP/i,
    /elevator/i, /stair/i, /exit/i, /egress/i, /ventilation/i,
    /plumbing/i, /electrical/i, /load/i, /concrete/i, /steel/i,
  ];

  // Check if obviously on-topic
  for (const pattern of onTopicPatterns) {
    if (pattern.test(userQuery)) {
      return { isOnTopic: true, shouldUseRAG: true };
    }
  }

  // Greetings - on-topic but don't use RAG
  const greetingPatterns = [
    /^(hi|hello|hey|greetings|good\s*(morning|afternoon|evening))[\s!?.]*$/i,
    /^(what can you|how can you|what do you|can you help)/i,
    /^(help|помоги|привет|здравствуй)/i,
  ];

  for (const pattern of greetingPatterns) {
    if (pattern.test(userQuery.trim())) {
      return { isOnTopic: true, shouldUseRAG: false };
    }
  }

  // Use LLM for ambiguous cases
  try {
    const response = await chatModel.invoke([
      new HumanMessage(TOPIC_CLASSIFIER_PROMPT + userQuery),
    ]);

    const content = (response.content as string).trim().toUpperCase();
    const isOnTopic = content.includes('ON_TOPIC');
    
    return { isOnTopic, shouldUseRAG: isOnTopic };
  } catch (error) {
    console.error('Topic classification error:', error);
    // Default to on-topic to avoid blocking legitimate queries
    return { isOnTopic: true, shouldUseRAG: true };
  }
}

// -----------------------------------------------------------------------------
// 1. QUERY EXPANSION - Generate multiple search variations
// -----------------------------------------------------------------------------

const QUERY_EXPANSION_PROMPT = `You are a query expansion expert for the Dubai Building Code 2021 document search system.

Your task is to take a user's question and generate 3-5 alternative search queries that would help find relevant information in the building code.

RULES:
1. Keep queries focused on Dubai Building Code topics (construction, safety, regulations)
2. Include synonyms and related technical terms
3. Consider different ways the same concept might be expressed in official documents
4. Include specific regulatory terms that might appear in the code
5. If the query mentions specific sections/numbers, keep them in variations

OUTPUT FORMAT:
Return ONLY a JSON array of strings, no explanations.
Example: ["query 1", "query 2", "query 3"]

USER QUERY: `;

/**
 * Expand a user query into multiple search variations
 * This helps catch relevant chunks that might use different terminology
 */
export async function expandQuery(userQuery: string): Promise<string[]> {
  try {
    const response = await chatModel.invoke([
      new SystemMessage(QUERY_EXPANSION_PROMPT),
      new HumanMessage(userQuery),
    ]);

    const content = response.content as string;

    // Parse JSON array from response
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const queries = JSON.parse(jsonMatch[0]) as string[];
      // Always include original query first
      return [userQuery, ...queries.filter(q => q !== userQuery)].slice(0, 5);
    }

    // Fallback: return original query
    return [userQuery];
  } catch (error) {
    console.error('Query expansion error:', error);
    return [userQuery];
  }
}

// -----------------------------------------------------------------------------
// 2. RE-RANKING - Score chunks for relevance to specific question
// -----------------------------------------------------------------------------

const RERANK_PROMPT = `You are a relevance scoring expert for the Dubai Building Code 2021.

Your task is to score how relevant each text chunk is to answering the user's question.

SCORING RULES:
- Score 0-100 where 100 = perfectly answers the question
- Score 90-100: Contains EXACT answer with specific numbers/requirements
- Score 70-89: Contains relevant information that helps answer
- Score 40-69: Tangentially related but not directly answering
- Score 0-39: Not relevant to the question

OUTPUT FORMAT:
Return ONLY a JSON array of objects with "id" and "score" fields.
Example: [{"id": 1, "score": 95}, {"id": 2, "score": 45}]

USER QUESTION: {question}

CHUNKS TO SCORE:
{chunks}`;

interface RerankResult {
  id: number;
  score: number;
}

/**
 * Re-rank chunks by their relevance to the specific question
 * Uses AI to understand semantic relevance beyond simple similarity
 */
export async function rerankChunks(
  question: string,
  chunks: MatchedChunk[],
  topK: number = 7
): Promise<MatchedChunk[]> {
  if (chunks.length === 0) return [];
  if (chunks.length <= topK) return chunks;

  try {
    // Format chunks for the prompt
    const chunksText = chunks.map((chunk, idx) =>
      `[CHUNK ${idx + 1}] (Page ${chunk.metadata.page}, Section: ${chunk.metadata.section || 'N/A'}):\n${chunk.content.slice(0, 500)}...`
    ).join('\n\n');

    const prompt = RERANK_PROMPT
      .replace('{question}', question)
      .replace('{chunks}', chunksText);

    const response = await chatModel.invoke([
      new HumanMessage(prompt),
    ]);

    const content = response.content as string;

    // Parse JSON array from response
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const scores = JSON.parse(jsonMatch[0]) as RerankResult[];

      // Map scores back to chunks and sort by score
      const scoredChunks = chunks.map((chunk, idx) => {
        const scoreObj = scores.find(s => s.id === idx + 1);
        return {
          ...chunk,
          rerankScore: scoreObj?.score || 50,
        };
      });

      // Sort by rerank score and take top K
      scoredChunks.sort((a, b) => b.rerankScore - a.rerankScore);

      // Filter out low relevance chunks (below 40)
      const relevantChunks = scoredChunks.filter(c => c.rerankScore >= 40);

      return relevantChunks.slice(0, topK);
    }

    // Fallback: return original order
    return chunks.slice(0, topK);
  } catch (error) {
    console.error('Reranking error:', error);
    return chunks.slice(0, topK);
  }
}

// -----------------------------------------------------------------------------
// 3. ANSWER VERIFICATION - Self-check for hallucinations
// -----------------------------------------------------------------------------

const VERIFY_PROMPT = `You are a fact-checking expert for the Dubai Building Code 2021.

Your task is to verify if an AI-generated answer is FULLY supported by the provided source chunks.

VERIFICATION RULES:
1. Every specific number, measurement, or requirement in the answer MUST appear in the chunks
2. If the answer contains information NOT in the chunks, mark as NOT VERIFIED
3. If the answer correctly states "I don't have this information", mark as VERIFIED
4. Extract exact quotes that support the answer

OUTPUT FORMAT (JSON only):
{
  "isVerified": true/false,
  "confidence": 0-100,
  "supportingQuotes": ["exact quote 1 from chunks", "exact quote 2"],
  "unsupportedClaims": ["any claim not found in chunks"],
  "suggestedCorrection": "corrected answer if needed, or null"
}

ANSWER TO VERIFY:
{answer}

SOURCE CHUNKS:
{chunks}`;

interface VerificationResult {
  isVerified: boolean;
  confidence: number;
  supportingQuotes: string[];
  unsupportedClaims: string[];
  suggestedCorrection: string | null;
}

/**
 * Verify that an answer is fully supported by the source chunks
 * Returns verification status with supporting quotes
 */
export async function verifyAnswer(
  answer: string,
  chunks: MatchedChunk[],
  originalQuestion: string
): Promise<VerifiedAnswer> {
  try {
    // Format chunks for verification
    const chunksText = chunks.map((chunk, idx) =>
      `[SOURCE ${idx + 1}] Page ${chunk.metadata.page}, Section: ${chunk.metadata.section || 'N/A'}:\n"${chunk.content}"`
    ).join('\n\n');

    const prompt = VERIFY_PROMPT
      .replace('{answer}', answer)
      .replace('{chunks}', chunksText);

    const response = await chatModel.invoke([
      new HumanMessage(prompt),
    ]);

    const content = response.content as string;

    // Parse JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]) as VerificationResult;

      // Build enhanced citations with exact quotes
      const citations: EnhancedCitation[] = chunks.slice(0, 5).map((chunk) => ({
        chunkId: chunk.id,
        page: chunk.metadata.page || 0,
        section: chunk.metadata.section,
        chapter: chunk.metadata.chapter,
        exactQuote: extractRelevantQuote(chunk.content, originalQuestion),
        context: chunk.content.slice(0, 300),
        similarity: chunk.similarity,
        confidence: result.confidence,
      }));

      return {
        answer: result.isVerified ? answer : (result.suggestedCorrection || answer),
        isVerified: result.isVerified,
        confidence: result.confidence,
        supportingQuotes: result.supportingQuotes,
        unsupportedClaims: result.unsupportedClaims,
        citations,
      };
    }

    // Fallback: return original answer as unverified
    return {
      answer,
      isVerified: false,
      confidence: 50,
      supportingQuotes: [],
      unsupportedClaims: [],
      citations: chunks.slice(0, 5).map(chunk => ({
        chunkId: chunk.id,
        page: chunk.metadata.page || 0,
        section: chunk.metadata.section,
        exactQuote: chunk.content.slice(0, 200),
        context: chunk.content.slice(0, 300),
        similarity: chunk.similarity,
        confidence: 50,
      })),
    };
  } catch (error) {
    console.error('Verification error:', error);
    return {
      answer,
      isVerified: false,
      confidence: 0,
      supportingQuotes: [],
      unsupportedClaims: ['Verification failed'],
      citations: [],
    };
  }
}

// -----------------------------------------------------------------------------
// 4. QUOTE EXTRACTION - Find the most relevant quote from a chunk
// -----------------------------------------------------------------------------

/**
 * Extract the most relevant quote from chunk content based on the question
 */
function extractRelevantQuote(content: string, question: string): string {
  // Split into sentences
  const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 20);

  if (sentences.length === 0) {
    return content.slice(0, 200);
  }

  // Extract key terms from question
  const questionWords = question.toLowerCase().split(/\s+/)
    .filter(w => w.length > 3);

  // Score sentences by keyword overlap
  const scored = sentences.map(sentence => {
    const sentLower = sentence.toLowerCase();
    const matchCount = questionWords.filter(w => sentLower.includes(w)).length;
    return { sentence: sentence.trim(), score: matchCount };
  });

  // Sort by score and take best match
  scored.sort((a, b) => b.score - a.score);

  const bestSentence = scored[0]?.sentence || sentences[0];

  // Return up to 2 sentences for context
  const bestIdx = sentences.findIndex(s => s.trim() === bestSentence);
  const contextSentences = sentences.slice(bestIdx, bestIdx + 2);

  return contextSentences.join('. ').trim() + '.';
}

// -----------------------------------------------------------------------------
// 5. DETECT QUERY TYPE - Determine if query needs exact or semantic search
// -----------------------------------------------------------------------------

export type QueryType = 'exact' | 'semantic' | 'hybrid';

/**
 * Detect if the query requires exact match (section numbers, specific terms)
 * or semantic search (conceptual questions)
 */
export function detectQueryType(query: string): QueryType {
  // Patterns that indicate exact search needed
  const exactPatterns = [
    /section\s+[\d.]+/i,
    /table\s+[\d-]+/i,
    /chapter\s+\d+/i,
    /article\s+\d+/i,
    /clause\s+[\d.]+/i,
    /requirement\s+[\d.]+/i,
    /page\s+\d+/i,
    /\b\d+\.\d+\.\d+\b/, // Section numbers like 4.2.1
  ];

  for (const pattern of exactPatterns) {
    if (pattern.test(query)) {
      return 'exact';
    }
  }

  // Short queries likely need semantic + keyword
  if (query.split(/\s+/).length <= 3) {
    return 'hybrid';
  }

  return 'hybrid'; // Default to hybrid for best coverage
}

// -----------------------------------------------------------------------------
// 6. TREE REASONING - Structure-Aware Search
// -----------------------------------------------------------------------------

import type { TreeNode, TreeReasoningResult, QueryClassification } from '@/types';

// Topic keywords used for tree-matching and structural detection
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
    // Direct section/chapter references
    { pattern: /\b(in|from|within)\s+(chapter|section|part)\s+\d/i, hint: 'section_reference' },
    { pattern: /\bsummarize\s+(chapter|section|the\s+\w+\s+section)/i, hint: 'summarize_section' },
    { pattern: /\b(chapter|section)\s+\d+\s+(content|requirements|says|states)/i, hint: 'section_content' },
    { pattern: /\bwhat('s| is| are)\s+(in|under)\s+(chapter|section|the)/i, hint: 'whats_in_section' },
    
    // Comparative queries
    { pattern: /\bcompare\s+.+\s+(and|with|to|vs)/i, hint: 'comparison' },
    { pattern: /\bdifference\s+between\s+.+\s+and/i, hint: 'comparison' },
    { pattern: /\bhow\s+(does|do)\s+.+\s+differ/i, hint: 'comparison' },
    
    // Contextual queries (topic + building type, broader matching)
    { pattern: /\b(residential|commercial|industrial|high-rise|low-rise|mixed-use|hotel|hospital|school|warehouse|office|retail|assembly|villa|apartment)\s+.*(requirement|section|building|code|standard|regulation|rule|compliance)/i, hint: 'contextual' },
    // Topic + "for/in" + building type (both directions)
    { pattern: new RegExp(`\\b(${TOPIC_KEYWORDS.join('|')})\\b.*\\b(for|in)\\s+(${BUILDING_TYPE_KEYWORDS.join('|')})\\b`, 'i'), hint: 'contextual' },
    { pattern: new RegExp(`\\b(${BUILDING_TYPE_KEYWORDS.join('|')})\\b.*\\b(${TOPIC_KEYWORDS.join('|')})\\b`, 'i'), hint: 'contextual' },
    // "requirements for X buildings" - broader
    { pattern: /\brequirements?\s+for\s+\w+/i, hint: 'building_type' },
    // Topic + "for" + any noun (e.g. "fire safety for high-rise")
    { pattern: new RegExp(`\\b(${TOPIC_KEYWORDS.join('|')})\\s+(requirements?|rules?|regulations?|standards?|code|provisions?)\\s+(for|in)\\s+`, 'i'), hint: 'contextual' },
    
    // Scope-limited queries
    { pattern: /\b(only|specifically|just)\s+(in|for|about)\s+(the\s+)?(chapter|section)/i, hint: 'scope_limited' },
    { pattern: /\baccording\s+to\s+(chapter|section)\s+\d/i, hint: 'section_reference' },

    // "all/list/overview" of a topic (implies structural scan)
    { pattern: /\b(all|list|overview|outline)\s+(of\s+)?(the\s+)?(requirements?|rules?|regulations?|provisions?)\s+(for|about|regarding|related)/i, hint: 'overview' },
  ];

  const detectedHints: string[] = [];
  
  for (const { pattern, hint } of structuralPatterns) {
    if (pattern.test(query)) {
      detectedHints.push(hint);
    }
  }

  const isStructural = detectedHints.length > 0;
  
  // Determine suggested path
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
 * Tree Reasoner - Deterministic scoring algorithm (NO LLM call)
 * Selects relevant tree nodes based on keyword overlap with the query.
 * This replaces the previous LLM-based approach to reduce latency and API costs.
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
  // Extract meaningful words (length > 2 to skip "a", "is", "of", etc.)
  const queryTokens = queryLower.split(/\s+/).filter(w => w.length > 2);

  // Score every node
  const scored = tree.map(node => {
    const titleLower = node.title.toLowerCase();
    const pathLower = (node.path || '').toLowerCase();
    let score = 0;

    // 1. Exact section number match (e.g. query mentions "3.2" and node.section is "3.2")
    if (node.section) {
      const sectionPattern = new RegExp(`\\b${node.section.replace(/\./g, '\\.')}\\b`);
      if (sectionPattern.test(query)) {
        score += 50;
      }
    }

    // 2. Token overlap with title
    for (const token of queryTokens) {
      if (titleLower.includes(token)) {
        score += 10;
      }
      // Path gives extra context but lower weight
      if (pathLower.includes(token)) {
        score += 3;
      }
    }

    // 3. Topic keyword match in title (specific domain terms are high signal)
    for (const topic of TOPIC_KEYWORDS) {
      if (queryLower.includes(topic) && titleLower.includes(topic)) {
        score += 15;
      }
    }

    // 4. Building type keyword match in title
    for (const btype of BUILDING_TYPE_KEYWORDS) {
      if (queryLower.includes(btype) && titleLower.includes(btype)) {
        score += 12;
      }
    }

    // 5. Prefer narrower (deeper-level) nodes when scores are close
    //    A small bonus ensures leaf nodes win ties over chapters
    if (node.level >= 1) {
      score += 2;
    }
    if (node.level >= 2) {
      score += 1;
    }

    return { node, score };
  });

  // Sort descending and filter out low-score nodes (minimum 5 to avoid noise)
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

  // Select top nodes (max 5), but also include any with score >= 50% of the top score
  const topScore = relevant[0].score;
  const threshold = topScore * 0.4;
  const selected = relevant
    .filter(s => s.score >= threshold)
    .slice(0, 5);

  // Calculate confidence: top score mapped to 0-100
  // A score of 50+ is very confident, 10 is low
  const confidence = Math.min(100, Math.round((topScore / 50) * 100));

  // Determine scope
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
 * Used to filter chunks by page range in search
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

  // Merge overlapping ranges
  if (ranges.length > 1) {
    ranges.sort((a, b) => a.startPage - b.startPage);
    const merged: typeof ranges = [ranges[0]];
    
    for (let i = 1; i < ranges.length; i++) {
      const last = merged[merged.length - 1];
      const current = ranges[i];
      
      if (current.startPage <= last.endPage + 1) {
        // Overlapping or adjacent - merge
        last.endPage = Math.max(last.endPage, current.endPage);
      } else {
        merged.push(current);
      }
    }
    
    return merged;
  }

  return ranges;
}
