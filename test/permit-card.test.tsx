/**
 * @vitest-environment jsdom
 */
// ============================================================================
// PermitCard tests (COV-C-8 / v1.4.0 Part C)
// ============================================================================
// Presentational card on the /permits list. Critical interactions:
// - Click anywhere on the card → onView(id)
// - Click trash icon (draft only) → onDelete(id), without bubbling onView
// - Relative date formatting (Today / Yesterday / Nd ago / locale date)

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { PermitCard } from '@/components/permits/permit-card';
import type { PermitApplication } from '@/types';

function makePermit(overrides: Partial<PermitApplication> = {}): PermitApplication {
  const today = new Date();
  return {
    id: 'p-1',
    userId: 'u-1',
    status: 'draft',
    projectName: 'Marina Tower',
    projectType: 'residential',
    projectAddress: '12 Marina Walk, Dubai',
    plotNumber: undefined,
    projectDescription: undefined,
    buildingDetails: {},
    complianceRequirements: {
      fireSafety: false,
      accessibility: false,
      parkingCompliance: false,
      structuralSafety: false,
      mepSystems: false,
      energyEfficiency: false,
    },
    complianceCheckResult: null,
    reviewedBy: null,
    reviewedAt: null,
    reviewComments: null,
    submittedAt: null,
    revisionCount: 0,
    revisionNotes: null,
    createdAt: today.toISOString(),
    updatedAt: today.toISOString(),
    version: 0,
    ...overrides,
  };
}

describe('PermitCard', () => {
  it('renders project name, status badge text, project type label, and address', () => {
    const p = makePermit({ status: 'submitted' });
    render(<PermitCard permit={p} onView={vi.fn()} />);

    expect(screen.getByText('Marina Tower')).toBeInTheDocument();
    expect(screen.getByText('Submitted')).toBeInTheDocument();
    expect(screen.getByText('Residential')).toBeInTheDocument();
    expect(screen.getByText('12 Marina Walk, Dubai')).toBeInTheDocument();
  });

  it('calls onView with the permit id when the card body is clicked', () => {
    const onView = vi.fn();
    render(<PermitCard permit={makePermit()} onView={onView} />);

    fireEvent.click(screen.getByText('Marina Tower'));
    expect(onView).toHaveBeenCalledWith('p-1');
  });

  it('renders the trash button only when status=draft AND onDelete is provided', () => {
    const onView = vi.fn();
    const onDelete = vi.fn();

    // draft + handler → button shown
    const { rerender } = render(
      <PermitCard permit={makePermit({ status: 'draft' })} onView={onView} onDelete={onDelete} />,
    );
    // The button has no accessible label — we locate it by its lucide icon's parent.
    // It's the only button on the card.
    expect(document.querySelectorAll('button')).toHaveLength(1);

    // draft but NO onDelete → no button
    rerender(<PermitCard permit={makePermit({ status: 'draft' })} onView={onView} />);
    expect(document.querySelectorAll('button')).toHaveLength(0);

    // non-draft + onDelete → no button (delete only allowed on drafts in the UI)
    rerender(
      <PermitCard permit={makePermit({ status: 'submitted' })} onView={onView} onDelete={onDelete} />,
    );
    expect(document.querySelectorAll('button')).toHaveLength(0);
  });

  it('calls onDelete (and NOT onView) when the trash button is clicked', () => {
    const onView = vi.fn();
    const onDelete = vi.fn();
    render(
      <PermitCard permit={makePermit({ status: 'draft' })} onView={onView} onDelete={onDelete} />,
    );

    // stopPropagation guard: clicking the delete button must not also trigger
    // the card's onClick → onView. This is the canonical click-path bug fix
    // captured by the v1.2.0 click-path family.
    fireEvent.click(document.querySelector('button')!);
    expect(onDelete).toHaveBeenCalledWith('p-1');
    expect(onView).not.toHaveBeenCalled();
  });

  it('shows submitted date in the meta line when submittedAt is present', () => {
    const p = makePermit({
      status: 'under_review',
      submittedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    });
    render(<PermitCard permit={p} onView={vi.fn()} />);

    // Meta line concatenates "Updated X · Submitted Y".
    expect(screen.getByText(/Submitted/)).toBeInTheDocument();
    expect(screen.getByText(/3d ago/)).toBeInTheDocument();
  });

  it('formatDate: emits "Today" for same-day updatedAt', () => {
    render(<PermitCard permit={makePermit({ updatedAt: new Date().toISOString() })} onView={vi.fn()} />);
    expect(screen.getByText(/Updated Today/)).toBeInTheDocument();
  });

  it('formatDate: emits "Yesterday" for 24h-old updatedAt', () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    render(<PermitCard permit={makePermit({ updatedAt: yesterday })} onView={vi.fn()} />);
    expect(screen.getByText(/Updated Yesterday/)).toBeInTheDocument();
  });

  it('formatDate: falls back to locale date for entries older than 7d', () => {
    const old = new Date('2024-01-15T00:00:00Z').toISOString();
    render(<PermitCard permit={makePermit({ updatedAt: old })} onView={vi.fn()} />);
    // toLocaleDateString output varies by runner locale; just confirm the
    // year is shown (relative-formatter branch wouldn't include year).
    expect(screen.getByText(/2024/)).toBeInTheDocument();
  });
});
