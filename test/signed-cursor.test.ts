// ============================================================================
// Tests: lib/signed-cursor (C27H / L2)
// ============================================================================

import { describe, it, expect } from 'vitest';
import { signCursor, verifyCursor } from '@/lib/signed-cursor';

describe('signed cursor', () => {
  it('round-trips a valid signed cursor', () => {
    const token = signCursor('2026-01-15T10:00:00.000Z');
    expect(verifyCursor(token)).toBe('2026-01-15T10:00:00.000Z');
  });

  it('rejects a cursor with a tampered value', () => {
    const token = signCursor('2026-01-15T10:00:00.000Z');
    const [v, sig] = token.split('.');
    // Replace value with something else but keep the original signature
    const tampered = Buffer.from('2099-01-01T00:00:00.000Z').toString('base64')
      .replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_') + '.' + sig;
    expect(verifyCursor(tampered)).toBeNull();
    expect(v).toBeDefined();
  });

  it('rejects a cursor with no signature', () => {
    expect(verifyCursor('2026-01-15T10:00:00.000Z')).toBeNull();
  });

  it('rejects an empty cursor', () => {
    expect(verifyCursor('')).toBeNull();
    expect(verifyCursor(null)).toBeNull();
    expect(verifyCursor(undefined)).toBeNull();
  });

  it('rejects garbage', () => {
    expect(verifyCursor('not-a-cursor')).toBeNull();
    expect(verifyCursor('a.b')).toBeNull();
  });

  it('produces different tokens for different values', () => {
    const a = signCursor('2026-01-15T10:00:00.000Z');
    const b = signCursor('2026-01-16T10:00:00.000Z');
    expect(a).not.toBe(b);
  });
});
