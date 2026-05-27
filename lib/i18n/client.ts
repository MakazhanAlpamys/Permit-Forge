'use client';

// ============================================================================
// i18next Client Initialization
// ============================================================================
// Initializes i18next once with the bundled EN/RU/KK resources. The initial
// language is pinned to DEFAULT_LOCALE on BOTH the server-side render and the
// first client render so React hydration sees identical text on both sides
// (otherwise we'd hit React error #418 — minified hydration mismatch — for
// any user whose localStorage said anything other than EN).
//
// The actual locale switch driven by localStorage / navigator.language happens
// inside <I18nProvider> via a post-mount useEffect (see components/i18n-provider.tsx),
// which fires *after* hydration commits — so the user-visible re-render isn't
// observed by React's hydration validator.
// ============================================================================

import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';

import en from './locales/en.json';
import ru from './locales/ru.json';
import kk from './locales/kk.json';

import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from './config';

if (!i18next.isInitialized) {
  i18next
    .use(initReactI18next)
    .init({
      resources: {
        en: { translation: en },
        ru: { translation: ru },
        kk: { translation: kk },
      },
      lng: DEFAULT_LOCALE,
      fallbackLng: DEFAULT_LOCALE,
      supportedLngs: [...SUPPORTED_LOCALES],
      load: 'languageOnly',
      nonExplicitSupportedLngs: true,
      interpolation: { escapeValue: false },
      react: { useSuspense: false },
    });
}

export default i18next;
