// ============================================================================
// lib/html-escape.ts — SIM-M-11 / v1.9.0 Part D
// ============================================================================
// The two duplicated escapeHtml copies in lib/email.ts + lib/notifications.ts
// were folded into a single shared module. Locking in the 5-character contract
// here so a future "minor cleanup" can't quietly drop one of the entities and
// re-introduce an injection surface in a template caller didn't think to
// re-audit.

import { describe, it, expect } from 'vitest';
import { escapeHtml } from '@/lib/html-escape';

describe('escapeHtml', () => {
  it('escapes the 5 HTML special characters', () => {
    expect(escapeHtml('&')).toBe('&amp;');
    expect(escapeHtml('<')).toBe('&lt;');
    expect(escapeHtml('>')).toBe('&gt;');
    expect(escapeHtml('"')).toBe('&quot;');
    expect(escapeHtml("'")).toBe('&#039;');
  });

  it('preserves benign text untouched', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
    expect(escapeHtml('Permit 12345 — APPROVED')).toBe('Permit 12345 — APPROVED');
  });

  it('escapes a crafted XSS payload so <script> renders inert', () => {
    const payload = '<script>alert("xss")</script>';
    const escaped = escapeHtml(payload);
    expect(escaped).not.toMatch(/<script/);
    expect(escaped).toContain('&lt;script&gt;');
    expect(escaped).toContain('&quot;xss&quot;');
  });

  it('escapes ampersands first so already-escaped entities are double-encoded (defensive)', () => {
    // & must be escaped first; otherwise &lt; gets re-escaped to &amp;lt;.
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });
});
