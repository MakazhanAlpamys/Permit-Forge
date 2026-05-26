// ============================================================================
// HTML entity escaping — single source of truth.
// ============================================================================
// SIM-M-11 / v1.9.0 Part D: previously this function was duplicated in
// lib/email.ts and lib/notifications.ts. Both copies were byte-identical, so
// any future change (Unicode safety, attribute-quote variants) had to land in
// two places — easy to forget. Hoisted here; both callers now import.
//
// Used to interpolate user-controlled strings into HTML email bodies. NOT a
// general-purpose sanitiser — this only escapes the 5 characters that have
// markup meaning in HTML text/attribute contexts. Markdown rendering for the
// in-app chat uses ReactMarkdown without rehype-raw, so that path doesn't need
// this helper.

/** Escape the 5 HTML special characters to prevent injection in interpolated email bodies. */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
