// ============================================================================
// lib/code-verification — extracted from actions/auth + actions/profile (F2)
// ============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import {
  safeEqual,
  checkCodeAttempts,
  resetCodeAttempts,
  _clearAllCodeAttempts,
} from '@/lib/code-verification';

describe('safeEqual', () => {
  it('returns true for equal strings', () => {
    expect(safeEqual('123456', '123456')).toBe(true);
  });

  it('returns false for unequal strings of the same length', () => {
    expect(safeEqual('123456', '123457')).toBe(false);
  });

  it('returns false for strings of different length (no length oracle)', () => {
    expect(safeEqual('1234', '12345')).toBe(false);
  });

  it('handles empty strings', () => {
    expect(safeEqual('', '')).toBe(true);
    expect(safeEqual('', '1')).toBe(false);
  });
});

describe('checkCodeAttempts / resetCodeAttempts', () => {
  beforeEach(() => {
    _clearAllCodeAttempts();
  });

  it('allows up to 5 attempts before locking', () => {
    const key = 'verify:user-1';
    for (let i = 0; i < 5; i++) {
      expect(checkCodeAttempts(key)).toBe(true);
    }
    expect(checkCodeAttempts(key)).toBe(false);
  });

  it('resets the counter when the key is reset', () => {
    const key = 'verify:user-2';
    for (let i = 0; i < 5; i++) checkCodeAttempts(key);
    expect(checkCodeAttempts(key)).toBe(false);
    resetCodeAttempts(key);
    expect(checkCodeAttempts(key)).toBe(true);
  });

  it('isolates counters between keys', () => {
    const a = 'verify:user-a';
    const b = 'verify:user-b';
    for (let i = 0; i < 5; i++) checkCodeAttempts(a);
    expect(checkCodeAttempts(a)).toBe(false);
    // user-b is unaffected
    expect(checkCodeAttempts(b)).toBe(true);
  });
});
