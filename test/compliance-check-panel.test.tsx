/**
 * @vitest-environment jsdom
 */
// ============================================================================
// ComplianceCheckPanel tests (COV-C-8 / v1.4.0 Part C)
// ============================================================================
// Presentational panel that renders the LLM's compliance verdict on a permit
// detail page. We cover: overall-status badge mapping, per-check expand/collapse,
// code-reference rendering, and the empty-checks short-circuit.

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { ComplianceCheckPanel } from '@/components/permits/compliance-check-panel';
import type { ComplianceCheckResult, ComplianceCheckItem } from '@/types';

function makeCheck(overrides: Partial<ComplianceCheckItem> = {}): ComplianceCheckItem {
  return {
    category: 'Fire Safety',
    status: 'compliant',
    details: 'Sprinklers spec matches Section 5.1.',
    codeReferences: [],
    ...overrides,
  };
}

function makeResult(overrides: Partial<ComplianceCheckResult> = {}): ComplianceCheckResult {
  return {
    overallStatus: 'compliant',
    summary: 'All checks pass.',
    checks: [makeCheck()],
    checkedAt: '2026-05-21T10:00:00Z',
    ...overrides,
  };
}

describe('ComplianceCheckPanel', () => {
  it('renders the overall-status badge label and summary text', () => {
    render(<ComplianceCheckPanel result={makeResult({ overallStatus: 'non_compliant', summary: 'Two violations found.' })} />);
    expect(screen.getByText('Non-Compliant')).toBeInTheDocument();
    expect(screen.getByText('Two violations found.')).toBeInTheDocument();
  });

  it('maps every overall-status enum value to the right badge label', () => {
    const cases: Array<{ status: ComplianceCheckResult['overallStatus']; label: string }> = [
      { status: 'compliant', label: 'Compliant' },
      { status: 'non_compliant', label: 'Non-Compliant' },
      { status: 'requires_review', label: 'Requires Review' },
    ];

    for (const c of cases) {
      const { unmount } = render(<ComplianceCheckPanel result={makeResult({ overallStatus: c.status })} />);
      // The label appears at least once (the top-of-panel overall badge).
      // The check item may add a second occurrence when status matches.
      expect(screen.getAllByText(c.label).length).toBeGreaterThan(0);
      unmount();
    }
  });

  it('renders each check category in the list and starts collapsed', () => {
    const result = makeResult({
      checks: [
        makeCheck({ category: 'Fire Safety', status: 'compliant' }),
        makeCheck({ category: 'Parking', status: 'non_compliant' }),
      ],
    });
    render(<ComplianceCheckPanel result={result} />);

    expect(screen.getByText('Fire Safety')).toBeInTheDocument();
    expect(screen.getByText('Parking')).toBeInTheDocument();
    // Details are hidden until the row is expanded.
    expect(screen.queryByText('Sprinklers spec matches Section 5.1.')).not.toBeInTheDocument();
  });

  it('expands a check row on click and shows the details + code references', () => {
    const result = makeResult({
      checks: [
        makeCheck({
          category: 'Building Height',
          status: 'requires_review',
          details: 'Cannot determine from supplied data.',
          codeReferences: [
            { page: 31, section: '3.1', excerpt: 'Maximum height for residential is 60m.' },
          ],
        }),
      ],
    });
    render(<ComplianceCheckPanel result={result} />);

    // Click the category row to expand.
    fireEvent.click(screen.getByText('Building Height'));

    expect(screen.getByText('Cannot determine from supplied data.')).toBeInTheDocument();
    expect(screen.getByText('Code References:')).toBeInTheDocument();
    expect(screen.getByText('Page 31, Section 3.1')).toBeInTheDocument();
    // Excerpt is rendered as italicised quoted text.
    expect(screen.getByText(/Maximum height for residential is 60m/)).toBeInTheDocument();
  });

  it('omits the "Code References" sub-header when a check has no references', () => {
    render(
      <ComplianceCheckPanel
        result={makeResult({
          checks: [makeCheck({ details: 'OK', codeReferences: [] })],
        })}
      />,
    );
    fireEvent.click(screen.getByText('Fire Safety'));
    expect(screen.queryByText('Code References:')).not.toBeInTheDocument();
  });

  it('collapses an expanded check on a second click', () => {
    render(<ComplianceCheckPanel result={makeResult()} />);
    const row = screen.getByText('Fire Safety');
    fireEvent.click(row);
    expect(screen.getByText('Sprinklers spec matches Section 5.1.')).toBeInTheDocument();
    fireEvent.click(row);
    expect(screen.queryByText('Sprinklers spec matches Section 5.1.')).not.toBeInTheDocument();
  });

  it('renders the "Checked: ..." timestamp in human-readable form', () => {
    render(<ComplianceCheckPanel result={makeResult({ checkedAt: '2026-05-21T10:00:00Z' })} />);
    // toLocaleString output varies by runner locale — assert presence of the prefix only.
    expect(screen.getByText(/Checked:/)).toBeInTheDocument();
  });

  it('renders zero check items gracefully when checks is empty', () => {
    render(<ComplianceCheckPanel result={makeResult({ checks: [] })} />);
    // Summary still renders; no crash; no category rows.
    expect(screen.getByText('All checks pass.')).toBeInTheDocument();
    expect(screen.queryByText('Fire Safety')).not.toBeInTheDocument();
  });
});
