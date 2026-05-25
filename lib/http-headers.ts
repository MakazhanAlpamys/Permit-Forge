// ============================================================================
// HTTP header helpers
// ============================================================================
// Centralised header builders so each route doesn't roll its own escaping
// logic. Currently exports Content-Disposition for file downloads.

/**
 * S-H-4 / v1.5.0 Part C — RFC 5987-encoded Content-Disposition value for
 * `attachment` downloads.
 *
 * Emits BOTH `filename="..."` (ASCII fallback, sanitised) AND
 * `filename*=UTF-8''...` (RFC 5987 percent-encoded UTF-8). Modern browsers
 * prefer `filename*`; older ones fall back to the quoted ASCII form. Without
 * the encoded form, non-ASCII filenames (Arabic / Cyrillic / accented) either
 * render as mojibake or get silently truncated by the browser at download.
 *
 * The ASCII fallback also strips path-traversal sequences and characters that
 * would break the HTTP quoted-string grammar (`"`, `\`, newlines).
 */
export function contentDispositionAttachment(filename: string): string {
  const safeAscii = sanitiseAsciiFilename(filename);
  const utf8Encoded = encodeURIComponent(filename.trim() || 'download');
  return `attachment; filename="${safeAscii}"; filename*=UTF-8''${utf8Encoded}`;
}

const FILENAME_FALLBACK = 'download';
const MAX_ASCII_FILENAME_LEN = 200;

function sanitiseAsciiFilename(filename: string): string {
  const trimmed = filename.trim();
  if (!trimmed) return FILENAME_FALLBACK;

  // Strip path separators + non-ASCII + control chars + characters that would
  // break the HTTP quoted-string ("/\\/<newline/cr/quote).
  //
  // PSE4 (re-audit): also strip `;` and `=` from the ASCII fallback.
  // RFC 6266 / 7230 allows them inside a quoted string, but a defensive
  // browser parser that drops the quoting could mis-read a filename like
  // `attack ; charset=utf-8` as a new parameter. Cert numbers + chat
  // titles are server-derived today so no current exploit path — this is
  // pure defense-in-depth.
  const ascii = trimmed
    .replace(/[^\x20-\x7E]/g, '_')   // non-printable ASCII / non-ASCII → _
    .replace(/["\\\r\n;=]/g, '_')    // characters illegal/risky in quoted-string
    .replace(/[\/\\]/g, '_')         // path separators
    .replace(/\.{2,}/g, '_')         // collapse .. (parent-dir attempts)
    .trim();

  const capped = ascii.slice(0, MAX_ASCII_FILENAME_LEN);
  return capped || FILENAME_FALLBACK;
}
