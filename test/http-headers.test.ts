// ============================================================================
// lib/http-headers.ts — Content-Disposition RFC 5987 encoding (S-H-4 / v1.5.0 Part C)
// ============================================================================

import { describe, it, expect } from 'vitest';
import { contentDispositionAttachment } from '@/lib/http-headers';

describe('contentDispositionAttachment (RFC 5987)', () => {
  it('emits both filename= and filename*= for ASCII-only filenames', () => {
    const h = contentDispositionAttachment('export.md');
    // ASCII fallback for old clients (RFC 2616) + UTF-8 form for modern ones.
    expect(h).toMatch(/^attachment;\s*filename="export\.md"/);
    expect(h).toMatch(/filename\*=UTF-8''export\.md/);
  });

  it('percent-encodes non-ASCII characters in filename*= and replaces them with _ in filename=', () => {
    const h = contentDispositionAttachment('отчёт.pdf');
    // ASCII fallback strips non-ASCII so old browsers don't render mojibake.
    expect(h).toMatch(/filename="[A-Za-z0-9._-]+\.pdf"/);
    // RFC 5987: %XX percent-encoded UTF-8 bytes.
    expect(h).toMatch(/filename\*=UTF-8''/);
    expect(h).toMatch(/%[0-9A-F]{2}/);
    // And the encoded form decodes back to the original UTF-8 name.
    const m = h.match(/filename\*=UTF-8''([^;]+)/)!;
    expect(decodeURIComponent(m[1])).toBe('отчёт.pdf');
  });

  it('escapes characters that break the quoted-string form in filename=', () => {
    // `"` and `\` are not legal inside an HTTP quoted-string without escaping.
    const h = contentDispositionAttachment('weird"name.pdf');
    // The ASCII fallback must NOT contain a raw unescaped " that would close
    // the quoted-string early.
    const m = h.match(/filename="([^"]*)"/)!;
    expect(m[1]).not.toContain('"');
    // And filename*=UTF-8'' percent-encodes the " safely.
    expect(h).toMatch(/filename\*=UTF-8''[^;]*/);
  });

  it('strips path-traversal sequences from the ASCII fallback', () => {
    const h = contentDispositionAttachment('../../etc/passwd');
    // No slashes / backslashes leak into the quoted-string form.
    const m = h.match(/filename="([^"]*)"/)!;
    expect(m[1]).not.toContain('/');
    expect(m[1]).not.toContain('\\');
    expect(m[1]).not.toContain('..');
  });

  it('handles an empty/whitespace input by returning a stable fallback filename', () => {
    const h = contentDispositionAttachment('   ');
    // Some browsers refuse to save a file with an empty filename — the helper
    // should fall back to a non-empty default.
    expect(h).toMatch(/filename="[^"]+"/);
    expect(h).not.toMatch(/filename=""/);
  });

  it('caps long filenames to a reasonable length (sanity guard)', () => {
    const long = 'a'.repeat(500) + '.pdf';
    const h = contentDispositionAttachment(long);
    // The ASCII fallback shouldn't be unbounded. <= 200 chars total filename.
    const m = h.match(/filename="([^"]+)"/)!;
    expect(m[1].length).toBeLessThanOrEqual(200);
  });

  // PSE4 (v1.5.0 re-audit): defense-in-depth — strip semicolons + equals from
  // the ASCII fallback. A defensive browser that drops the quoting could
  // otherwise mis-parse the value as a new Content-Disposition parameter.
  it('strips ; and = from the ASCII fallback (PSE4)', () => {
    const h = contentDispositionAttachment('attack;charset=utf-8.pdf');
    const m = h.match(/filename="([^"]+)"/)!;
    expect(m[1]).not.toContain(';');
    expect(m[1]).not.toContain('=');
    // RFC 5987 form percent-encodes them safely so the originals survive there.
    const m2 = h.match(/filename\*=UTF-8''([^;]+)/)!;
    expect(decodeURIComponent(m2[1])).toBe('attack;charset=utf-8.pdf');
  });
});
