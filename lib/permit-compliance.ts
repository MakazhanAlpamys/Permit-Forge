// ============================================================================
// Permit Compliance Check Module
// Uses existing RAG pipeline to check permit data against building codes
// ============================================================================

import { hybridSearch } from '@/lib/rag';
import { getChatModel } from '@/lib/gemini';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { complianceCheckJsonSchema } from '@/lib/validations';
import type {
  BuildingDetails,
  ComplianceRequirements,
  ComplianceCheckResult,
  ComplianceCheckItem,
  ProjectType,
} from '@/types';

// C23H/M22: cap LLM response size before parsing. Real responses are ~2-5KB;
// 64KB leaves room for unusually verbose outputs while shutting down a
// hallucinated megabyte of garbage that could DoS the JSON parser.
const MAX_LLM_JSON_BYTES = 64 * 1024;

// -----------------------------------------------------------------------------
// Query Generation
// -----------------------------------------------------------------------------

// SIM-H-5 / v1.8.0 Part D: query templates are a lookup table rather than a
// conditional chain. Each entry has a `guard` that decides whether the area
// applies to this permit, and a `format` that builds the search query. Adding
// a new compliance area is now a one-row append.
interface ComplianceQueryTemplate {
  guard: (bd: BuildingDetails, cr: ComplianceRequirements) => boolean;
  format: (bd: BuildingDetails, cr: ComplianceRequirements, typeLabel: string) => string;
}

const COMPLIANCE_QUERY_TEMPLATES: ComplianceQueryTemplate[] = [
  {
    guard: (bd) => !!bd.buildingHeight,
    format: (bd, _cr, t) =>
      `building height requirements ${t} ${bd.buildingHeight} meters ${bd.numberOfFloors} floors`,
  },
  {
    guard: (bd, cr) => !!cr.parkingCompliance && bd.numberOfParkingSpaces !== undefined,
    format: (bd, _cr, t) =>
      `parking requirements ${t} ${bd.numberOfUnits} units ${bd.numberOfParkingSpaces} parking spaces`,
  },
  {
    guard: (_bd, cr) => !!cr.fireSafety,
    format: (bd, _cr, t) =>
      `fire safety requirements ${bd.occupancyType || t} building height ${bd.buildingHeight} meters`,
  },
  {
    guard: (_bd, cr) => !!cr.accessibility,
    format: (bd, _cr, t) => `accessibility requirements ${t} ${bd.numberOfFloors} floors`,
  },
  {
    guard: (_bd, cr) => !!cr.structuralSafety,
    format: (bd, _cr, t) =>
      `structural requirements ${bd.constructionType || ''} ${t} ${bd.numberOfFloors} floors`,
  },
  {
    guard: (_bd, cr) => !!cr.mepSystems,
    format: (bd, _cr, t) =>
      `MEP mechanical electrical plumbing requirements ${t} ${bd.totalBuiltUpArea} sqm`,
  },
  {
    guard: (_bd, cr) => !!cr.energyEfficiency,
    format: (_bd, _cr, t) => `energy efficiency requirements ${t} glazing insulation`,
  },
  {
    guard: (bd) => !!bd.plotArea && !!bd.totalBuiltUpArea,
    format: (bd, _cr, t) =>
      `plot coverage floor area ratio ${t} ${bd.plotArea} plot ${bd.totalBuiltUpArea} built area`,
  },
];

function generateComplianceQueries(
  buildingDetails: BuildingDetails,
  complianceReqs: ComplianceRequirements,
  projectType: ProjectType
): string[] {
  const typeLabel = projectType.replace('_', ' ');

  const queries = COMPLIANCE_QUERY_TEMPLATES
    .filter((tmpl) => tmpl.guard(buildingDetails, complianceReqs))
    .map((tmpl) => tmpl.format(buildingDetails, complianceReqs, typeLabel));

  // If no specific requirements applied, fall back to a generic query so the
  // pipeline still has something to search on.
  if (queries.length === 0) {
    return [`${typeLabel} building requirements building code`];
  }

  return queries;
}

// -----------------------------------------------------------------------------
// Main Compliance Check
// -----------------------------------------------------------------------------

