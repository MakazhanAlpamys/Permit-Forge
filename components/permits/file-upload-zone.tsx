'use client';

import { useState, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Upload, X, FileText, Image, File } from 'lucide-react';
import { uploadPermitAttachment, deletePermitAttachment } from '@/actions/permit-attachments';
import { formatFileSize } from '@/lib/file-upload';
import { FILE_UPLOAD_LIMITS } from '@/lib/constants';
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
  const inputRef = useRef<HTMLInputElement>(null);

  const handleUpload = useCallback(async (file: File) => {
    setError(null);
    setUploading(true);

    try {
      const formData = new FormData();
      formData.append('file', file);
      const result = await uploadPermitAttachment(permitId, formData);

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

  const handleDelete = async (attachmentId: string) => {
    setDeleting(attachmentId);
    try {
      const result = await deletePermitAttachment(attachmentId);
      if (result.success) {
        onUpdate();
      } else {
        setError(result.error || 'Delete failed');
      }
    } catch {
      setError('Delete failed');
    } finally {
      setDeleting(null);
    }
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleUpload(file);
  }, [handleUpload]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleUpload(file);
    if (inputRef.current) inputRef.current.value = '';
  };

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
          className={`border-2 border-dashed rounded-lg p-6 text-center transition-colors cursor-pointer ${
            dragOver
              ? 'border-primary bg-primary/5'
              : 'border-muted-foreground/25 hover:border-muted-foreground/50'
          }`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => inputRef.current?.click()}
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
                      onClick={() => handleDelete(attachment.id)}
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
    </div>
  );
}
