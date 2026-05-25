'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Upload, X, FileText, Image, File } from 'lucide-react';
import { uploadPermitAttachment, deletePermitAttachment } from '@/actions/permit-attachments';
import { getCSRFTokenAction } from '@/actions/auth';
import { formatFileSize } from '@/lib/file-upload';
import { FILE_UPLOAD_LIMITS } from '@/lib/constants';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import type { PermitAttachment } from '@/types';

interface FileUploadZoneProps {
  permitId: string;
  attachments: PermitAttachment[];
  onUpdate: () => void;
  disabled?: boolean;
}

function getFileIcon(fileType: string) {
  if (fileType.startsWith('image/')) return Image;
  if (fileType === 'application/pdf') return FileText;
  return File;
}

export function FileUploadZone({ permitId, attachments, onUpdate, disabled }: FileUploadZoneProps) {
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const csrfTokenRef = useRef<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getCSRFTokenAction().then(token => { csrfTokenRef.current = token; });
  }, []);

  const handleUpload = useCallback(async (file: File) => {
    setError(null);
    setUploading(true);

    try {
      const formData = new FormData();
      formData.append('file', file);
      const result = await uploadPermitAttachment(permitId, formData, csrfTokenRef.current || undefined);

      if (!result.success) {
        setError(result.error || 'Upload failed');
      } else {
        onUpdate();
      }
    } catch {
      setError('Upload failed');
    } finally {
      setUploading(false);
    }
  }, [permitId, onUpdate]);

  // CP-D-4 (v1.2.0): wire delete through a ConfirmDialog instead of firing
  // immediately on click. An attachment is irrecoverable once the storage
  // object is gone — a single mistap shouldn't destroy a 10 MB upload.
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [pendingDeleteName, setPendingDeleteName] = useState<string>('');

  const requestDelete = (attachmentId: string, fileName: string) => {
    setPendingDeleteId(attachmentId);
    setPendingDeleteName(fileName);
  };

  const handleDelete = async () => {
    const attachmentId = pendingDeleteId;
    if (!attachmentId) return;
    setDeleting(attachmentId);
    try {
      const result = await deletePermitAttachment(attachmentId, csrfTokenRef.current || undefined);
      if (result.success) {
        onUpdate();
      } else {
        setError(result.error || 'Delete failed');
      }
    } catch {
      setError('Delete failed');
    } finally {
      setDeleting(null);
      setPendingDeleteId(null);
      setPendingDeleteName('');
    }
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    // X5: ignore drops while a previous upload is still in flight so the user
    // can't queue up overlapping requests. Server already rejects via TOCTOU
    // guard, but client-side gating prevents the inflight-spinner UX confusion.
    if (uploading) return;
    const file = e.dataTransfer.files[0];
    if (file) handleUpload(file);
  }, [handleUpload, uploading]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleUpload(file);
    if (inputRef.current) inputRef.current.value = '';
  };

  // X5: dropzone click triggers the hidden <input>. Gate it on `uploading`
  // so a second click during upload doesn't reopen the picker.
  const handleZoneClick = useCallback(() => {
    if (uploading) return;
    inputRef.current?.click();
  }, [uploading]);

  const accept = FILE_UPLOAD_LIMITS.allowedExtensions.join(',');
  const isMaxed = attachments.length >= FILE_UPLOAD_LIMITS.maxFilesPerPermit;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">
          Attachments ({attachments.length}/{FILE_UPLOAD_LIMITS.maxFilesPerPermit})
        </h3>
      </div>

      {/* Drop Zone */}
      {!disabled && !isMaxed && (
        <div
          className={`border-2 border-dashed rounded-lg p-6 text-center transition-colors ${
            uploading
              ? 'cursor-not-allowed opacity-60 border-muted-foreground/25'
              : dragOver
                ? 'cursor-pointer border-primary bg-primary/5'
                : 'cursor-pointer border-muted-foreground/25 hover:border-muted-foreground/50'
          }`}
          onDragOver={(e) => {
            e.preventDefault();
            if (!uploading) setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={handleZoneClick}
          aria-disabled={uploading || undefined}
        >
          <Upload className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            {uploading ? 'Uploading...' : 'Drag & drop or click to upload'}
          </p>
          <p className="text-xs text-muted-foreground/70 mt-1">
            PDF, PNG, JPG, DWG, DXF (max 10MB)
          </p>
          <input
            ref={inputRef}
            type="file"
            accept={accept}
            onChange={handleFileSelect}
            className="hidden"
            disabled={uploading || disabled}
          />
        </div>
      )}

      {error && (
        <p className="text-sm text-red-400">{error}</p>
      )}

      {/* Attachment List */}
      {attachments.length > 0 && (
        <div className="space-y-2">
          {attachments.map((attachment) => {
            const Icon = getFileIcon(attachment.fileType);
            return (
              <div
                key={attachment.id}
                className="flex items-center gap-3 p-3 rounded-lg bg-muted/50 border border-border"
              >
                <Icon className="h-5 w-5 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{attachment.fileName}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatFileSize(attachment.fileSize)}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {attachment.signedUrl && (
                    <Button
                      variant="ghost"
                      size="sm"
                      asChild
                    >
                      <a
                        href={attachment.signedUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        download={attachment.fileName}
                      >
                        Download
                      </a>
                    </Button>
                  )}
                  {!disabled && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-red-400"
                      onClick={() => requestDelete(attachment.id, attachment.fileName)}
                      disabled={deleting === attachment.id}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* CP-D-4: attachment delete confirmation. */}
      <ConfirmDialog
        open={!!pendingDeleteId}
        onOpenChange={(open) => {
          if (deleting) return;
          if (!open) { setPendingDeleteId(null); setPendingDeleteName(''); }
        }}
        title="Delete attachment"
        description={
          <>
            Delete <strong>{pendingDeleteName}</strong>? This cannot be undone.
          </>
        }
        confirmLabel="Delete"
        confirmVariant="destructive"
        destructive
        loading={!!deleting}
        onConfirm={handleDelete}
      />
    </div>
  );
}
