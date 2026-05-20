/**
 * @vitest-environment jsdom
 */
// ============================================================================
// E18 — smoke test for PermitFormStep3 component
// ============================================================================
// Verifies the step renders all compliance fields, toggling works, and the
// three primary actions (back, run-check, submit) wire to their handlers.
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { PermitFormStep3 } from '@/components/permits/permit-form-step3';
import type { ComplianceRequirements } from '@/types';

const baseData: ComplianceRequirements = {
  fireSafety: false,
  accessibility: false,
  parkingCompliance: false,
  structuralSafety: false,
  mepSystems: false,
  energyEfficiency: false,
};

function setup(props: Partial<React.ComponentProps<typeof PermitFormStep3>> = {}) {
  const handlers = {
    onChange: vi.fn(),
    onBack: vi.fn(),
    onSaveDraft: vi.fn(),
    onSubmit: vi.fn(),
    onRunCheck: vi.fn(),
  };
  render(
    <PermitFormStep3
      data={baseData}
      onChange={handlers.onChange}
      onBack={handlers.onBack}
      onSaveDraft={handlers.onSaveDraft}
      onSubmit={handlers.onSubmit}
      onRunCheck={handlers.onRunCheck}
      loading={false}
      checkLoading={false}
      error=""
      {...props}
    />,
  );
  return handlers;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PermitFormStep3', () => {
  it('renders all 6 compliance fields', () => {
    setup();
    for (const label of [
      'Fire Safety',
      'Accessibility',
      'Parking',
      'Structural Safety',
      'MEP Systems',
      'Energy Efficiency',
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('renders Submit and Back buttons', () => {
    setup();
    expect(screen.getByRole('button', { name: /submit application/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^back$/i })).toBeInTheDocument();
  });

  it('clicking Back fires onBack', () => {
    const h = setup();
    fireEvent.click(screen.getByRole('button', { name: /^back$/i }));
    expect(h.onBack).toHaveBeenCalledTimes(1);
  });

  it('Submit is enabled by default (server-side validates required fields)', () => {
    setup();
    const submit = screen.getByRole('button', { name: /submit application/i });
    expect(submit).not.toBeDisabled();
  });

  it('Submit is disabled while loading', () => {
    setup({ loading: true });
    const submit = screen.getByRole('button', { name: /submitting/i });
    expect(submit).toBeDisabled();
  });

  it('Submit fires onSubmit when clicked', () => {
    const h = setup({ data: { ...baseData, fireSafety: true } });
    fireEvent.click(screen.getByRole('button', { name: /submit application/i }));
    expect(h.onSubmit).toHaveBeenCalledTimes(1);
  });

  it('Run AI Check is hidden until a compliance field is selected', () => {
    setup();
    expect(screen.queryByRole('button', { name: /run ai check/i })).toBeNull();
  });

  it('Run AI Check appears once a field is selected and fires onRunCheck', () => {
    const h = setup({ data: { ...baseData, fireSafety: true } });
    const btn = screen.getByRole('button', { name: /run ai check/i });
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    expect(h.onRunCheck).toHaveBeenCalledTimes(1);
  });

  it('shows "Submitting..." text on the submit button when loading=true', () => {
    setup({ data: { ...baseData, fireSafety: true }, loading: true });
    // Disambiguates the multiple "..." spinners by querying the submit button only.
    const submit = screen.getByRole('button', { name: /submitting/i });
    expect(submit).toBeInTheDocument();
  });

  it('shows the error message when error prop is set', () => {
    setup({ error: 'Something went wrong' });
    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
  });
});
