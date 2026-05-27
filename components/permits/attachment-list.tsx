'use client';

import { Button } from '@/components/ui/button';
import { FileText, Image, File, Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatFileSize } from '@/lib/file-upload';
import type { PermitAttachment } from '@/types';

interface AttachmentListProps {
  attachments: PermitAttachment[];
}

function getFileIcon(fileType: string) {
  if (fileType.startsWith('image/')) return Image;
  if (fileType === 'application/pdf') return FileText;
  return File;
}

export function AttachmentList({ attachments }: AttachmentListProps) {
  const { t } = useTranslation();
  if (attachments.length === 0) return null;

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">{t('permits.detail.attachments')} ({attachments.length})</h3>
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
            {attachment.signedUrl && (
              <Button variant="ghost" size="sm" asChild>
                <a
                  href={attachment.signedUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  download={attachment.fileName}
                >
                  <Download className="h-4 w-4 mr-1" />
                  {t('common.download')}
                </a>
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}
