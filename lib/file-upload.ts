// ============================================================================
// File Upload Validation & Helpers
// ============================================================================

import { FILE_UPLOAD_LIMITS } from './constants';

// Map of allowed extensions to their expected MIME types
const ALLOWED_MIME_TYPES: Record<string, string[]> = {
  '.pdf': ['application/pdf'],
  '.png': ['image/png'],
  '.jpg': ['image/jpeg'],
  '.jpeg': ['image/jpeg'],
  '.dwg': ['application/acad', 'application/x-acad', 'application/x-autocad', 'application/dwg', 'image/vnd.dwg'],
  '.dxf': ['application/dxf', 'application/x-dxf', 'image/vnd.dxf', 'image/x-dxf'],
};

/**
 * Validate a file for permit attachment upload
 */
export function validateFile(file: File): { valid: boolean; error?: string } {
  // Check file size
  if (file.size > FILE_UPLOAD_LIMITS.maxFileSize) {
    const maxMB = FILE_UPLOAD_LIMITS.maxFileSize / (1024 * 1024);
    return { valid: false, error: `File size exceeds ${maxMB}MB limit` };
  }

  // Check file size is not zero
  if (file.size === 0) {
    return { valid: false, error: 'File is empty' };
  }

  // Check extension
  const fileName = file.name.toLowerCase();
  const hasValidExtension = FILE_UPLOAD_LIMITS.allowedExtensions.some(
    ext => fileName.endsWith(ext)
  );

  if (!hasValidExtension) {
    return {
      valid: false,
      error: `File type not allowed. Accepted: ${FILE_UPLOAD_LIMITS.allowedExtensions.join(', ')}`,
    };
  }

  // SECURITY: Validate MIME type matches extension to prevent disguised files
  const ext = '.' + fileName.split('.').pop();
  const allowedMimes = ALLOWED_MIME_TYPES[ext];
  if (!file.type) {
    return { valid: false, error: 'File type could not be determined' };
  }
  if (allowedMimes && !allowedMimes.includes(file.type)) {
    return {
      valid: false,
      error: `File MIME type (${file.type}) does not match extension (${ext})`,
    };
  }

  return { valid: true };
}

/**
 * Generate a unique storage path for a permit attachment
 */
export function generateStoragePath(permitId: string, fileName: string): string {
  const timestamp = Date.now();
  // Sanitize filename: remove special chars, keep extension
  const sanitized = fileName
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_{2,}/g, '_');
  return `permits/${permitId}/${timestamp}-${sanitized}`;
}

// H10: server-side magic-byte sniffing. The browser-supplied `file.type` cannot
// be trusted — a malicious user can rename `evil.html` to `evil.pdf` and the MIME
// will look right. Verify the first bytes match the declared extension. DWG/DXF
// are skipped: DWG has many version-specific signatures and DXF is plain ASCII,
// both produce too many false positives to block uploads on.
const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPG_SIGNATURE = [0xff, 0xd8, 0xff];

function bytesMatch(actual: Uint8Array, expected: number[]): boolean {
  if (actual.length < expected.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) return false;
  }
  return true;
}

/**
 * Verify the file's actual content matches its declared extension. Run this
 * AFTER `validateFile` on the server. Returns `{ valid: true }` for extensions
 * we don't sniff (DWG/DXF) so it never wrongly blocks valid uploads.
 */
export async function validateFileMagicBytes(
  file: File
): Promise<{ valid: boolean; error?: string }> {
  const fileName = file.name.toLowerCase();
  const ext = '.' + (fileName.split('.').pop() ?? '');
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());

  if (ext === '.pdf') {
    if (!bytesMatch(head, PDF_SIGNATURE)) {
      return { valid: false, error: 'File contents do not match PDF format' };
    }
  } else if (ext === '.png') {
    if (!bytesMatch(head, PNG_SIGNATURE)) {
      return { valid: false, error: 'File contents do not match PNG format' };
    }
  } else if (ext === '.jpg' || ext === '.jpeg') {
    if (!bytesMatch(head, JPG_SIGNATURE)) {
      return { valid: false, error: 'File contents do not match JPEG format' };
    }
  }
  // .dwg / .dxf / unknown: skip — too many legitimate variants.
  return { valid: true };
}

/**
 * Format file size for display
 */
export function formatFileSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const size = bytes / Math.pow(1024, i);
  return `${size.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}
