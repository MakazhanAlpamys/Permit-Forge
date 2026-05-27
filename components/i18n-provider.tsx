'use client';

// ============================================================================
// I18nProvider — wraps app in I18nextProvider + syncs <html lang> + post-mount
// language detection
// ============================================================================
// React #418 / hydration safety:
//   The i18next bundle is initialized with DEFAULT_LOCALE on BOTH the SSR pass
//   and the very first client render. That guarantees the markup React sees
//   during hydration is identical on both sides.
//
//   We delay the actual user-preferred-locale switch (read from localStorage,
//   or otherwise inferred from navigator.language) until the post-mount
//   useEffect fires. By that point React has finished hydrating and treats
//   the subsequent re-render as a normal state update — no mismatch warning.
// ============================================================================

import { useEffect } from 'react';
import { I18nextProvider, useTranslation } from 'react-i18next';
import i18n from '@/lib/i18n/client';
import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  isSupportedLocale,
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from '@/lib/i18n/config';

function pickInitialLocale(): SupportedLocale {
  if (typeof window === 'undefined') return DEFAULT_LOCALE;

  // 1) Explicit user choice in localStorage wins.
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (stored && isSupportedLocale(stored)) return stored;
  } catch {
    // localStorage may be blocked (privacy mode) — fall through to navigator.
  }

  // 2) navigator.language — match the leading language tag (e.g. "ru-RU" → "ru").
  try {
    const navLang = window.navigator.language.split('-')[0]?.toLowerCase();
    if (navLang && (SUPPORTED_LOCALES as readonly string[]).includes(navLang)) {
      return navLang as SupportedLocale;
    }
  } catch {
    // Some headless / locked-down browsers throw on navigator access; ignore.
  }

  return DEFAULT_LOCALE;
}

function LocaleSync() {
  const { i18n: i18nInstance } = useTranslation();

  // Post-mount language detection — runs once after hydration completes, so
  // the resulting re-render is not observed by React's hydration validator.
  useEffect(() => {
    const target = pickInitialLocale();
    if (target !== i18nInstance.language) {
      void i18nInstance.changeLanguage(target);
    }
    // We deliberately ignore i18nInstance dependency churn — we only want this
    // to fire on initial mount; subsequent locale changes go through LanguageToggle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep <html lang="..."> in sync with the active language.
  useEffect(() => {
    const sync = () => {
      if (typeof document !== 'undefined') {
        document.documentElement.lang =
          i18nInstance.resolvedLanguage || i18nInstance.language || DEFAULT_LOCALE;
      }
    };
    sync();
    i18nInstance.on('languageChanged', sync);
    return () => {
      i18nInstance.off('languageChanged', sync);
    };
  }, [i18nInstance]);

  return null;
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  return (
    <I18nextProvider i18n={i18n}>
      <LocaleSync />
      {children}
    </I18nextProvider>
  );
}
