// ============================================================================
// File magic-byte sniffing (C7H / H10)
// ============================================================================
// Reading the first few bytes of a file and comparing against known
// container signatures defeats the "rename evil.exe → invoice.pdf, set MIME
// to application/pdf" trick — the client fully controls `file.type` and the
// extension, but the actual bytes don't lie.
//
// We sniff conservatively: only assert positive matches for formats we
// actually accept. CAD formats (DWG/DXF) have many vendor variants, so we
// allow them through with a soft check rather than a hard reject, otherwise
// legitimate uploads would silently fail.
// ============================================================================

export type DetectedKind = 'pdf' | 'png' | 'jpeg' | 'dwg' | 'dxf' | 'unknown';

const PDF_SIGNATURE = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"
const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = new Uint8Array([0xff, 0xd8, 0xff]);
const DWG_SIGNATURE = new Uint8Array([0x41, 0x43]); // "AC", followed by 4-digit version

function startsWith(buf: Uint8Array, sig: Uint8Array): boolean {
  if (buf.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (buf[i] !== sig[i]) return false;
  }
  return true;
}

/**
 * Inspect the first ~16 bytes of a file and return the format we detected.
 * Returns 'unknown' for anything we don't explicitly recognize — callers
 * should treat that as "fall back to the extension/MIME check".
 */
export function sniffMagic(buf: Uint8Array): DetectedKind {
  if (buf.length === 0) return 'unknown';

  if (startsWith(buf, PDF_SIGNATURE)) return 'pdf';
  if (startsWith(buf, PNG_SIGNATURE)) return 'png';
  if (startsWith(buf, JPEG_SIGNATURE)) return 'jpeg';

  // DWG: ASCII "AC" followed by 4 ASCII digits (e.g. "AC1018" = 2004).
  if (startsWith(buf, DWG_SIGNATURE) && buf.length >= 6) {
    let allDigits = true;
    for (let i = 2; i < 6; i++) {
      const c = buf[i];
      if (c < 0x30 || c > 0x39) {
        allDigits = false;
        break;
      }
    }
    if (allDigits) return 'dwg';
  }

  // DXF: ASCII text starting with optional whitespace then "0" then a newline
  // then "SECTION". Trim leading whitespace before checking.
  let i = 0;
  while (i < buf.length && (buf[i] === 0x20 || buf[i] === 0x09 || buf[i] === 0x0a || buf[i] === 0x0d)) i++;
  if (i < buf.length && buf[i] === 0x30 /* '0' */) {
    // Look ahead for "SECTION"
    const tail = new TextDecoder('latin1').decode(buf.subarray(i, Math.min(i + 24, buf.length)));
    if (/^0\s+SECTION/.test(tail)) return 'dxf';
  }

  return 'unknown';
}

/**
 * Return true if the bytes match the claimed MIME type, false if they
 * actively disagree. For unrecognized magic we return true (don't block
 * legitimate uploads with unusual formats we don't fingerprint).
 */
export function magicMatchesMime(detected: DetectedKind, mime: string): boolean {
  if (detected === 'unknown') return true;
  switch (detected) {
    case 'pdf':
      return mime === 'application/pdf';
    case 'png':
      return mime === 'image/png';
    case 'jpeg':
      return mime === 'image/jpeg' || mime === 'image/jpg';
    case 'dwg':
      return (
        mime === 'application/acad' ||
        mime === 'application/x-acad' ||
        mime === 'application/x-autocad' ||
        mime === 'application/dwg' ||
        mime === 'image/vnd.dwg' ||
        mime === 'application/octet-stream'
      );
    case 'dxf':
      return (
        mime === 'application/dxf' ||
        mime === 'application/x-dxf' ||
        mime === 'image/vnd.dxf' ||
        mime === 'image/x-dxf' ||
        mime === 'text/plain' ||
        mime === 'application/octet-stream'
      );
  }
}

/**
 * Convenience for the call sites in actions/* that have a File object —
 * reads the first 32 bytes and returns the detected kind.
 */
export async function sniffFileMagic(file: File): Promise<DetectedKind> {
  const sliceSize = Math.min(32, file.size);
  if (sliceSize === 0) return 'unknown';
  const slice = file.slice(0, sliceSize);
  const buf = new Uint8Array(await slice.arrayBuffer());
  return sniffMagic(buf);
}
