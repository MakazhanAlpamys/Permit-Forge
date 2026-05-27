// ============================================================================
// i18n Config — Supported locales + default
// ============================================================================

export const SUPPORTED_LOCALES = ['en', 'ru', 'kk'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: SupportedLocale = 'en';

export const LOCALE_LABELS: Record<SupportedLocale, string> = {
  en: 'English',
  ru: 'Русский',
  kk: 'Қазақша',
};

export const LOCALE_SHORT: Record<SupportedLocale, string> = {
  en: 'EN',
  ru: 'RU',
  kk: 'KK',
};

export const LOCALE_STORAGE_KEY = 'pf-locale';

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}
