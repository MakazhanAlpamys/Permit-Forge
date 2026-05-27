'use client';

// ============================================================================
// Language Toggle — dropdown to switch between EN / RU / KK
// ============================================================================
// Sits next to ThemeToggle. Same `variant` prop shape so it can be used in
// either icon (default) or text (menu) layout.
// ============================================================================

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Languages, Check } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  LOCALE_LABELS,
  LOCALE_SHORT,
  LOCALE_STORAGE_KEY,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  type SupportedLocale,
} from '@/lib/i18n/config';

interface LanguageToggleProps {
  variant?: 'icon' | 'text';
  className?: string;
}

export function LanguageToggle({ variant = 'icon', className }: LanguageToggleProps) {
  const { i18n, t } = useTranslation();
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const current: SupportedLocale = isSupportedLocale(i18n.resolvedLanguage)
    ? i18n.resolvedLanguage
    : isSupportedLocale(i18n.language)
      ? i18n.language
      : 'en';

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    window.addEventListener('keydown', onEsc);
    return () => {
      window.removeEventListener('mousedown', onClick);
      window.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  const change = (locale: SupportedLocale) => {
    void i18n.changeLanguage(locale);
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    } catch {
      // localStorage may be unavailable (SSR / privacy mode) — i18next-browser-languagedetector
      // already handles the same write so this is a best-effort backup.
    }
    setOpen(false);
  };

  return (
    <div ref={wrapperRef} className="relative">
      {variant === 'text' ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setOpen(o => !o)}
          className={className}
          aria-haspopup="listbox"
          aria-expanded={open}
        >
          <Languages className="h-4 w-4 mr-2" />
          {LOCALE_LABELS[current]}
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setOpen(o => !o)}
          className={cn('text-muted-foreground gap-1', className)}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={t('common.toggleLanguage')}
        >
          <Languages className="h-5 w-5" />
          <span className="sr-only">{LOCALE_LABELS[current]}</span>
        </Button>
      )}

      {open && (
        <ul
          role="listbox"
          aria-label={t('common.language')}
          className="absolute right-0 mt-2 min-w-[10rem] rounded-md border border-border bg-popover text-popover-foreground shadow-md z-50 py-1"
        >
          {SUPPORTED_LOCALES.map(locale => {
            const active = locale === current;
            return (
              <li key={locale} role="option" aria-selected={active}>
                <button
                  type="button"
                  onClick={() => change(locale)}
                  className={cn(
                    'flex w-full items-center justify-between gap-2 px-3 py-2 text-sm transition-colors',
                    active
                      ? 'bg-accent text-accent-foreground'
                      : 'hover:bg-accent hover:text-accent-foreground',
                  )}
                >
                  <span className="flex items-center gap-2">
                    <span className="text-xs font-mono text-muted-foreground w-6">
                      {LOCALE_SHORT[locale]}
                    </span>
                    <span>{LOCALE_LABELS[locale]}</span>
                  </span>
                  {active && <Check className="h-4 w-4" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
