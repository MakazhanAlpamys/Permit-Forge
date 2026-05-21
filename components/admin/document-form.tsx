'use client';

// ============================================================================
// DocumentForm — Add/Edit document metadata (F20 / Simplify #20)
// ============================================================================
// Pulled out of `document-management.tsx` so the list view stays focused on
// rendering and ingestion controls. Form state is managed via `useReducer`
// to collapse the 9 `setFormData(prev => ({ ...prev, x }))` calls.

import { useEffect, useReducer, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { DOCUMENT_BADGE_COLORS } from '@/lib/constants';
import type { DocumentRecord } from '@/actions/documents';

export interface DocumentFormValues {
  id: string;
  displayName: string;
  shortName: string;
  fileName: string;
  sourceUrl: string;
  authority: string;
  description: string;
  badgeColor: string;
  keywords: string;
  categories: string;
}

const EMPTY_FORM: DocumentFormValues = {
  id: '',
  displayName: '',
  shortName: '',
  fileName: '',
  sourceUrl: '',
  authority: '',
  description: '',
  badgeColor: DOCUMENT_BADGE_COLORS[0]?.value ?? '',
  keywords: '',
  categories: '',
};

type FormAction =
  | { type: 'set'; key: keyof DocumentFormValues; value: string }
  | { type: 'load'; payload: DocumentFormValues }
  | { type: 'reset' };

function formReducer(state: DocumentFormValues, action: FormAction): DocumentFormValues {
  switch (action.type) {
    case 'set':
      return { ...state, [action.key]: action.value };
    case 'load':
      return action.payload;
    case 'reset':
      return EMPTY_FORM;
  }
}

export interface DocumentFormProps {
  /** Document being edited; pass null for "add new" mode. */
  editingDocument: DocumentRecord | null;
  /** Whether the save action is in flight. */
  saving: boolean;
  /** Whether the PDF upload is in flight. */
  uploading: boolean;
  /** Last submit error to display inline. */
  error: string | null;
  onSave: (values: DocumentFormValues, pdfFile: File | null) => void;
  onCancel: () => void;
}

export function DocumentForm({
  editingDocument,
  saving,
  uploading,
  error,
  onSave,
  onCancel,
}: DocumentFormProps) {
  const [formData, dispatch] = useReducer(formReducer, EMPTY_FORM);
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const editingId = editingDocument?.id ?? null;

  // Sync state when the editingDocument prop changes (open form for add vs edit).
  useEffect(() => {
    if (editingDocument) {
      dispatch({
        type: 'load',
        payload: {
          id: editingDocument.id,
          displayName: editingDocument.displayName,
          shortName: editingDocument.shortName,
          fileName: editingDocument.fileName,
          sourceUrl: editingDocument.sourceUrl,
          authority: editingDocument.authority,
          description: editingDocument.description,
          badgeColor: editingDocument.badgeColor,
          keywords: editingDocument.keywords.join(', '),
          categories: editingDocument.categories.join(', '),
        },
      });
    } else {
      dispatch({ type: 'reset' });
    }
    setPdfFile(null);
  }, [editingDocument]);

  const set = (key: keyof DocumentFormValues, value: string) =>
    dispatch({ type: 'set', key, value });

  return (
    <Card className="border-primary/50">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-base">
          <span>{editingId ? 'Edit Document' : 'Register New Document'}</span>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            <X className="h-4 w-4" />
          </Button>
        </CardTitle>
        <CardDescription>
          {editingId
            ? 'Update document metadata. Select a new PDF to replace the existing one.'
            : 'Add a new document and upload its PDF file.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground">Display Name *</label>
            <Input
              value={formData.displayName}
              onChange={(e) => set('displayName', e.target.value)}
              placeholder="Building Code 2021"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Short Name *</label>
            <Input
              value={formData.shortName}
              onChange={(e) => set('shortName', e.target.value)}
              placeholder="DBC"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground">PDF File *</label>
            <input
              type="file"
              accept=".pdf,application/pdf"
              onChange={(e) => {
                const file = e.target.files?.[0] || null;
                setPdfFile(file);
                if (file) {
                  set('fileName', file.name);
                }
              }}
              className="block w-full text-sm text-muted-foreground file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:text-xs file:font-medium file:bg-primary file:text-primary-foreground hover:file:bg-primary/90 file:cursor-pointer cursor-pointer mt-1"
            />
            {editingId && !pdfFile && formData.fileName && (
              <p className="text-[10px] text-muted-foreground mt-1">
                Current: {formData.fileName}
              </p>
            )}
            {pdfFile && (
              <p className="text-[10px] text-muted-foreground mt-1">
                {pdfFile.name} ({(pdfFile.size / 1024 / 1024).toFixed(1)} MB)
              </p>
            )}
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Authority</label>
            <Input
              value={formData.authority}
              onChange={(e) => set('authority', e.target.value)}
              placeholder="e.g., City Authority"
            />
          </div>
        </div>

        {!editingId && (
          <div>
            <label className="text-xs font-medium text-muted-foreground">
              Document ID (auto-generated from name if empty)
            </label>
            <Input
              value={formData.id}
              onChange={(e) => set('id', e.target.value)}
              placeholder="building-code-2021"
            />
          </div>
        )}

        <div>
          <label className="text-xs font-medium text-muted-foreground">Description</label>
          <Input
            value={formData.description}
            onChange={(e) => set('description', e.target.value)}
            placeholder="Brief description of the document"
          />
        </div>

        <div>
          <label className="text-xs font-medium text-muted-foreground">Source URL</label>
          <Input
            value={formData.sourceUrl}
            onChange={(e) => set('sourceUrl', e.target.value)}
            placeholder="https://..."
          />
        </div>

        <div>
          <label className="text-xs font-medium text-muted-foreground">
            Keywords (comma-separated, for search routing)
          </label>
          <Input
            value={formData.keywords}
            onChange={(e) => set('keywords', e.target.value)}
            placeholder="building, code, construction, parking"
          />
        </div>

        <div>
          <label className="text-xs font-medium text-muted-foreground">Categories (comma-separated)</label>
          <Input
            value={formData.categories}
            onChange={(e) => set('categories', e.target.value)}
            placeholder="structural, general"
          />
        </div>

        <div>
          <label className="text-xs font-medium text-muted-foreground">Badge Color</label>
          <div className="flex flex-wrap gap-2 mt-1">
            {DOCUMENT_BADGE_COLORS.map((color) => (
              <button
                key={color.label}
                onClick={() => set('badgeColor', color.value)}
                className={`px-2 py-1 rounded text-xs border transition-all ${color.value} ${
                  formData.badgeColor === color.value
                    ? 'ring-2 ring-primary ring-offset-1 ring-offset-background'
                    : ''
                }`}
              >
                {color.label}
              </button>
            ))}
          </div>
        </div>

        {error && (
          <div className="p-2 rounded bg-red-500/10 border border-red-500/30 text-xs text-red-400">
            {error}
          </div>
        )}

        <div className="flex gap-2 pt-2">
          <Button onClick={() => onSave(formData, pdfFile)} disabled={saving || uploading} size="sm">
            {(saving || uploading) ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
            {uploading ? 'Uploading PDF...' : saving ? 'Saving...' : editingId ? 'Update' : 'Register'}
          </Button>
          <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        </div>
      </CardContent>
    </Card>
  );
}