export async function checkPermitCompliance(
  buildingDetails: BuildingDetails,
  complianceReqs: ComplianceRequirements,
  projectType: ProjectType,
  signal?: AbortSignal,
): Promise<ComplianceCheckResult> {
  // B3: bail early if the caller already cancelled — saves an embedding call
  // and an LLM round-trip when the user has closed the tab.
  if (signal?.aborted) {
    throw new DOMException('Compliance check aborted', 'AbortError');
  }
  // 1. Generate targeted search queries
  const queries = generateComplianceQueries(buildingDetails, complianceReqs, projectType);

  // 2. Search for each query in parallel
  const searchResults = await Promise.all(
    queries.map(async (query) => {
      try {
        const results = await hybridSearch(query, 5);
        return results;
      } catch (error) {
        console.error(`Compliance search failed for: ${query}`, error);
        return [];
      }
    })
  );

  // 3. Collect unique chunks
  const seenIds = new Set<number>();
  const allChunks: Array<{ content: string; page: number; section?: string }> = [];

  for (const results of searchResults) {
    for (const result of results) {
      if (!seenIds.has(result.id)) {
        seenIds.add(result.id);
        allChunks.push({
          content: result.content,
          page: result.metadata.page || 0,
          section: result.metadata.section,
        });
      }
    }
  }

  // Limit to top 15 chunks to fit in context
  const topChunks = allChunks.slice(0, 15);

  // 4. Build context from chunks
  const contextParts = topChunks.map((chunk, i) => {
    const header = `[REF ${i + 1}] Page ${chunk.page}${chunk.section ? `, Section ${chunk.section}` : ''}`;
    return `${header}\n${chunk.content.slice(0, 800)}`;
  });

  const context = contextParts.join('\n\n---\n\n');

  // 5. Build permit data summary
  const typeLabel = projectType.replace('_', ' ');
  const permitSummary = `
PROJECT TYPE: ${typeLabel}
BUILDING DETAILS:
- Number of Floors: ${buildingDetails.numberOfFloors}
- Building Height: ${buildingDetails.buildingHeight} meters
- Total Built-Up Area: ${buildingDetails.totalBuiltUpArea} sq meters
- Plot Area: ${buildingDetails.plotArea} sq meters
- Number of Units: ${buildingDetails.numberOfUnits}
- Number of Parking Spaces: ${buildingDetails.numberOfParkingSpaces}
- Occupancy Type: ${buildingDetails.occupancyType || 'Not specified'}
- Construction Type: ${buildingDetails.constructionType || 'Not specified'}

COMPLIANCE AREAS REQUESTED:
${complianceReqs.fireSafety ? '- Fire Safety\n' : ''}${complianceReqs.accessibility ? '- Accessibility\n' : ''}${complianceReqs.parkingCompliance ? '- Parking Compliance\n' : ''}${complianceReqs.structuralSafety ? '- Structural Safety\n' : ''}${complianceReqs.mepSystems ? '- MEP Systems\n' : ''}${complianceReqs.energyEfficiency ? '- Energy Efficiency\n' : ''}${complianceReqs.additionalNotes ? `\nAdditional Notes: ${complianceReqs.additionalNotes}` : ''}`.trim();

  // 6. Call Gemini for analysis
  const systemPrompt = `You are a building code compliance analysis engine. You MUST respond with valid JSON only, no markdown, no explanation outside JSON.

Analyze the given building project against the provided code sections and determine compliance status for each area.

RULES:
1. Only use information from the provided code sections (REF chunks)
2. If a code section doesn't contain relevant requirements, mark as "requires_review"
3. Be specific about which requirements are met or violated
4. Reference exact page numbers and sections from the chunks
5. Do NOT make up requirements not found in the chunks

Respond ONLY with this exact JSON structure:
{
  "overallStatus": "compliant" | "non_compliant" | "requires_review",
  "checks": [
    {
      "category": "string (e.g., Fire Safety, Parking, Building Height)",
      "status": "compliant" | "non_compliant" | "requires_review",
      "details": "string explaining the finding",
      "codeReferences": [
        { "page": number, "section": "string", "excerpt": "brief relevant quote" }
      ]
    }
  ],
  "summary": "1-2 sentence overall assessment"
}`;

  const userMessage = `BUILDING PROJECT DATA:
${permitSummary}

RELEVANT BUILDING CODE SECTIONS:
${context || 'No relevant code sections found. Mark all areas as requires_review.'}`;

  try {
    const response = await getChatModel().invoke(
      [
        new SystemMessage(systemPrompt),
        new HumanMessage(userMessage),
      ],
      // LangChain forwards `signal` to the underlying Google GenAI fetch.
      signal ? { signal } : undefined,
    );

    const raw = response.content;
    const responseText = typeof raw === 'string'
      ? raw
      : Array.isArray(raw)
        ? raw.map(c => (typeof c === 'string' ? c : 'text' in c ? c.text : '')).join('')
        : String(raw);

    // C23H/M22: size-cap the raw text before parsing so a hallucinated
    // megabyte doesn't blow up JSON.parse.
    if (responseText.length > MAX_LLM_JSON_BYTES) {
      throw new Error(
        `LLM response too large: ${responseText.length} bytes (cap ${MAX_LLM_JSON_BYTES})`,
      );
    }

    // Extract JSON from response (handle potential markdown wrapping)
    let jsonStr = responseText.trim();
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1];
    }

    // C23H: Zod-validated shape instead of ad-hoc field checks. Any nesting
    // depth / array length / string length anomalies bounce here before
    // they reach the renderer.
    const rawParsed = JSON.parse(jsonStr);
    const zodResult = complianceCheckJsonSchema.safeParse(rawParsed);
    if (!zodResult.success) {
      throw new Error(`LLM JSON failed schema: ${zodResult.error.issues[0]?.message ?? 'invalid'}`);
    }

    return {
      ...zodResult.data,
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    console.error('Compliance check AI analysis failed:', error);

    // Return a fallback result
    const categories = [];
    if (complianceReqs.fireSafety) categories.push('Fire Safety');
    if (complianceReqs.accessibility) categories.push('Accessibility');
    if (complianceReqs.parkingCompliance) categories.push('Parking');
    if (complianceReqs.structuralSafety) categories.push('Structural Safety');
    if (complianceReqs.mepSystems) categories.push('MEP Systems');
    if (complianceReqs.energyEfficiency) categories.push('Energy Efficiency');
    if (categories.length === 0) categories.push('General Compliance');

    const fallbackChecks: ComplianceCheckItem[] = categories.map(cat => ({
      category: cat,
      status: 'requires_review' as const,
      details: 'Automated analysis could not be completed. Manual review required.',
      codeReferences: [],
    }));

    return {
      overallStatus: 'requires_review',
      checks: fallbackChecks,
      summary: 'Automated compliance analysis encountered an error. All areas require manual review.',
      checkedAt: new Date().toISOString(),
    };
  }
}
