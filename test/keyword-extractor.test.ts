// ============================================================================
// E14 — lib/keyword-extractor.ts coverage
// ============================================================================

import { describe, it, expect } from 'vitest';
import { extractKeywords } from '@/lib/keyword-extractor';
import type { PDFPageContent } from '@/types';

function page(text: string, pageNumber = 1): PDFPageContent {
  return { pageNumber, text, textItems: [] };
}

// Helper to build a synthetic document where chosen terms appear N times.
function buildDoc(termCounts: Record<string, number>, filler = 'lorem ipsum'): PDFPageContent[] {
  const parts: string[] = [];
  for (const [term, count] of Object.entries(termCounts)) {
    for (let i = 0; i < count; i++) parts.push(term);
  }
  // Add some filler so frequency penalty doesn't kick in too hard.
  for (let i = 0; i < 50; i++) parts.push(filler);
  return [page(parts.join(' '))];
}

// ----------------------------------------------------------------------------
// extractKeywords
// ----------------------------------------------------------------------------

describe('extractKeywords', () => {
  it('returns empty arrays for empty input', () => {
    const out = extractKeywords([]);
    expect(out.keywords).toEqual([]);
    expect(out.categories).toEqual([]);
  });

  it('returns empty arrays when every token is filtered (only stopwords)', () => {
    const out = extractKeywords([page('the and of to in for the the the of')]);
    expect(out.keywords).toEqual([]);
  });

  it('requires a term to appear at least 3 times to qualify', () => {
    const out = extractKeywords([
      page('concrete concrete concrete reinforcement reinforcement'),
    ]);
    // "concrete" appears 3 times → included.
    // "reinforcement" appears only 2 → excluded by the count<3 filter.
    expect(out.keywords).toContain('concrete');
    expect(out.keywords).not.toContain('reinforcement');
  });

  it('excludes pure numeric tokens', () => {
    const out = extractKeywords([
      page('2023 2023 2023 concrete concrete concrete'),
    ]);
    expect(out.keywords).not.toContain('2023');
    expect(out.keywords).toContain('concrete');
  });

  it('strips stopwords from results', () => {
    const out = extractKeywords([
      page(
        'the the the and and and of of of section section section section appendix appendix appendix',
      ),
    ]);
    expect(out.keywords).not.toContain('the');
    expect(out.keywords).not.toContain('of');
    // "section" and "appendix" are PDF-noise stopwords in the module.
    expect(out.keywords).not.toContain('section');
    expect(out.keywords).not.toContain('appendix');
  });

  it('respects the maxKeywords cap', () => {
    const counts: Record<string, number> = {};
    for (let i = 0; i < 20; i++) counts[`term${i}word`] = 5;
    const out = extractKeywords(buildDoc(counts), 5);
    expect(out.keywords.length).toBe(5);
  });

  it('prefers longer / hyphenated terms in scoring', () => {
    // Both appear 5 times — the longer hyphenated term should outrank the
    // shorter one because of the length + compound bonus.
    const pages = [
      page(
        'short short short short short ' +
          'fire-resistance fire-resistance fire-resistance fire-resistance fire-resistance',
      ),
    ];
    const out = extractKeywords(pages, 5);
    const shortIdx = out.keywords.indexOf('short');
    const longIdx = out.keywords.indexOf('fire-resistance');
    expect(longIdx).toBeGreaterThanOrEqual(0);
    expect(shortIdx).toBeGreaterThanOrEqual(0);
    expect(longIdx).toBeLessThan(shortIdx);
  });

  it('detects "structural" category from triggers', () => {
    const out = extractKeywords(
      buildDoc({
        // need at least two distinct triggers from the "structural" rule
        concrete: 5,
        steel: 5,
        beam: 5,
      }),
    );
    expect(out.categories).toContain('structural');
  });

  it('detects multiple categories when triggers from each match', () => {
    const out = extractKeywords(
      buildDoc({
        // structural triggers
        concrete: 5,
        steel: 5,
        // safety triggers
        emergency: 5,
        sprinkler: 5,
      }),
    );
    expect(out.categories).toEqual(expect.arrayContaining(['structural', 'safety']));
  });

  it('does not detect a category with only a single trigger hit', () => {
    const out = extractKeywords(
      buildDoc({
        // Only one structural trigger ("concrete"); the other word "drainage"
        // is a plumbing trigger so it counts toward plumbing, not structural.
        concrete: 5,
        drainage: 5,
      }),
    );
    expect(out.categories).not.toContain('structural');
  });

  it('penalizes very-high-frequency terms', () => {
    const tokens: string[] = [];
    // make "dominator" 70% of the document
    for (let i = 0; i < 700; i++) tokens.push('dominator');
    for (let i = 0; i < 300; i++) tokens.push('niche-term');
    const out = extractKeywords([page(tokens.join(' '))]);
    // After penalty, niche-term (compound + ~30% freq) should outrank dominator.
    const niche = out.keywords.indexOf('niche-term');
    const dom = out.keywords.indexOf('dominator');
    expect(niche).toBeGreaterThanOrEqual(0);
    expect(dom).toBeGreaterThanOrEqual(0);
    expect(niche).toBeLessThan(dom);
  });

  it('handles multiple pages by concatenating their text', () => {
    const out = extractKeywords([
      page('concrete concrete', 1),
      page('concrete', 2),
      page('steel steel steel beam beam beam', 3),
    ]);
    expect(out.keywords).toContain('concrete');
    expect(out.keywords).toContain('steel');
    expect(out.keywords).toContain('beam');
  });

  it('handles tokens with surrounding punctuation', () => {
    const out = extractKeywords([
      page('--concrete-- concrete; concrete? sprinkler! sprinkler. sprinkler:'),
    ]);
    expect(out.keywords).toContain('concrete');
    expect(out.keywords).toContain('sprinkler');
  });
});
