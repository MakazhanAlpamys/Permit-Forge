'use client';

// ============================================================================
// I18nProvider — wraps app in I18nextProvider + sync <html lang="..">
// ============================================================================

import { useEffect } from 'react';
import { I18nextProvider, useTranslation } from 'react-i18next';
import i18n from '@/lib/i18n/client';

function HtmlLangSync() {
  const { i18n: i18nInstance } = useTranslation();

  useEffect(() => {
    const sync = () => {
      if (typeof document !== 'undefined') {
        document.documentElement.lang = i18nInstance.resolvedLanguage || i18nInstance.language || 'en';
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
      <HtmlLangSync />
      {children}
    </I18nextProvider>
  );
}
