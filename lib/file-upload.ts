// ============================================================================
// File Upload Validation & Helpers
// ============================================================================

import { FILE_UPLOAD_LIMITS } from './constants';

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

/**
 * Format file size for display
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const size = bytes / Math.pow(1024, i);
  return `${size.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}
