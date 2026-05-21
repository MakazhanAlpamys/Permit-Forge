'use client';

// ============================================================================
// <ConfirmDialog> / <ResultDialog> — shared dialog primitives (F18 / Simplify #18)
// ============================================================================
// Most modals across the admin screens are one of two shapes:
//   1. "are you sure?" with a Cancel + a destructive/primary action button
//   2. "operation finished" with an OK button, optionally tinted success/error
// These two components capture that shape so we stop copy-pasting Dialog +
// DialogHeader + DialogFooter scaffolding into every screen.

import { AlertTriangle, CheckCircle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { ReactNode } from 'react';

// ----------------------------------------------------------------------------
// ConfirmDialog
// ----------------------------------------------------------------------------

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  /** Body content (extra inputs / explanation) rendered between description and footer. */
  body?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** Button variant for the confirm action. Use 'destructive' for delete/block. */
  confirmVariant?: 'default' | 'destructive';
  /** Show a spinner inside the confirm button when true. */
  loading?: boolean;
  /** Disable the confirm button (e.g. while form is invalid). */
  disabled?: boolean;
  /** Lead the title with a red warning icon (for destructive flows). */
  destructive?: boolean;
  onConfirm: () => void;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  body,
  confirmLabel,
  cancelLabel = 'Cancel',
  confirmVariant = 'default',
  loading = false,
  disabled = false,
  destructive = false,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className={destructive ? 'flex items-center gap-2 text-red-500' : undefined}>
            {destructive && <AlertTriangle className="h-5 w-5" />}
            {title}
          </DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        {body && <div className="py-4">{body}</div>}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </Button>
          <Button
            variant={confirmVariant}
            onClick={onConfirm}
            disabled={loading || disabled}
          >
            {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ----------------------------------------------------------------------------
// ResultDialog
// ----------------------------------------------------------------------------

interface ResultDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  variant: 'success' | 'error';
  message?: ReactNode;
  /** Override the default OK label. */
  closeLabel?: string;
}

export function ResultDialog({
  open,
  onOpenChange,
  variant,
  message,
  closeLabel = 'OK',
}: ResultDialogProps) {
  const Icon = variant === 'success' ? CheckCircle : AlertTriangle;
  const iconClass = variant === 'success' ? 'text-violet-500' : 'text-red-500';
  const title = variant === 'success' ? 'Success' : 'Error';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className={`flex items-center gap-2 ${iconClass}`}>
            <Icon className="h-5 w-5" />
            {title}
          </DialogTitle>
          {message && <DialogDescription>{message}</DialogDescription>}
        </DialogHeader>

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>{closeLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
