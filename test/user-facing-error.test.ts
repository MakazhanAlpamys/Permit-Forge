// ============================================================================
// lib/user-facing-error.ts (SECRET-M1/M3 / v1.5.0 Part F)
// ============================================================================

import { describe, it, expect } from 'vitest';
import { userFacingError } from '@/lib/user-facing-error';

describe('userFacingError', () => {
  it('returns the fallback when the underlying error is null / undefined', () => {
    expect(userFacingError(undefined, 'Operation failed')).toBe('Operation failed');
    expect(userFacingError(null, 'Operation failed')).toBe('Operation failed');
  });

  it('forwards (tight) allow-listed domain phrases verbatim', () => {
    expect(userFacingError(new Error('Rate limited, retry after 5s'), 'Something broke'))
      .toBe('Rate limited, retry after 5s');
    expect(userFacingError(new Error('Permission denied for table users'), 'Something broke'))
      .toMatch(/permission denied/i);
    expect(userFacingError(new Error('Permit status has changed'), 'fallback'))
      .toBe('Permit status has changed');
  });

  // PSE3: 'invalid' and 'already exists' were dropped from the allow-list
  // — they matched typical Postgres errors. Caller-controlled messages that
  // need to surface those classes must use the `UF:` sentinel prefix.
  it('forwards UF:-prefixed sentinel messages verbatim (with sentinel stripped)', () => {
    expect(userFacingError(new Error('UF: Invalid permit ID'), 'fallback'))
      .toBe('Invalid permit ID');
    expect(userFacingError(new Error('UF:Permit not found'), 'fallback'))
      .toBe('Permit not found');
  });

  it('drops raw Postgres / driver detail and returns the fallback', () => {
    // Real Supabase error shape — column / constraint names + sometimes raw SQL.
    const pg = new Error(
      'duplicate key value violates unique constraint "permit_applications_pkey"',
    );
    expect(userFacingError(pg, 'Failed to create permit')).toBe('Failed to create permit');

    const trigger = new Error(
      'function get_admin_stats() does not exist (line 12 of plpgsql body)',
    );
    expect(userFacingError(trigger, 'Stats unavailable')).toBe('Stats unavailable');

    // PSE3: 'invalid input syntax for type uuid: "abc"' would have matched
    // the old 'invalid' phrase. Must now fall back.
    const uuidErr = new Error('invalid input syntax for type uuid: "abc"');
    expect(userFacingError(uuidErr, 'Bad ID')).toBe('Bad ID');
  });

  it('truncates allow-listed messages to 200 chars to bound payload size', () => {
    const long = 'Permission denied: ' + 'x'.repeat(500);
    const out = userFacingError(new Error(long), 'fallback');
    expect(out.length).toBeLessThanOrEqual(200);
  });

  it('truncates UF: sentinel messages to 200 chars too', () => {
    const long = 'UF: ' + 'x'.repeat(500);
    const out = userFacingError(new Error(long), 'fallback');
    expect(out.length).toBeLessThanOrEqual(200);
  });

  it('accepts a string error directly', () => {
    expect(userFacingError('UF: Custom error', 'fallback')).toBe('Custom error');
  });

  it('accepts a plain object with a `message` string field (Supabase-style)', () => {
    expect(userFacingError({ message: 'Permit status has changed' }, 'fallback'))
      .toBe('Permit status has changed');
  });

  it('returns the fallback for an object whose `message` is not a string', () => {
    expect(userFacingError({ message: 123 }, 'fallback')).toBe('fallback');
  });

  // Pin behaviour — case-insensitive phrase match. A Postgres error message
  // in different casing (e.g. "PERMISSION DENIED") must still get forwarded.
  it('case-insensitive phrase match for allow-listed terms', () => {
    expect(userFacingError(new Error('PERMISSION DENIED for table users'), 'fallback'))
      .toMatch(/permission denied/i);
  });
});
