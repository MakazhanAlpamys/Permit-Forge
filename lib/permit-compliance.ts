// ============================================================================
// Permit Compliance Check Module
// Uses existing RAG pipeline to check permit data against building codes
// ============================================================================

import { hybridSearch } from '@/lib/rag';
import { chatModel } from '@/lib/gemini';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import type {
  BuildingDetails,
  ComplianceRequirements,
  ComplianceCheckResult,
  ComplianceCheckItem,
  ProjectType,
} from '@/types';

// M22: schema-validate LLM JSON before trusting it. Unknown statuses/values are
// coerced to `requires_review` rather than thrown so the AI never hard-fails the action.
const complianceStatusSchema = z.enum(['compliant', 'non_compliant', 'requires_review'])
  .catch('requires_review');
// LLMs sometimes emit `codeReferences` as a list of strings instead of structured
// objects. Accept either; coerce strings into the canonical reference shape.
const complianceCheckReferenceSchema = z.union([
  z.object({
    page: z.coerce.number().int().min(0).max(100_000).catch(0),
    section: z.string().max(200).catch(''),
    excerpt: z.string().max(2_000).catch(''),
  }),
  z.string().max(2_000).transform(s => ({ page: 0, section: '', excerpt: s })),
]).catch({ page: 0, section: '', excerpt: '' });
const complianceCheckItemSchema = z.object({
  category: z.string().min(1).max(200),
  status: complianceStatusSchema,
  details: z.string().min(0).max(8_000),
  codeReferences: z.array(complianceCheckReferenceSchema).max(50).optional().default([]),
});
const complianceLLMResponseSchema = z.object({
  overallStatus: complianceStatusSchema,
  checks: z.array(complianceCheckItemSchema).max(50),
  summary: z.string().min(0).max(8_000).default(''),
});

// -----------------------------------------------------------------------------
// Query Generation
// -----------------------------------------------------------------------------

function generateComplianceQueries(
  buildingDetails: BuildingDetails,
  complianceReqs: ComplianceRequirements,
  projectType: ProjectType
): string[] {
  const queries: string[] = [];
  const typeLabel = projectType.replace('_', ' ');

  // Always check building height requirements
  if (buildingDetails.buildingHeight) {
    queries.push(
      `building height requirements ${typeLabel} ${buildingDetails.buildingHeight} meters ${buildingDetails.numberOfFloors} floors`
    );
  }

  // Parking compliance
  if (complianceReqs.parkingCompliance && buildingDetails.numberOfParkingSpaces !== undefined) {
    queries.push(
      `parking requirements ${typeLabel} ${buildingDetails.numberOfUnits} units ${buildingDetails.numberOfParkingSpaces} parking spaces`
    );
  }

  // Fire safety
  if (complianceReqs.fireSafety) {
    queries.push(
      `fire safety requirements ${buildingDetails.occupancyType || typeLabel} building height ${buildingDetails.buildingHeight} meters`
    );
  }

  // Accessibility
  if (complianceReqs.accessibility) {
    queries.push(
      `accessibility requirements ${typeLabel} ${buildingDetails.numberOfFloors} floors`
    );
  }

  // Structural safety
  if (complianceReqs.structuralSafety) {
    queries.push(
      `structural requirements ${buildingDetails.constructionType || ''} ${typeLabel} ${buildingDetails.numberOfFloors} floors`
    );
  }

  // MEP systems
  if (complianceReqs.mepSystems) {
    queries.push(
      `MEP mechanical electrical plumbing requirements ${typeLabel} ${buildingDetails.totalBuiltUpArea} sqm`
    );
  }

  // Energy efficiency
  if (complianceReqs.energyEfficiency) {
    queries.push(
      `energy efficiency requirements ${typeLabel} glazing insulation`
    );
  }

  // Plot coverage / FAR
  if (buildingDetails.plotArea && buildingDetails.totalBuiltUpArea) {
    queries.push(
      `plot coverage floor area ratio ${typeLabel} ${buildingDetails.plotArea} plot ${buildingDetails.totalBuiltUpArea} built area`
    );
  }

  // If no specific requirements selected, add general query
  if (queries.length === 0) {
    queries.push(`${typeLabel} building requirements building code`);
  }

  return queries;
}

// -----------------------------------------------------------------------------
// Main Compliance Check
// -----------------------------------------------------------------------------

export async function checkPermitCompliance(
  buildingDetails: BuildingDetails,
  complianceReqs: ComplianceRequirements,
  projectType: ProjectType
): Promise<ComplianceCheckResult> {
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
    const response = await chatModel.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(userMessage),
    ]);

    const raw = response.content;
    const responseText = typeof raw === 'string'
      ? raw
      : Array.isArray(raw)
        ? raw.map(c => (typeof c === 'string' ? c : 'text' in c ? c.text : '')).join('')
        : String(raw);

    // M22: cap LLM response size + Zod-validate before trusting structure.
    if (responseText.length > 64_000) {
      throw new Error('Compliance LLM response exceeds size cap');
    }

    let jsonStr = responseText.trim();
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1];
    }

    const rawParsed: unknown = JSON.parse(jsonStr);
    const validated = complianceLLMResponseSchema.safeParse(rawParsed);
    if (!validated.success) {
      throw new Error(`Compliance LLM response failed schema validation: ${validated.error.issues[0]?.message}`);
    }
    const parsed = validated.data;

    return {
      ...parsed,
      checks: parsed.checks.map(c => ({
        ...c,
        codeReferences: c.codeReferences ?? [],
      })),
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
